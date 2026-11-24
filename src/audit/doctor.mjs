// audit doctor（design §6）：只读自检——把"这份数据还能不能用"的坏消息逐条说出来。
// 动手修是禁忌：这里没有 mkdir、没有写探针、没有 rename、没有一行自动修复
// （AGENTS 二·2：不静默；医生只报病情，改法由 CLI 打印给人看）。
import fs from 'node:fs'
import path from 'node:path'

import { RULE_LIMIT, SELF_MAX, config } from '../core/index.mjs'
import * as memory from '../memory/index.mjs'
import { VERSION, checkHome, readJson, readJsonl } from '../store/index.mjs'

// 分片只有一个层级（design §3：不许加目录层级）：events/<天>.jsonl 与 state/*.jsonl，
// 外加两个单独的 memory.jsonl / rules.jsonl。id 抢号落在 state/ids/ 且不带 .jsonl 后缀，
// 所以它不在逐行扫描里，另有一项「发号文件」盯着。
const JSONL_DIRS = ['events', 'state']
const JSONL_FILES = ['memory.jsonl', 'rules.jsonl']

export function doctor({ home, ctx } = {}) {
  const dir = dataHome(home, ctx)
  // 每个分片只读完一次，坏行清单与后面的各项检查共用（doctor 不许因为"多查一项"就多读一遍）。
  const files = jsonlFiles(dir)
  const scanned = files.map((file) => ({ file, ...scan(file) }))
  const checks = [
    guard('数据目录', () => checkDir(dir)),
    guard('schema 版本', () => checkSchema(dir)),
    guard('配置', () => checkConfig(dir, ctx)),
    guard('分片坏行', () => checkBadLines(dir, scanned)),
    guard('memory 收口副本', () => checkClosure(dir, scanned)),
    guard('发号文件', () => checkIds(dir)),
    guard('残留 .tmp', () => checkTmp(dir)),
    guard('meta.json 冷却记录', () => checkParts(dir)),
    guard('self.md 预算', () => checkSelf(dir)),
    guard('rules 活条数', () => checkRules(dir, scanned)),
  ]
  return { ok: checks.every((one) => one.ok), checks }
}

// 一项检查崩了也还是一条检查结果：把异常吞成"没问题"才是灾难（那会让人以为数据是好的），
// 所以异常一律报成不合格，正文里带上原话。
function guard(name, body) {
  try {
    const { ok, detail } = body()
    return { name, ok, detail }
  } catch (e) {
    return { name, ok: false, detail: `检查时读不动：${messageOf(e)}` }
  }
}

function checkDir(dir) {
  let stat = null
  try {
    stat = fs.statSync(dir)
  } catch {
    stat = null
  }
  if (stat === null) return { ok: false, detail: `数据目录不存在：${dir}（第一次写命令才会建）` }
  if (!stat.isDirectory()) return { ok: false, detail: `不是目录：${dir}` }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch (e) {
    return { ok: false, detail: `存在但不可写：${dir}（${messageOf(e)}）` }
  }
  // 这一条只回答"ACL 上让不让写"：Windows 上 access(W_OK) 不看只读属性，也不看磁盘满不满。
  // 真写一次探针就等于改了数据目录里的东西（doctor 是读命令），所以到此为止——
  // 第一次真写入由 appendJsonl 自己读回验证（design §3），比探针可信。
  return { ok: true, detail: `${dir} 存在且可写` }
}

function checkSchema(dir) {
  const state = checkHome(dir)
  if (state.ok) return { ok: true, detail: `v${state.version}（本程序要 v${VERSION}）` }
  return { ok: false, detail: state.why }
}

// 配置（design §15）：坏的 config.json 会让每条命令当场退 2，但那时人已经在命令里撞了墙。
// doctor 提前把"哪个键不对"说出来。判定交给 core/config 的 load——它是唯一一份白名单与校验，
// 这里再抄一份，两份迟早对不上（doctor 说没问题、命令照旧退 2 才是最坏的体检报告）。
// 环境变量只从 ctx.env 取：doctor 不自己摸进程环境（AGENTS 一，配置只经 load({env}) 进来）。
function checkConfig(dir, ctx) {
  const warned = []
  const env = ctx && ctx.env && typeof ctx.env === 'object' ? ctx.env : {}
  try {
    config.load({ env, homeDir: dir, warn: (msg) => warned.push(msg) })
  } catch (e) {
    return { ok: false, detail: `${messageOf(e)}（改回合法 JSON 或 config reset，别猜着改）` }
  }
  if (warned.length === 0) {
    return { ok: true, detail: '没有配置文件就是全默认；有的话键与值都对得上' }
  }
  // 提醒不算不合格：load 的契约是 warnings 走 "! "、errors 才退 2。但也不许咽掉。
  const shown = warned.slice(0, 3).join('；')
  const rest = warned.length - Math.min(warned.length, 3)
  return { ok: true, detail: `可用，但有 ${warned.length} 条提醒：${shown}${rest > 0 ? `；另有 ${rest} 条` : ''}` }
}

function jsonlFiles(dir) {
  const files = []
  for (const sub of JSONL_DIRS) {
    const at = path.join(dir, sub)
    let names = []
    try {
      names = fs.readdirSync(at)
    } catch (e) {
      if (e && e.code === 'ENOENT') continue
      throw e
    }
    for (const name of names.slice().sort()) {
      if (name.endsWith('.jsonl')) files.push(path.join(at, name))
    }
  }
  for (const name of JSONL_FILES) {
    const file = path.join(dir, name)
    // 没写过的文件不算是"一个文件"：空数据目录上还报"共 2 个文件逐行可解析"，
    // 会让人以为这里已经有数据了（AGENTS 二·2：不装作有）。
    if (fs.statSync(file, { throwIfNoEntry: false }) === undefined) continue
    files.push(file)
  }
  return files
}

// 逐行读一个分片。走 store 的 readJsonl，不再自己抄一份解析：剥 BOM、坏行口径
// （合法 JSON 但不是对象也算坏行）只该有一处定义，否则 doctor 会把 store 读得好的文件报成坏行。
// readJsonl 只读不写，符合"读命令不写盘"。
function scan(file) {
  const got = readJsonl(file, { lines: true })
  const bad = (got.badLines ?? []).map((one) => ({ ...one, why: whyOf(one.why), text: clip(one.text) }))
  return { rows: got.items, bad }
}

// readJsonl 的 why 是 JSON.parse 的原话（英文，还随 node 版本变）。doctor 报给人看，
// 要的是"这行读不出来"这种稳定说法，不是一句引擎内部报错。
function whyOf(why) {
  return why === '不是 JSON 对象' ? '不是一条记录' : '不是合法 JSON'
}

function checkBadLines(dir, scanned) {
  const all = []
  for (const one of scanned) {
    for (const item of one.bad) all.push({ file: relOf(dir, one.file), ...item })
  }
  if (all.length === 0) {
    if (scanned.length === 0) {
      return { ok: true, detail: '还没有可扫的分片（events/、state/、memory.jsonl、rules.jsonl 都还是空的）' }
    }
    return { ok: true, detail: `共 ${scanned.length} 个文件逐行可解析` }
  }
  const shown = all.slice(0, 5).map((one) => `${one.file}:${one.line}：${one.why}（${one.text}）`)
  const rest = all.length - shown.length
  return { ok: false, detail: `坏行 ${all.length} 处：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 处` : ''}` }
}

// 发号文件（state/ids/）：claim 用 wx 建空文件抢号，文件名就是号。这里只读名字与大小：
// 名字不合形状说明有人在里面放了别的东西；文件里有内容更糟——那是被改写过的账本，号不再可信。
const ID_NAME = /^[emrnp]-\d{8}-\d+$/

function checkIds(dir) {
  const at = path.join(dir, 'state', 'ids')
  let names = []
  try {
    names = fs.readdirSync(at)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, detail: '还没发过号（state/ids/ 还没建立）' }
    throw e
  }
  const wrong = []
  for (const name of names.slice().sort()) {
    const full = path.join(at, name)
    if (!ID_NAME.test(name)) {
      wrong.push(`${name} 不是号（形状是 e-YYYYMMDD-nn）`)
      continue
    }
    const size = fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0
    if (size !== 0) wrong.push(`${name} 里写了 ${size} 字节（发号文件该是空的）`)
  }
  if (wrong.length === 0) return { ok: true, detail: `${names.length} 个已发号` }
  const shown = wrong.slice(0, 5)
  const rest = wrong.length - shown.length
  const more = rest > 0 ? `；另有 ${rest} 处` : ''
  return { ok: false, detail: `state/ids/ 有 ${wrong.length} 处不对：${shown.join('；')}${more}` }
}

// 残留 .tmp：writeAtomic 在改名失败时留着整份新内容等下一次重试覆盖，那是设计（295 行），
// 不是垃圾也不是数据损坏。但它不该一直躺在那儿——报出来，人决定重跑一次还是删掉。
function checkTmp(dir) {
  const left = []
  const walk = (abs) => {
    let entries = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      if (e && e.code === 'ENOENT') return
      throw e
    }
    for (const entry of entries) {
      const full = path.join(abs, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tmp')) left.push(relOf(dir, full))
    }
  }
  walk(dir)
  if (left.length === 0) return { ok: true, detail: '没有残留的 .tmp' }
  const shown = left.slice(0, 5)
  const rest = left.length - shown.length
  return {
    ok: false,
    detail: `${left.length} 个残留 .tmp：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 个` : ''}`
      + '（原子写没走完，重跑一次写命令就会覆盖它）',
  }
}

// 同一个 id 写出两行、且 at 一样时，"谁赢"取决于哪一行后写——那就不是收口，是掷骰子。
// 这里只判定"at 最大那行唯一不唯一"，取哪一条仍是 memory 的事（design §4）。
function checkClosure(dir, scanned) {
  const file = scanned.find((one) => one.file === path.join(dir, 'memory.jsonl'))
  const rows = file === undefined ? [] : file.rows
  const top = new Map() // id -> { at, count }
  let partial = 0
  for (const rec of rows) {
    if (typeof rec.id !== 'string' || rec.id.trim() === '' || !Number.isFinite(rec.at)) {
      partial += 1
      continue
    }
    const seen = top.get(rec.id)
    if (seen === undefined) top.set(rec.id, { at: rec.at, rows: [rec] })
    else if (rec.at > seen.at) top.set(rec.id, { at: rec.at, rows: [rec] })
    else if (rec.at === seen.at) seen.rows.push(rec)
  }
  // 同 id 同 at 的多行有两种：一种合法，是"再写一行"的副本（seen +1 或 revise 收口），
  // 读方"同 at 后写赢"取到的就是最后一版；一种真冲突，内容不一致，谁赢都说不清。
  const clash = [...top].filter(([, one]) => one.rows.length > 1 && !isCopyRun(one.rows))
  if (clash.length > 0) {
    const shown = clash.map(([id, one]) => `${id} 有 ${one.rows.length} 行 at=${one.at}`)
    return { ok: false, detail: `收口副本冲突：${shown.join('；')}（读方按 at 最大取，同 at 时后写赢）` }
  }
  const runs = [...top].filter(([, one]) => one.rows.length > 1)
  const seenRuns = runs.filter(([, one]) => copyKind(one.rows) === 'seen').length
  const closureRuns = runs.length - seenRuns
  if (top.size === 0) {
    return { ok: true, detail: partial > 0 ? `没有可读的记忆行（${partial} 行缺 id 或 at）` : '还没写过 memory.jsonl' }
  }
  const rest = partial > 0 ? `；${partial} 行缺 id 或 at 未参与检查` : ''
  const notes = []
  if (seenRuns > 0) notes.push(`${seenRuns} 条 seen 副本`)
  if (closureRuns > 0) notes.push(`${closureRuns} 条 revise 收口副本`)
  const copies = notes.length > 0 ? `（其中 ${notes.join('、')}）` : ''
  return { ok: true, detail: `${top.size} 条 id 的 at 最大行唯一${copies}${rest}` }
}

// 同 id 同 at 的多行只有两种合法形状（design §4：旧行永不改写，要变就再写一行）：
// 1) seen 副本：同一条结论被复述记了一次，只有 seen 在动，且不倒退；
// 2) revise 收口副本：改写结论时把旧版本原样再写一行、只补上 to/by（memory 的 closureOf）。
// 于是：除 seen/to/by 外逐字段相同、键数相同；to/by 只允许在**最后一行**与第一行不同，
// 且那一行必须 to 与 by 成对给出；seen 不倒退；相邻两行不许逐字重复。
// 除这三个键以外任何一处不同，都还是真冲突——同 at 同 id 的两份不同内容，谁赢都说不清。
function isCopyRun(rows) {
  const first = rows[0]
  const keys = Object.keys(first)
  const last = rows[rows.length - 1]
  // 已经收过口的一行不该再冒出副本：to 非 null 的旧版本又写了一遍，说明有人手改了账本。
  if (hasTo(first)) return false
  for (let i = 0; i < rows.length; i += 1) {
    const one = rows[i]
    if (Object.keys(one).length !== keys.length) return false
    for (const key of keys) {
      if (COPY_KEYS.has(key)) continue
      if (JSON.stringify(one[key]) !== JSON.stringify(first[key])) return false
    }
    // to/by 只有最后一行能变：中间某行开过口又收回去，等于一条结论被收口两次。
    if (i < rows.length - 1 && !sameToBy(one, first)) return false
    // 逐字重复的两行不叫副本，叫写坏了：同一份字节写两次，读方凭什么选一个。
    if (i > 0 && JSON.stringify(rows[i - 1]) === JSON.stringify(one)) return false
    if (i > 0 && seenOf(one) < seenOf(rows[i - 1])) return false
  }
  if (sameToBy(last, first)) return true
  // 最后一行与第一行在 to/by 上不同，那就只能是收口副本：to 与 by 必须成对，
  // 只有 to 没有 by（或反过来）不是 revise 写出来的，是被人改坏的。
  return hasTo(last) && hasBy(last)
}

const COPY_KEYS = new Set(['seen', 'to', 'by'])

function copyKind(rows) {
  return sameToBy(rows[rows.length - 1], rows[0]) ? 'seen' : 'closure'
}

function sameToBy(a, b) {
  return nullish(a.to) === nullish(b.to) && nullish(a.by) === nullish(b.by)
}

function nullish(value) {
  return value === undefined ? null : value
}

function hasTo(one) {
  return nullish(one.to) !== null
}

function hasBy(one) {
  return nullish(one.by) !== null
}

function seenOf(one) {
  return Number.isFinite(one.seen) ? one.seen : 0
}

// 冷却记录的形状（design §4）：{ 插件名: { fail: 非负整数, until: 有限数字或 null } }。
// until 缺失也报红：design 写的是显式 null，"没有这个键"到底是没冷却还是没写过，读不清。
function checkParts(dir) {
  const doc = readJson(path.join(dir, 'state', 'meta.json'))
  if (doc === null) return { ok: true, detail: '还没有 meta.json（从未写过），没有冷却记录' }
  if (doc.__bad === true) return { ok: false, detail: 'meta.json 不是合法 JSON：水位与冷却记录都读不出' }
  if (doc.parts === undefined) return { ok: true, detail: '没有 parts 记录（没有插件失败过）' }
  const parts = doc.parts
  if (parts === null || typeof parts !== 'object' || Array.isArray(parts)) {
    return { ok: false, detail: 'parts 必须是 { 插件名: { fail, until } } 形状的对象' }
  }
  const names = Object.keys(parts)
  const wrong = []
  for (const name of names) {
    const one = parts[name]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      wrong.push(`parts.${name} 不是对象`)
      continue
    }
    if (!Number.isInteger(one.fail) || one.fail < 0) {
      wrong.push(`parts.${name}.fail 必须是非负整数（拿到 ${show(one.fail)}）`)
    }
    if (one.until !== null && !Number.isFinite(one.until)) {
      wrong.push(`parts.${name}.until 只能是 null 或有限数字（拿到 ${show(one.until)}）`)
    }
  }
  if (wrong.length > 0) return { ok: false, detail: `冷却记录形状不对：${wrong.join('；')}` }
  return { ok: true, detail: `${names.length} 个插件冷却记录形状正确` }
}

function checkSelf(dir) {
  // 走 memory 门面的读：文件叫什么、预算怎么算（含"末尾换行不计价"），只有那一处说了算
  // （doctor 仍然只读，判断也用 readSelf 给的 over，不在这里再算一次 > SELF_MAX）。
  const read = memory.readSelf(dir)
  if (read.updatedAt === null) return { ok: true, detail: '还没写过 self.md' }
  const used = read.cost
  if (read.over) {
    return { ok: false, detail: `self.md 是 ${used.toFixed(1)} cost，超过上限 ${SELF_MAX}：删掉过时的段落（doctor 只报不改）` }
  }
  return { ok: true, detail: `${used.toFixed(1)} / ${SELF_MAX} cost` }
}

// 活规矩 = 出现过的 id 去掉被任何一条 supersedes 收口掉的（design §4：规矩更新写新条 + supersedes）。
// 超了只报红，一条都不删——删规矩是记忆的语义决定，不是自检该做的事。
function checkRules(dir, scanned) {
  const file = scanned.find((one) => one.file === path.join(dir, 'rules.jsonl'))
  const rows = file === undefined ? [] : file.rows
  const latest = new Map() // id -> at
  const replaced = new Set()
  for (const rec of rows) {
    if (typeof rec.id !== 'string' || rec.id.trim() === '' || !Number.isFinite(rec.at)) continue
    if (Array.isArray(rec.supersedes)) {
      for (const id of rec.supersedes) if (typeof id === 'string') replaced.add(id)
    }
    const seen = latest.get(rec.id)
    if (seen === undefined || rec.at >= seen) latest.set(rec.id, rec.at)
  }
  const live = [...latest.keys()].filter((id) => !replaced.has(id))
  if (live.length > RULE_LIMIT) {
    return {
      ok: false,
      detail: `活规矩 ${live.length} 条，超过 ${RULE_LIMIT}：写新条并 supersedes 旧条（doctor 不替你删任何一条）`,
    }
  }
  return { ok: true, detail: `${live.length} / ${RULE_LIMIT} 条活规矩` }
}

function relOf(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

function clip(text) {
  const one = text.trim()
  return one.length > 60 ? `${one.slice(0, 60)}…` : one
}

function show(value) {
  if (typeof value === 'string') return `「${value}」`
  if (value === undefined) return 'undefined'
  return String(value)
}

function messageOf(e) {
  if (e && typeof e.message === 'string') return e.message
  return String(e)
}

// home 是正的入口；ctx.home 兜底（CLI 手里常常只有一个 ctx），两者都没有就直接拒绝，
// 别让 doctor 去读进程的当前目录——那会让"自检通过"变成一场误会。
function dataHome(home, ctx) {
  const given = typeof home === 'string' ? home.trim() : ''
  const fallback = ctx && typeof ctx.home === 'string' ? ctx.home.trim() : ''
  const dir = given !== '' ? given : fallback
  if (dir === '') throw new Error('doctor 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  return dir
}
