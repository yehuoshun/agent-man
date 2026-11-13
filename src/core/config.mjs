// 配置的一处真源（design §15）：默认值、白名单、校验、读写都只在这一份文件里。
// 别处一律接一个已经解析好的 cfg——谁再写一遍 1000 或 6h，谁就是第二份真源（§15 第 1 条）。
// 这里也是全仓唯一给自己留了 AGENT_MAN_ 前缀的文件：环境变量映射到配置键的规则只有这一份。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  AFFECT_BIAS_IMP, AFFECT_ENERGY_HALF, AFFECT_MOOD_HALF, AFFECT_RESPECT_HALF,
  AFFECT_TRUST_HALF, CUE_MIN_GAP, DEBT_STALE, DEBT_SUM_IMP, DEBT_UNREFLECTED,
  DEFAULT_WINDOW_DAYS, DIGEST_BUDGET, INJECT_BUDGET, MIN_KEEP_COST, MIN_KEEP_RATIO,
  PART_FAIL_LIMIT, PART_STDOUT_MAX, PART_TIMEOUT, PART_TIMEOUT_MAX, QUIET,
  SOUL_INJECT_COST, SOUL_USER_COST,
} from './const.mjs'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const CONFIG_VERSION = 1
const FILE_NAME = 'config.json'
const PREFIX = 'AGENT_MAN_'
// 数据目录的变量不算配置键：它由 store/paths.mjs 的 home() 认，这里只负责不去覆盖它。
const DATA_HOME_ENV = `${PREFIX}HOME`

// §15.2 里有四个默认值在 §10 常数表里找不到对应常数：日界 04:00、处境 550、回顾 150、
// 首步回顾 250。写成常量而不是散在 SCHEMA 里当字面值，一半是为了"只此一份"，
// 一半是为了标明这四个是缺口——§10 补上常数后，把这四行换成 import 即可。
const DAY_START = '04:00'
const INJECT_SITUATION = 550
const INJECT_RECALL = 150

// §13 的四个注入槽位；injectOrder 决定"装不下时谁先丢"，所以它就是卡的四栏本身。
const SOUL_SLOTS = Object.freeze(['identity', 'soul', 'dialogue', 'lore'])
const DEFAULT_SOUL = 'default'

const SPAN_UNITS = { ms: 1, s: 1000, m: MINUTE, h: HOUR, d: DAY }
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const SPAN_RE = /^(\d+)\s*(ms|s|m|h|d)?$/
const TRUE_TEXT = new Set(['1', 'true', 'yes', 'on'])
const FALSE_TEXT = new Set(['0', 'false', 'no', 'off'])

// 白名单：键名逐字对齐 §15.2，扁平写成 'a.b' 是为了让"未知键"能直接和报错里的名字对上。
// default 一律引用 core/const 的常数（§15.2 第三条），范围也写在这里：校验与读取看同一张表。
export const SCHEMA = {
  'clock.dayStart': { type: 'clock', default: DAY_START },
  'clock.quiet': { type: 'list', of: 'clock', len: 2, default: quietDefault() },

  'inject.total': { type: 'int', min: 200, max: 100000, default: INJECT_BUDGET },
  'inject.soul': { type: 'int', min: 0, max: 100000, default: SOUL_INJECT_COST },
  'inject.user': { type: 'int', min: 0, max: 100000, default: SOUL_USER_COST },
  'inject.situation': { type: 'int', min: 0, max: 100000, default: INJECT_SITUATION },
  'inject.recall': { type: 'int', min: 0, max: 100000, default: INJECT_RECALL },

  'digest.budget': { type: 'int', min: 200, max: 100000, default: DIGEST_BUDGET },
  'digest.dueImp': { type: 'int', min: 0, max: 1000, default: DEBT_SUM_IMP },
  'digest.dueUnreflected': { type: 'int', min: 0, max: 10000, default: DEBT_UNREFLECTED },
  'digest.dueStaleHours': { type: 'int', min: 1, max: 24 * 365, default: DEBT_STALE / HOUR },

  'recall.windowDays': { type: 'int', min: 1, max: 3650, default: DEFAULT_WINDOW_DAYS },
  'recall.minKeepRatio': { type: 'number', min: 0, max: 1, default: MIN_KEEP_RATIO },
  'recall.minKeepCost': { type: 'int', min: 0, max: 10000, default: MIN_KEEP_COST },

  'cue.minGap': { type: 'span', min: 0, max: 30 * DAY, default: CUE_MIN_GAP },
  'cue.respectQuiet': { type: 'bool', default: true },

  'affect.visible': { type: 'bool', default: true },
  // §14.12 只说 0=关，没给范围；取 0..3 与卡旋钮同一量级，别让人一次把账记歪。
  'affect.biasImp': { type: 'number', min: 0, max: 3, default: AFFECT_BIAS_IMP },
  'affect.moodHalf': { type: 'span', min: MINUTE, max: 30 * DAY, default: AFFECT_MOOD_HALF },
  'affect.energyHalf': { type: 'span', min: MINUTE, max: 30 * DAY, default: AFFECT_ENERGY_HALF },
  'affect.trustHalf': { type: 'span', min: HOUR, max: 365 * DAY, default: AFFECT_TRUST_HALF },
  'affect.respectHalf': { type: 'span', min: HOUR, max: 365 * DAY, default: AFFECT_RESPECT_HALF },

  'soul.current': { type: 'string', max: 64, default: DEFAULT_SOUL },
  'soul.injectOrder': { type: 'list', of: 'slot', len: SOUL_SLOTS.length, default: [...SOUL_SLOTS] },

  'parts.timeout': { type: 'int', min: 1, max: 10 * MINUTE, default: PART_TIMEOUT },
  'parts.timeoutMax': { type: 'int', min: 1, max: 10 * MINUTE, default: PART_TIMEOUT_MAX },
  'parts.stdoutMax': { type: 'int', min: 512, max: 65536, default: PART_STDOUT_MAX },
  'parts.failLimit': { type: 'int', min: 1, max: 100, default: PART_FAIL_LIMIT },

  'host.tools': { type: 'bool', default: true },
}

const KEYS = Object.keys(SCHEMA)
const SECTIONS = [...new Set(KEYS.map((key) => key.split('.')[0]))]
const SECTIONS_SET = new Set(SECTIONS)
const INJECT_PARTS = ['soul', 'user', 'situation', 'recall']

// 默认值只有一份：DEFAULTS 由 SCHEMA 的 default 组装，不在这里重写数字（§15.2）。
// version 不在里面：它是文件格式的版本，不是配置值。
export const DEFAULTS = deepFreeze(buildDefaults())

// 值不对就叫它 UsageError，带着退出码 2（design §6：用法或数据错误退 2）。
// 上层想自己决定退出码就 catch 它；run() 已经接住了，不劳 CLI 再包一层。
export class UsageError extends Error {
  constructor(msg, code = 2) {
    super(msg)
    this.name = 'UsageError'
    this.msg = msg
    this.code = code
  }
}

export function flat(cfg) {
  const out = {}
  for (const key of KEYS) out[key] = valueAt(cfg, key) ?? SCHEMA[key].default
  return out
}

// 只报告、不改值、不抛：caller 决定怎么说（load 把 errors 转成退出码 2，warnings 转成 "! "）。
export function validate(cfg) {
  const report = inspect(cfg)
  // 缺键不算错（文件只写想改的那几条是正常写法），所以只在这里提一句；load 不念这一句，
  // 否则每份只改了两三个键的配置都会在每次 show 时被提醒 29 个键用了默认值。
  const missing = KEYS.filter((key) => {
    const [sec, name] = key.split('.')
    const body = cfg && typeof cfg === 'object' ? cfg[sec] : undefined
    return !body || typeof body !== 'object' || !Object.hasOwn(body, name)
  })
  if (missing.length > 0) {
    report.warnings.unshift({ key: '', msg: `缺 ${missing.length} 个键，回落到默认：${brief(missing)}` })
  }
  return { ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings }
}

// 结构化检查：未知键/未知节/类型与范围，外加两条"语法没错但大概率不是想要的"。
function inspect(cfg) {
  const errors = []
  const warnings = []
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    errors.push({ key: '', msg: `配置要是一个对象，拿到 ${shown(cfg)}` })
    return { errors, warnings }
  }

  for (const sec of Object.keys(cfg)) {
    if (sec === 'version') continue
    if (!SECTIONS_SET.has(sec)) {
      errors.push({ key: sec, msg: `未知的配置节：${sec}（只认 ${SECTIONS.join(' / ')}）` })
      continue
    }
    const body = cfg[sec]
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      errors.push({ key: sec, msg: `${sec} 要是一个对象，拿到 ${shown(body)}` })
      continue
    }
    for (const name of Object.keys(body)) {
      const key = joinKey(sec, name)
      if (!Object.hasOwn(SCHEMA, key)) {
        errors.push({ key, msg: `未知的配置键：${key}（拼错的配置比没有配置更坏）` })
        continue
      }
      const bad = checkValue(key, body[name])
      if (bad) errors.push({ key, msg: bad })
    }
  }

  // 论值一律按"合并后的样子"比：缺的键就是默认值，这样只写了 inject.total 的文件也能被
  // 正确地和另外三块的默认值加起来。
  const rows = flat(cfg)
  const slots = INJECT_PARTS.map((name) => rows[`inject.${name}`]).filter(Number.isFinite)
  const sum = slots.reduce((n, one) => n + one, 0)
  if (Number.isFinite(rows['inject.total']) && sum !== rows['inject.total']) {
    warnings.push({ key: 'inject.total', msg: `inject 四块之和 ${sum} 与 total ${rows['inject.total']} 不一致` })
  }
  if (Number.isFinite(rows['parts.timeout']) && Number.isFinite(rows['parts.timeoutMax'])
    && rows['parts.timeout'] > rows['parts.timeoutMax']) {
    const worst = `parts.timeout ${rows['parts.timeout']} 大于 timeoutMax ${rows['parts.timeoutMax']}`
    warnings.push({ key: 'parts.timeout', msg: worst })
  }
  if (cfg.version !== undefined && cfg.version !== CONFIG_VERSION) {
    warnings.push({ key: 'version', msg: `version 是 ${shown(cfg.version)}，本程序写 ${CONFIG_VERSION}` })
  }
  return { errors, warnings }
}

// 文件里的原始值（未合并）。raw 是文件里的对象，bad 表示"读不出来"，两种都不猜：
// 调 load 的人要么拿到全默认，要么拿到退出码 2，绝不拿到"半份"。
export function readConfigFile(homeDir) {
  const found = readRaw(mustDir(homeDir))
  return { exists: found.exists, raw: found.raw, bad: found.bad }
}

// 合并顺序（§15.1）：DEFAULTS ← config.json ← 环境变量。argv 覆盖留给 CLI 层，这里不做。
// now 收下但不参与计算：配置里没有时间戳，它进签名只是为了让 load 与其它命令同一个 ctx 形状。
export function load({ env = {}, homeDir, now, warn = () => {} } = {}) {
  const dir = dirOf(homeDir, env)
  const where = filePath(dir)
  const found = readRaw(dir)

  if (found.bad) {
    throw new UsageError(`${where} ${found.why}：整份配置都不用它，也不会拿一半去跑（改回合法 JSON，或 config reset 清空）`)
  }
  if (found.exists) {
    if (found.raw.version === undefined) warn(`${where} 没写 version：按 ${CONFIG_VERSION} 解释`)
    const report = inspect(found.raw)
    for (const one of report.warnings) warn(`${where}: ${one.msg}`)
    if (report.errors.length > 0) {
      const detail = report.errors.map(msgOf).join('；')
      throw new UsageError(`${where} 有 ${report.errors.length} 处不对：${detail}（别猜着改，按提示改完再看）`)
    }
  }

  const cfg = clone(DEFAULTS)
  if (found.exists) {
    for (const [sec, body] of Object.entries(found.raw)) {
      if (sec === 'version') continue
      for (const [name, value] of Object.entries(body)) cfg[sec][name] = resolve(joinKey(sec, name), value)
    }
  }
  applyEnv(cfg, env, warn)
  return deepFreeze(cfg)
}

// 白名单外 → UsageError；值非法 → UsageError。写回时保留原有其它键、补 version、原子写。
export async function setKey(homeDir, key, rawValue) {
  const dir = mustDir(homeDir)
  const { sec, name, clean } = pick(key)
  const value = coerce(clean, SCHEMA[clean], rawValue)
  const bad = checkValue(clean, value)
  if (bad) throw new UsageError(`${bad}（范围见 agent-man config show --json）`)

  const raw = openForWrite(dir)
  const draft = {}
  for (const one of presentSections(raw)) draft[one] = { ...raw[one] }
  draft[sec] = { ...(draft[sec] || {}), [name]: value }
  await writeTextAtomic(filePath(dir), `${JSON.stringify(assemble(draft), null, 2)}\n`)
  return draft[sec][name]
}

// 省略 key = 全部重置。重置"删掉覆盖"，不是"把默认值写进文件"：
// 文件里留着默认值和没写这一条，对 load 是一回事，但对 `git diff` 和人的认知是两回事。
export async function resetKey(homeDir, key) {
  const dir = mustDir(homeDir)
  const where = filePath(dir)
  const found = readRaw(dir)
  if (found.bad) throw new UsageError(`${where} ${found.why}：先修好它，或删掉这个文件（删掉 = 全默认）`)
  if (!found.exists) return { removed: [], file: where }

  if (key === undefined) {
    await writeTextAtomic(where, `${JSON.stringify({ version: CONFIG_VERSION }, null, 2)}\n`)
    return { removed: KEYS.filter((one) => valueAt(found.raw, one) !== undefined), file: where }
  }

  const { sec, name, clean } = pick(key)
  const removed = valueAt(found.raw, clean) !== undefined ? [clean] : []
  const draft = {}
  for (const one of presentSections(found.raw)) {
    const body = { ...found.raw[one] }
    if (one === sec) delete body[name]
    if (Object.keys(body).length > 0) draft[one] = body
  }
  await writeTextAtomic(where, `${JSON.stringify(assemble(draft), null, 2)}\n`)
  return { removed, file: where }
}

// 命令面（§15.3）：show / get / set / reset / path。stdout 只放结果，stderr 只放 "! " 警告。
// 用户错（未知键、值越界、坏文件）一律变成退出码 2 + 一行 "! "，不抛给 Node 变成一屏栈。
export async function run(ctx = {}, argv) {
  const env = ctx.env || {}
  const out = ctx.out || ((s) => process.stdout.write(s))
  const err = ctx.err || ((s) => process.stderr.write(s))
  const now = ctx.now
  const warn = (msg) => err(`! ${msg}\n`)
  const dir = dirOf(ctx.homeDir, env)

  // registry 的 handler 只递一个 ctx（里面有 argv），这里也认第二种接法：run(ctx, argv)。
  const raw = Array.isArray(argv) ? argv : ctx.argv
  const args = Array.isArray(raw) ? raw.slice() : []
  // registry 两种接法都认：整串 "config show" 递进来，或只递 "show"。
  if (args[0] === 'config') args.shift()
  const sub = args[0]
  const rest = args.slice(1)

  try {
    if (sub === 'path') {
      if (rest.length > 0) throw new UsageError(`config path 不带参数（多出 ${rest.join(' ')}）`)
      out(`${filePath(dir)}\n`)
      return 0
    }

    if (sub === 'show') {
      let json = false
      for (const one of rest) {
        if (one !== '--json') throw new UsageError(`config show 只认 --json（多出 ${one}）`)
        json = true
      }
      const rows = flat(load({ env, homeDir: dir, now, warn }))
      if (json) {
        out(`${JSON.stringify(rows, null, 2)}\n`)
        return 0
      }
      out(renderRows(rows, filePath(dir)))
      return 0
    }

    if (sub === 'get') {
      if (rest.length !== 1) throw new UsageError('用法：agent-man config get <a.b>（例：config get inject.total）')
      const { clean } = pick(rest[0])
      const cfg = load({ env, homeDir: dir, now, warn })
      out(`${textValue(clean, valueAt(cfg, clean))}\n`)
      return 0
    }

    if (sub === 'set') {
      if (rest.length !== 2) throw new UsageError('用法：agent-man config set <a.b> <值>（值里有空格就加引号）')
      const [key, raw] = rest
      await setKey(dir, key, raw)
      // 写完再 load 一遍：写坏的文件要当场知道，而不是等下一次运行才发现。
      const cfg = load({ env, homeDir: dir, now, warn })
      out(`${key.trim()} = ${textValue(key.trim(), valueAt(cfg, key.trim()))}\n`)
      const name = envKey(key.trim())
      if (typeof env[name] === 'string' && env[name].trim() !== '') {
        warn(`${name} 盖着它：环境变量优先级更高，改文件对这次运行没用`)
      }
      return 0
    }

    if (sub === 'reset') {
      if (rest.length > 1) throw new UsageError(`config reset 最多带一个键（多出 ${rest.slice(1).join(' ')}）`)
      const key = rest[0]
      const gone = await resetKey(dir, key)
      if (key === undefined) {
        out(`全部键已回落默认（${gone.file}）\n`)
        return 0
      }
      if (gone.removed.length === 0) warn(`${key} 本来就没被覆盖：它一直是默认值`)
      const cfg = load({ env, homeDir: dir, now, warn })
      out(`${key} = ${textValue(key, valueAt(cfg, key))}\n`)
      return 0
    }

    throw new UsageError(sub === undefined
      ? '用法：agent-man config <show [--json]|get <a.b>|set <a.b> <值>|reset [<a.b>]|path>'
      : `未知的子命令：config ${sub}（只认 show / get / set / reset / path）`)
  } catch (e) {
    if (e instanceof UsageError) {
      warn(e.msg)
      return e.code
    }
    throw e
  }
}

// —— 下面是实现细节 ——

function buildDefaults() {
  const cfg = {}
  for (const key of KEYS) {
    const [sec, name] = key.split('.')
    if (!cfg[sec]) cfg[sec] = {}
    cfg[sec][name] = clone(SCHEMA[key].default)
  }
  return cfg
}

function quietDefault() {
  return [`${pad(QUIET.from)}:00`, `${pad(QUIET.to)}:00`]
}

// 数据目录只有一条规则：AGENT_MAN_HOME，空值当没设，缺省 ~/.agent-man（design §3）。
// 这条规则的正主是 store/paths.mjs 的 home()；core 是最底层，反向 import store 会破 §7 的
// 依赖方向，所以这里按同一口径再写一次——差别由 test/config.test.mjs 的"path 与 store.home
// 同口径"用例钉着，哪天两边分叉，那条用例立刻变红。
function dirOf(homeDir, env) {
  if (typeof homeDir === 'string' && homeDir.trim() !== '') return homeDir
  const override = env ? env[DATA_HOME_ENV] : undefined
  if (typeof override === 'string' && override.trim() !== '') return override
  return path.join(os.homedir(), '.agent-man')
}

function mustDir(homeDir) {
  if (typeof homeDir === 'string' && homeDir !== '') return homeDir
  throw new TypeError('config 需要一个数据目录：homeDir 为空（应由调用方从 AGENT_MAN_HOME 解析）')
}

function filePath(homeDir) {
  return path.join(homeDir, FILE_NAME)
}

function readRaw(homeDir) {
  const file = filePath(homeDir)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, raw: null, bad: false, why: '' }
    throw e
  }
  // 空文件也算坏：JSON.parse('') 会抛，而"文件在、内容没了"是最需要说出口的一种状态。
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { exists: true, raw: null, bad: true, why: '不是合法 JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { exists: true, raw: null, bad: true, why: `顶层要是一个对象（拿到 ${shown(raw)}）` }
  }
  return { exists: true, raw, bad: false, why: '' }
}

// 改之前先确认能读懂：在坏文件上"改一个键"会把另外那些没读懂的键一起冲掉。
function openForWrite(homeDir) {
  const where = filePath(homeDir)
  const found = readRaw(homeDir)
  if (found.bad) throw new UsageError(`${where} ${found.why}：先修好它，或删掉这个文件（删掉 = 全默认）`)
  if (!found.exists) return {}
  const report = inspect(found.raw)
  if (report.errors.length > 0) {
    const detail = report.errors.map(msgOf).join('；')
    throw new UsageError(`${where} 有 ${report.errors.length} 处不对：${detail}（先修好再改）`)
  }
  return found.raw
}

function presentSections(raw) {
  return SECTIONS.filter((sec) => raw[sec] && typeof raw[sec] === 'object')
}

// 写回一律按 SCHEMA 的声明顺序：文件是人改的，顺序稳定了 diff 才有意义。
function assemble(draft) {
  const out = { version: CONFIG_VERSION }
  for (const sec of SECTIONS) {
    if (draft[sec]) out[sec] = orderSection(sec, draft[sec])
  }
  return out
}

function orderSection(sec, body) {
  const out = {}
  for (const key of KEYS) {
    const [one, name] = key.split('.')
    if (one === sec && Object.hasOwn(body, name)) out[name] = body[name]
  }
  return out
}

function applyEnv(cfg, env, warn) {
  const known = new Set([DATA_HOME_ENV])
  for (const key of KEYS) {
    const name = envKey(key)
    known.add(name)
    const text = env ? env[name] : undefined
    // 空值当没设：Windows 上 `set X=` 会留个空串，不能让一次手误静默把预算清零。
    if (typeof text !== 'string' || text.trim() === '') continue
    const value = coerce(key, SCHEMA[key], text)
    const bad = checkValue(key, value)
    if (bad) throw new UsageError(`环境变量 ${name} 的值不对：${bad}（去掉它，或按范围改）`)
    const [sec, kname] = key.split('.')
    cfg[sec][kname] = resolve(key, value)
  }
  for (const name of Object.keys(env || {})) {
    if (!name.startsWith(PREFIX) || known.has(name)) continue
    warn(`环境变量 ${name} 不对应任何配置键，已忽略（真实键见 agent-man config show --json）`)
  }
}

// AGENT_MAN_INJECT_TOTAL → inject.total：前缀 + 段名 + 键名的 UPPER_SNAKE。
// 映射是可逆的（不用第二张表），camelCase 的键也不会漏掉下划线。
function envKey(key) {
  const parts = key.split('.').map((one) => one.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
  return PREFIX + parts.join('_')
}

function resolve(key, value) {
  return SCHEMA[key].type === 'span' ? parseSpan(value) : value
}

// 时长三种写法都收：'8h' / '60d' / 数字 ms。文件里存人写的那个写法（§15.2 的例子就是 '6h'），
// cfg 里一律是 ms 数字——只解释一次，别让每个调用方各自再解析一遍。
function parseSpan(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const hit = SPAN_RE.exec(value.trim())
  if (!hit) return null
  return Number(hit[1]) * SPAN_UNITS[hit[2] || 'ms']
}

function spanText(ms) {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms > 0 && ms % DAY === 0) return `${ms / DAY}d`
  if (ms > 0 && ms % HOUR === 0) return `${ms / HOUR}h`
  if (ms > 0 && ms % MINUTE === 0) return `${ms / MINUTE}m`
  return `${ms}ms`
}

function coerce(key, spec, raw) {
  const text = typeof raw === 'string' ? raw.trim() : null
  if (text === '') return raw // 空值交给 checkValue 报错，别让 Number('') 变成 0
  switch (spec.type) {
    case 'int':
    case 'number':
      if (text === null) return raw
      return Number.isFinite(Number(text)) ? Number(text) : raw
    case 'bool':
      if (typeof raw === 'boolean') return raw
      if (text === null) return raw
      if (TRUE_TEXT.has(text.toLowerCase())) return true
      return FALSE_TEXT.has(text.toLowerCase()) ? false : raw
    case 'span':
      // 存原文：'8h' 留在文件里比 28800000 好读，解析统一在 load 里做一次。
      return text === null ? raw : text
    case 'list':
      if (Array.isArray(raw)) return raw
      if (text === null) return raw
      return text.split(',').map((one) => one.trim()).filter((one) => one !== '')
    default:
      return raw
  }
}

// 校验与读取在同一处（§15.2 第三条）：错在哪、该落在什么范围，一句话说清。
function checkValue(key, value) {
  const spec = SCHEMA[key]
  switch (spec.type) {
    case 'int':
      if (!Number.isInteger(value)) return `${key} 要整数，拿到 ${shown(value)}`
      return inBand(key, value, spec)
    case 'number':
      if (!Number.isFinite(value)) return `${key} 要数字，拿到 ${shown(value)}`
      return inBand(key, value, spec)
    case 'bool':
      return typeof value === 'boolean' ? null : `${key} 只认 true / false，拿到 ${shown(value)}`
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') return `${key} 要非空字符串`
      if (spec.max && value.length > spec.max) return `${key} 最多 ${spec.max} 个字符，拿到 ${value.length} 个`
      return null
    case 'clock':
      return isClock(value) ? null : `${key} 要 HH:MM（00:00..23:59），拿到 ${shown(value)}`
    case 'span': {
      const ms = parseSpan(value)
      if (ms === null) return `${key} 要时长：'8h' / '60d' / 数字 ms 都行，拿到 ${shown(value)}`
      return inBand(key, ms, spec)
    }
    case 'list':
      return checkList(key, spec, value)
    default:
      return `${key} 的类型 ${shown(spec.type)} 不认识（SCHEMA 写错了）`
  }
}

function checkList(key, spec, value) {
  if (!Array.isArray(value)) return `${key} 要数组，拿到 ${shown(value)}`
  if (spec.len !== undefined && value.length !== spec.len) {
    return `${key} 要正好 ${spec.len} 项，拿到 ${value.length} 项`
  }
  for (const one of value) {
    if (spec.of === 'clock' && !isClock(one)) return `${key} 里 ${shown(one)} 不是 HH:MM`
    if (spec.of === 'slot' && !SOUL_SLOTS.includes(one)) {
      return `${key} 只认 ${SOUL_SLOTS.join(' / ')}，拿到 ${shown(one)}`
    }
  }
  if (new Set(value).size !== value.length) return `${key} 里有重复项：${shown(value)}`
  return null
}

function inBand(key, value, spec) {
  if (spec.min !== undefined && value < spec.min) return `${key} 不能小于 ${spec.min}，拿到 ${value}`
  if (spec.max !== undefined && value > spec.max) return `${key} 不能大于 ${spec.max}，拿到 ${value}`
  return null
}

function isClock(value) {
  return typeof value === 'string' && CLOCK_RE.test(value)
}

// 拼错一个字母是配置最常见的坏法，所以未知键顺带给一个"是不是想写这个"。
function pick(key) {
  const clean = typeof key === 'string' ? key.trim() : ''
  if (!Object.hasOwn(SCHEMA, clean)) {
    const near = nearest(clean)
    const what = clean === '' ? '（空）' : clean
    throw new UsageError(`未知的配置键：${what}${near ? `（是不是 ${near}？）` : ''}`
      + '（只收 SCHEMA 白名单里的键，见 agent-man config show --json）')
  }
  const [sec, name] = clean.split('.')
  return { clean, sec, name }
}

function nearest(text) {
  let best = ''
  let gap = 3
  for (const key of KEYS) {
    const here = distance(text.toLowerCase(), key.toLowerCase())
    if (here < gap) {
      gap = here
      best = key
    }
  }
  return best
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (unused, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = next
  }
  return prev[b.length]
}

// 覆盖写走 tmp → fsync → rename（与 store/append.mjs 的 writeAtomic 同一手法）。
// 不 import 它：core 是最底层，反向依赖 store 会让 §7 的依赖方向破口（AGENTS 四）。
// 代价是这段重试逻辑有第二份实现——行为由 test/config.test.mjs（不留 .tmp、写坏能被 load 发现）盯着。
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_DELAY = 15 // ms，起始
const RETRY_DELAY_MAX = 225 // ms，上限
const RETRY_ATTEMPTS = 6

async function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  let wait = RETRY_DELAY
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return file
    } catch (e) {
      const code = e && e.code ? e.code : ''
      if (!RETRY_CODES.has(code) || attempt === RETRY_ATTEMPTS) {
        // 内容留在 tmp 里：失败时最要紧的是别把要写的东西也丢了。
        throw new Error(`原子写失败：${file}（${code || String(e)}），内容在 ${tmp}`)
      }
      await sleep(wait)
      wait = Math.min(wait * 2, RETRY_DELAY_MAX)
    }
  }
  return file
}

function renderRows(rows, file) {
  const keys = Object.keys(rows)
  const width = keys.reduce((n, key) => Math.max(n, key.length), 0)
  const lines = [`${file}\n`]
  let changed = 0
  for (const key of keys) {
    const off = !same(rows[key], SCHEMA[key].default)
    if (off) changed += 1
    lines.push(`${off ? '~' : ' '} ${key.padEnd(width)}  ${textValue(key, rows[key])}\n`)
  }
  // 被覆盖的项打 ~，与默认相同的打空（§15.3）：一眼能看出"我到底改过什么"。
  lines.push(`\n${changed} 项被覆盖（~），其余 ${keys.length - changed} 项与默认一致\n`)
  return lines.join('')
}

function textValue(key, value) {
  const spec = SCHEMA[key]
  if (!spec) return String(value)
  if (spec.type === 'span') return spanText(Number(value))
  if (spec.type === 'list') return JSON.stringify(value)
  return String(value)
}

function valueAt(cfg, key) {
  if (!cfg || typeof cfg !== 'object') return undefined
  const [sec, name] = key.split('.')
  const body = cfg[sec]
  return body && typeof body === 'object' && Object.hasOwn(body, name) ? body[name] : undefined
}

function joinKey(sec, name) {
  return `${sec}.${name}`
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function msgOf(error) {
  return error.msg
}

function brief(list) {
  const head = list.slice(0, 3).join('、')
  return list.length > 3 ? `${head}…` : head
}

function shown(value) {
  const text = JSON.stringify(value)
  return typeof value === 'string' || text === undefined ? String(text ?? value) : text
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const one of Object.values(value)) deepFreeze(one)
  return Object.freeze(value)
}
