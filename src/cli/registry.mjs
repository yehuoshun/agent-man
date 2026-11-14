import * as affect from '../affect/index.mjs'
import * as audit from '../audit/index.mjs'
import { AFFECT_STIM_PER_HOUR, DEFAULT_WINDOW_DAYS, config, dayKey, parseWhen, rel }
  from '../core/index.mjs'
import * as digest from '../digest/index.mjs'
import * as intent from '../intent/index.mjs'
import * as memory from '../memory/index.mjs'
import * as mind from '../mind/index.mjs'
import * as parts from '../parts/index.mjs'
import * as soulCards from '../soul/index.mjs'
import { home } from '../store/index.mjs'
import { item as record, list as records, renderDigest, renderScreen } from '../view/index.mjs'

// 天→毫秒只是单位换算，不是 §10 的常数：30 天窗口的 30 来自 core。
const DAY_MS = 24 * 60 * 60 * 1000

// 命令表只有一张（design §6）：命令名 → 处理函数。handler 只做三件事——取参、调门面、排屏。
// 该不该说话、分数怎么算、记忆怎么改，都在各领域门面里；registry 一旦开始判断业务，
// CLI 就成了第二份真源（AGENTS 四）。
// config / soul / doctor 自带渲染，原样递 ctx；新接的命令统一过 guard()：门面抛出来的
// 用法错与数据错变成一行 "! " + 退出码 2，绝不吐栈，也绝不吞掉。
export const TABLE = new Map([
  ['doctor', doctor],
  ['config', (ctx) => config.run(ctx)],
  ['soul', soul],

  // 情景层：只记发生过的事，不改结论。
  ['event', guard(eventLs)],
  ['event add', guard(eventAdd)],
  ['event ls', guard(eventLs)],
  ['event find', guard(eventFind)],

  // 语义层：结论要有证据；改结论只写新版本，旧行永不改写。
  ['memory', guard(memoryLs)],
  ['memory add', guard(memoryAdd)],
  ['memory ls', guard(memoryLs)],
  ['memory find', guard(memoryFind)],
  ['memory show', guard(memoryShow)],
  ['memory revise', guard(memoryRevise)],

  // 前瞻层：便条等着被递出，日程等着被打勾。
  ['note', guard(noteLs)],
  ['note add', guard(noteAdd)],
  ['note ls', guard(noteLs)],
  ['note take', guard(noteTake)],
  ['plan', guard(planLs)],
  ['plan add', guard(planAdd)],
  ['plan done', guard(planDone)],
  ['plan ls', guard(planLs)],

  // 规矩与自我块也住语义层（design §7）：规矩只追加，替代靠新条点名 supersedes；
  // 自我块是一份纯文本，写就是整份覆盖——所以 set 收整份，没有按块替换。
  ['rule', guard(ruleLs)],
  ['rule add', guard(ruleAdd)],
  ['rule ls', guard(ruleLs)],
  ['self', guard(selfShow)],
  ['self show', guard(selfShow)],
  ['self set', guard(selfSet)],
  ['self append', guard(selfAppend)],

  // 处境与摘要。处境屏 = mind 的快照 + view 的排版；cue 只判不说，判决与账本在 mind 里。
  ['context', guard(contextShow)],
  ['context show', guard(contextShow)],
  ['context digest', guard(contextDigest)],
  ['context sense', guard(contextSense)],
  ['context cue', guard(contextCue)],

  // 审计：只看，不改；exit 1 表示数据不合格，不是命令打错了。
  ['audit', guard(auditTrace)],
  ['audit trace', guard(auditTrace)],
  ['audit timeline', guard(auditTimeline)],
  ['audit orphan', guard(auditOrphan)],

  // 情绪：存的永远是刺激，不是台词；show 只印数字、标签、刺激条数（design §14.6）。
  ['affect', guard(affectShow)],
  ['affect show', guard(affectShow)],
  ['affect set', guard(affectSet)],
  ['affect clear', guard(affectClear)],
  ['affect why', guard(affectWhy)],
  ['affect stim', guard(affectStim)],

  // 别名（design §6）：名字短一点，走的是同一个 handler——不为别名再抄一遍参数解析。
  ['log', guard(eventAdd)],
  ['remember', guard(memoryAdd)],
  ['leave', guard(noteAdd)],
  ['digest', guard(contextDigest)],
  ['cue', guard(contextCue)],
  ['find', guard(eventFind)],
  ['show', guard(memoryShow)],
  ['look', guard(contextShow)],
])

// 最长匹配：先把前两个词当命令名试一次，再退到一个词（"memory add" 与 "memory" 都在表里）。
// 遇到 `--json` 这类值就停：参数不该被当成第二段命令名。
// 返回的 args 是"命令名之后"的部分，handler 因此不必知道自己是两词命令还是别名。
export function resolve(argv) {
  const args = Array.isArray(argv) ? argv : []
  const words = []
  for (const one of args) {
    if (typeof one !== 'string' || one.startsWith('--') || words.length === 2) break
    words.push(one)
  }
  for (const n of [2, 1]) {
    if (words.length < n) continue
    const name = words.slice(0, n).join(' ')
    const handler = TABLE.get(name)
    if (handler) return { name, handler, args: args.slice(n) }
  }
  return null
}

// 其它名字 = PATH 上的零件（design §6 / §8）：直通时 stdio 继承、退出码原样透传。
// 找不到就明说，并说清零件该长什么样——"没有这个命令"之后必须还有一句话。
export async function plugin(name, args, ctx) {
  const found = parts.scan(ctx.env).find((one) => one.name === name)
  if (!found) {
    ctx.err(`! 没有这个命令，也没找到 agent-man-${name}\n`)
    ctx.err(`! 零件是 PATH 上的可执行文件 agent-man-${name}；内置命令见 agent-man --help\n`)
    return 2
  }
  try {
    return parts.passthrough(found, args, ctx.env)
  } catch (e) {
    ctx.err(`! ${e && e.message ? e.message : e}\n`)
    return 2
  }
}

// doctor 分两半：七项只读自检住 src/audit/doctor.mjs（它绝不写盘），渲染与退出码在这里。
// 不合格是"这份数据还不能用"，不是"命令打错了"——所以退 1，不退 2（design §6）。
export function doctor(ctx) {
  const dir = homeOf(ctx)
  const result = audit.doctor({ home: dir, ctx })

  ctx.out('agent-man doctor\n')
  ctx.out(`  数据目录   ${dir}\n`)
  for (const one of result.checks) {
    ctx.out(`  ${one.ok ? 'ok' : '!!'} ${one.name}  ${one.detail}\n`)
  }

  if (!result.ok) {
    const bad = result.checks.filter((one) => !one.ok).length
    ctx.err(`! ${bad} 项不合格：按上面的提示改，或把 AGENT_MAN_HOME 指到别处\n`)
    return 1
  }
  ctx.out('  一切就绪\n')
  return 0
}

// ── 下面全是 CLI 侧的小工具：取参、说"! "、把记录排成行。 ─────────────────────

// 门面抛错一律是"用法或数据不合格"：一行 "! " + 2，说清怎么改，比栈有用。
function guard(handler) {
  return async function guarded(ctx) {
    try {
      return await handler(ctx)
    } catch (e) {
      ctx.err(`! ${e && e.message ? e.message : String(e)}\n`)
      return 2
    }
  }
}

// 命令行只有两种形状：`--名字 值` 和 `--开关`。不认识的名字当场报——
// 悄悄忽略一个 --jsno，等于让人以为自己拿到了 JSON。
function split(argv, { names = [], bools = [] } = {}) {
  const flags = new Map()
  const words = []
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i]
    if (typeof one !== 'string') throw new Error('命令行参数里混进了非字符串')
    if (!one.startsWith('--')) {
      words.push(one)
      continue
    }
    const body = one.slice(2)
    const cut = body.indexOf('=')
    const name = cut < 0 ? body : body.slice(0, cut)
    const inline = cut < 0 ? null : body.slice(cut + 1)
    if (bools.includes(name)) {
      flags.set(name, inline === null ? true : inline !== 'false')
      continue
    }
    if (!names.includes(name)) {
      const known = [...bools, ...names].map((key) => `--${key}`).join(' / ')
      throw new Error(`不认识的开关：--${name}（这里认得的只有 ${known}）`)
    }
    if (inline !== null) {
      flags.set(name, inline)
      continue
    }
    const next = list[i + 1]
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      throw new Error(`--${name} 后面缺值（写法：--${name} 值）`)
    }
    flags.set(name, next)
    i += 1
  }
  return { words, flags }
}

function arg(flags, name) {
  return flags.has(name) ? flags.get(name) : undefined
}

function on(flags, name) {
  const value = arg(flags, name)
  return value === true || value === 'true'
}

// 资源名后面跟了不认得的东西（`memory bogus`）：说清有哪些动作，别把打错的子命令当成 ls。
function noWords(words, usage) {
  if (words.length > 0) throw new Error(`不认识的用法：「${words.join(' ')}」——${usage}`)
}

// 时间只在入口解释一次（design §5）：parseWhen 归一成 ms，之后全链路只认数字；
// 认不出就退 2 并给出能用的写法，不猜、不补。
function instant(ctx, text, what) {
  if (text === undefined) return undefined
  if (typeof text === 'number' && Number.isFinite(text)) return text
  const ms = parseWhen(String(text), ctx.now)
  if (ms === null || !Number.isFinite(ms)) {
    throw new Error(`--${what} 认不出时间：「${text}」（可用 2026-11-20 / 2026-11-20 09:00 / 3d / 12h）`)
  }
  return ms
}

const SPAN = /^\d+\s*(d|h|m)$/

// `--since 3d` 在 parseWhen 里指向"三天后"；窗口两头要的是同一段跨度的过去，镜像回来。
// 写死日期（2026-11-01）本身就是过去的某一刻，不镜像。
function bound(ctx, text, what) {
  if (text === undefined) return undefined
  const ms = instant(ctx, text, what)
  return SPAN.test(String(text)) ? ctx.now - (ms - ctx.now) : ms
}

// `--min-gap 6h` 要的是一段时长，不是某一刻：parseWhen 的 span 从 0 起算正好是毫秒数。
// 只认 6h / 90m / 2d 这种写法——日期混进来会变成一个几十年的间隔，那种"门槛"没人想表达。
function gapOf(text) {
  if (text === undefined) return undefined
  const raw = String(text).trim()
  if (!SPAN.test(raw)) throw new Error(`--min-gap 要给一段时长：「${text}」（可用 6h / 90m / 2d）`)
  const ms = parseWhen(raw, 0)
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`--min-gap 认不出时长：「${text}」`)
  return ms
}

function impOf(text) {
  if (text === undefined) return 0
  const n = Number(text)
  if (!Number.isInteger(n)) throw new Error(`--imp 要给整数 0-3：「${text}」`)
  return n
}

function cuesOf(text) {
  if (text === undefined) return []
  return String(text).split(',').map((one) => one.trim()).filter(Boolean)
}

// 一串 id（`--supersedes r-1,r-2`）：逗号或空格都认，空串等于没给。
function idsOf(text) {
  if (text === undefined) return []
  return String(text).split(/[\s,]+/).map((one) => one.trim()).filter(Boolean)
}

function srcOf(text) {
  if (text === undefined) return { origin: 'user' }
  const one = String(text).trim()
  if (one === 'user' || one === 'self') return { origin: one }
  if (one.startsWith('tool:')) {
    const ref = one.slice(5).trim()
    if (!ref) throw new Error('--src tool: 后面要给零件名字（例如 --src tool:weather）')
    return { origin: 'tool', ref }
  }
  throw new Error(`--src 只认 user / tool:名字 / self：「${one}」`)
}

function numberOr(text, what) {
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${what} 要给不小于 0 的数字：「${text}」`)
  return n
}

function limitOf(flags) {
  const text = arg(flags, 'limit')
  if (text === undefined) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0) throw new Error(`--limit 要给不小于 0 的整数：「${text}」`)
  return n
}

// 截了多少就说多少：被截掉的那几条不该因为屏幕装不下就从世界上消失（AGENTS 二·2）。
function cutBy(items, limit) {
  if (limit === undefined || items.length <= limit) return { items, cut: 0 }
  return { items: items.slice(0, limit), cut: items.length - limit }
}

// 家目录只有一个来源（AGENT_MAN_HOME → ~/.agent-man）：每个 handler 都重写一遍只会分叉。
function homeOf(ctx) {
  return home(ctx.env)
}

// --json 的出口也只有一个：一行、不缩进、别的什么都不许混进 stdout（design §6）。
function jsonOut(ctx, value) {
  ctx.out(`${JSON.stringify(value)}\n`)
}

// 坏行不删、也不装作没发生：数出来，用 "! " 说一句（design §3）。
function noisy(ctx, count, what = '记录') {
  if (count > 0) ctx.err(`! 跳过 ${count} 行读不懂的${what}（坏行没删，只是没算进来）\n`)
}

// 配置只从 core/config 的 load() 拿，且只在真要用的命令里读：坏配置当场退 2，
// 不悄悄退回默认值继续跑（design §15）。
function cfgOf(ctx) {
  const dir = homeOf(ctx)
  return config.load({ env: ctx.env, homeDir: dir, now: ctx.now, warn: (one) => ctx.err(`! ${one}\n`) })
}

// 领域记录 → 渲染行（view/records 只认 id / when / text / key / trigger）。
// 时间串在这儿算好再交出去：view 不碰钟，"时间只解释一次"才有唯一落点。
function rowsOf(ctx, items, kind, build) {
  const shaped = items.map((one) => build(one, ctx))
  return records(shaped, kind)
}

// ── 情景层：event ──────────────────────────────────────────────────────────

async function eventAdd(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['imp', 'cue', 'src', 'at'], bools: ['json'] })
  const text = words.join(' ').trim()
  if (!text) {
    throw new Error('用法：agent-man event add "<发生了什么>" [--imp 0-3] [--cue 她,加班] ' +
      '[--src user|tool:名字|self]')
  }
  const dir = homeOf(ctx)
  const entry = {
    text,
    imp: impOf(arg(flags, 'imp')),
    cues: cuesOf(arg(flags, 'cue')),
    src: srcOf(arg(flags, 'src')),
    at: instant(ctx, arg(flags, 'at'), 'at') ?? ctx.now,
  }
  const got = await memory.eventAdd(entry, { home: dir, now: ctx.now, dayStart: cfgOf(ctx).clock.dayStart })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    const cues = entry.cues.length > 0 ? `，cue ${entry.cues.join('、')}` : ''
    ctx.out(`已记下 ${got.id}（imp ${entry.imp}${cues}）\n`)
  }
  // 欠账是"该巩固了"的唯一计数器（§14.9）：情景已经落盘，这一笔没记上也不许让写入失败，
  // 但也不能悄悄丢掉——门槛到不了，cue 就只会按空闲时间说话。
  const owed = await bumpDebt(dir, got, entry)
  if (owed) ctx.err(`! 欠账没记上：${owed}\n`)
  return 0
}

// 记账：imp 累进 unconsolidated，件数累进 unreflected。失败只回一句 why，不抛。
async function bumpDebt(dir, got, entry) {
  try {
    const bumped = await mind.debt.bump(dir, {
      at: Number.isFinite(got.at) ? got.at : entry.at,
      imp: Number.isFinite(got.record?.imp) ? got.record.imp : entry.imp,
    })
    return bumped.saved ? null : bumped.why
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// 事件只按窗口读（design §6）：默认 30 天，--all 才连更早的一起看。
function eventsOf(ctx, flags, query) {
  const all = on(flags, 'all')
  const since = bound(ctx, arg(flags, 'since'), 'since')
  const from = since ?? (all ? undefined : ctx.now - DEFAULT_WINDOW_DAYS * DAY_MS)
  const got = memory.events(homeOf(ctx), { from, to: bound(ctx, arg(flags, 'until'), 'until') })
  // 新的事先说；同一毫秒保留文件里的先后（不另编序号）。
  let items = got.items.slice().reverse()
  if (query) {
    const needle = query.toLowerCase()
    items = items.filter((one) => String(one.text).toLowerCase().includes(needle))
  }
  const cut = cutBy(items, limitOf(flags))
  return { items: cut.items, cut: cut.cut, bad: got.bad }
}

function eventLs(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['since', 'until', 'limit'],
    bools: ['all', 'json'],
  })
  noWords(words, 'agent-man event ls [--since …] [--until …] [--all] [--limit N]')
  return sayEvents(ctx, flags, eventsOf(ctx, flags, ''))
}

function eventFind(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['since', 'until', 'limit'],
    bools: ['all', 'json'],
  })
  const query = words.join(' ').trim()
  if (!query) {
    throw new Error('用法：agent-man event find "<要找的词>" [--since …] [--until …] [--all] [--limit N]')
  }
  return sayEvents(ctx, flags, eventsOf(ctx, flags, query))
}

function sayEvents(ctx, flags, got) {
  if (on(flags, 'json')) jsonOut(ctx, got.items)
  else ctx.out(`${rowsOf(ctx, got.items, 'event', (one, c) => ({
    id: one.id,
    when: rel(one.at, c.now),
    text: one.text,
  }))}\n`)
  if (got.cut > 0) {
    ctx.err(`! 只列了最近 ${got.items.length} 条，还有 ${got.cut} 条没列` +
      '（--limit 调大，或 --all 看全部）\n')
  }
  noisy(ctx, got.bad, '事件')
  return 0
}

// ── 语义层：memory ─────────────────────────────────────────────────────────

async function memoryAdd(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['key', 'from', 'imp', 'at'], bools: ['json'] })
  const fact = words.join(' ').trim()
  if (!fact) {
    throw new Error('用法：agent-man memory add "<事实>" --key <槽位> --from <事件id,…> [--imp 0-3]')
  }
  const key = arg(flags, 'key')
  if (key === undefined || String(key).trim() === '') {
    throw new Error('memory add 要给 --key：这条结论占哪个槽位（例如 --key 她·习惯）')
  }
  const got = await memory.add({
    key: String(key),
    fact,
    imp: impOf(arg(flags, 'imp')),
    evidence: evidenceOf(arg(flags, 'from')),
    at: instant(ctx, arg(flags, 'at'), 'at') ?? ctx.now,
  }, { home: homeOf(ctx), now: ctx.now, dayStart: cfgOf(ctx).clock.dayStart })

  if (on(flags, 'json')) jsonOut(ctx, got)
  else if (got.status === 'same') ctx.out(`没变：${got.id} 已经是这条（同槽位同 imp）\n`)
  else {
    const replaced = got.replaced && got.replaced.length > 0 ? `（取代 ${got.replaced.join('、')}）` : ''
    ctx.out(`已记下 ${got.id}${replaced}\n`)
  }
  noisy(ctx, got.skipped ?? 0)
  return 0
}

// --from 是"证据从哪来"：事件 id 列表。日期区间（design 写了 `日期..日期`）门面还不吃，
// 拿到区间就明说，别把 `2026-11-01..2026-11-03` 当 id 混进证据里。
function evidenceOf(text) {
  if (text === undefined) {
    throw new Error('memory add 要给 --from：证据是哪些事件（--from e-20261114-01,e-20261114-02）')
  }
  const raw = String(text).trim()
  if (raw.includes('..')) {
    throw new Error('证据要写事件 id（--from 区间这一版不支持）：先 event ls 找 id')
  }
  const ids = raw.split(/[\s,]+/).filter(Boolean)
  if (ids.length === 0) throw new Error('--from 是空的：证据至少要有一条事件 id')
  return { ids }
}

function memoryLs(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['since', 'until', 'key'],
    bools: ['all', 'live', 'json'],
  })
  noWords(words, 'agent-man memory ls [--since …] [--until …] [--all] [--live] [--key 槽位]')
  const got = memory.ls({
    all: on(flags, 'all'),
    live: on(flags, 'live') ? true : undefined,
    since: bound(ctx, arg(flags, 'since'), 'since'),
    until: bound(ctx, arg(flags, 'until'), 'until'),
    key: arg(flags, 'key'),
  }, { home: homeOf(ctx), now: ctx.now })
  return sayMemory(ctx, flags, got)
}

function memoryFind(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['since', 'until', 'key'],
    bools: ['all', 'live', 'json'],
  })
  const query = words.join(' ').trim()
  if (!query) throw new Error('用法：agent-man memory find "<要找的词>" [--all] [--key 槽位]')
  const got = memory.find(query, {
    all: on(flags, 'all'),
    live: on(flags, 'live') ? true : undefined,
    since: bound(ctx, arg(flags, 'since'), 'since'),
    until: bound(ctx, arg(flags, 'until'), 'until'),
    key: arg(flags, 'key'),
  }, { home: homeOf(ctx), now: ctx.now })
  return sayMemory(ctx, flags, got)
}

function sayMemory(ctx, flags, got) {
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`${rowsOf(ctx, got.items, 'memory', (one, c) => ({
      id: one.id,
      when: rel(one.at, c.now),
      text: one.fact,
      key: one.key,
    }))}\n`)
  }
  noisy(ctx, got.skipped)
  return 0
}

// show 要能回答"凭什么这么说"：结论一行，证据在不在、版本被谁取代，都摆出来。
function memoryShow(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  const wanted = words.join(' ').trim()
  if (!wanted) throw new Error('用法：agent-man memory show <id|槽位>')
  const got = memory.show(wanted, { home: homeOf(ctx), now: ctx.now })
  if (on(flags, 'json')) {
    ctx.out(`${JSON.stringify(got)}\n`)
    noisy(ctx, got.skipped)
    return 0
  }
  if (!got.record) {
    ctx.err(`! 没有这条结论：「${wanted}」（agent-man memory ls 看现在有哪些）\n`)
    noisy(ctx, got.skipped)
    return 1
  }
  const one = got.record
  ctx.out(`${record({ id: one.id, when: rel(one.at, ctx.now), text: one.fact, key: one.key }, 'memory')}\n`)
  for (const ev of got.evidence) ctx.out(`  证据  ${ev.id}  ${ev.found ? '在' : '找不到'}\n`)
  for (const ver of got.chain) {
    const end = ver.live
      ? '现在有效'
      : `到 ${dayKey(ver.to)} 为止${ver.by ? `（被 ${ver.by} 取代）` : ''}`
    ctx.out(`  版本  ${ver.id}  ${dayKey(ver.at)} 起  ${end}\n`)
  }
  noisy(ctx, got.skipped)
  return 0
}

async function memoryRevise(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['imp', 'from'], bools: ['json'] })
  const [id, ...rest] = words
  const fact = rest.join(' ').trim()
  if (arg(flags, 'from') !== undefined) {
    throw new Error('--from 这一版没接：memory revise 只认新说法与 --imp（证据跟着记忆走，不重写）')
  }
  if (!id || !fact) {
    throw new Error('用法：agent-man memory revise <id> "<新事实>" [--imp 0-3]')
  }
  const patch = { fact }
  if (arg(flags, 'imp') !== undefined) patch.imp = impOf(arg(flags, 'imp'))
  const got = await memory.revise(id, patch, {
    home: homeOf(ctx),
    now: ctx.now,
    dayStart: cfgOf(ctx).clock.dayStart,
  })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else ctx.out(`已改：${got.id} 换成新的说法（旧版本 ${got.from} 留着，没被抹掉）\n`)
  noisy(ctx, got.skipped ?? 0)
  return 0
}

// ── 前瞻层：note / plan ────────────────────────────────────────────────────

async function noteAdd(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['trigger', 'ttl', 'at'],
    bools: ['json'],
  })
  const text = words.join(' ').trim()
  if (!text) {
    throw new Error('用法：agent-man note add "<要留的话>" --trigger "<什么时候>" [--ttl 7d]')
  }
  const one = await intent.notes.add(homeOf(ctx), {
    text,
    trigger: arg(flags, 'trigger'),
    ttl: arg(flags, 'ttl'),
    at: instant(ctx, arg(flags, 'at'), 'at') ?? ctx.now,
    dayStart: cfgOf(ctx).clock.dayStart,
  })
  if (on(flags, 'json')) jsonOut(ctx, one)
  else ctx.out(`已留下 ${one.id}（${one.trigger ? `等：${one.trigger}` : '没有触发条件'}）\n`)
  return 0
}

function noteLs(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man note ls')
  const got = intent.notes.list(homeOf(ctx), { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`${rowsOf(ctx, got.items, 'note', (one, c) => ({
      id: one.id,
      when: rel(one.at, c.now),
      text: one.text,
      trigger: one.trigger,
    }))}\n`)
  }
  if (got.expired > 0) {
    ctx.err(`! ${got.expired} 条便条过了 ttl，不再列出（ttl 到了就作废：design §2）\n`)
  }
  noisy(ctx, got.bad, '便条')
  return 0
}

function noteTake(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  const id = words.join(' ').trim()
  if (!id) throw new Error('用法：agent-man note take <id>')
  const one = intent.notes.take(homeOf(ctx), id, { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, one)
  else {
    ctx.out(`已递出 ${record({ id: one.id, when: rel(one.at, ctx.now), text: one.text,
      trigger: one.trigger }, 'note')}\n`)
  }
  return 0
}

async function planAdd(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['at'], bools: ['json'] })
  const text = words.join(' ').trim()
  if (!text) throw new Error('用法：agent-man plan add "<要做的事>" --at "<什么时候>"')
  const due = instant(ctx, arg(flags, 'at'), 'at')
  if (due === undefined) throw new Error('plan add 要给 --at：什么时候到期（plan add "体检" --at 明天 9:00）')
  const one = await intent.plans.add(homeOf(ctx), {
    text,
    due,
    at: ctx.now,
    dayStart: cfgOf(ctx).clock.dayStart,
  })
  if (on(flags, 'json')) jsonOut(ctx, one)
  else ctx.out(`已记下 ${one.id}（${rel(one.due, ctx.now)}到期）\n`)
  return 0
}

function planLs(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man plan ls')
  const got = intent.plans.list(homeOf(ctx), { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`${rowsOf(ctx, got.items, 'plan', (one, c) => ({
      id: one.id,
      when: `${rel(one.due, c.now)}${one.late ? ' · 已晚' : ''}`,
      text: one.text,
    }))}\n`)
  }
  if (got.later > 0) {
    ctx.err(`! 还有 ${got.later} 条日程排在 ${DEFAULT_WINDOW_DAYS} 天以后（没丢，plan ls 一直在）\n`)
  }
  noisy(ctx, got.bad, '日程')
  return 0
}

function planDone(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  const id = words.join(' ').trim()
  if (!id) throw new Error('用法：agent-man plan done <id>')
  const one = intent.plans.done(homeOf(ctx), id, { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, one)
  else ctx.out(`已打勾 ${record({ id: one.id, when: rel(one.due, ctx.now), text: one.text }, 'plan')}\n`)
  return 0
}

// ── 规矩与自我块（design §4/§6） ───────────────────────────────────────────

// 规矩：正文与理由都必填；要替代谁就点名 supersedes，旧行逐字不动、只是不再生效。
async function ruleAdd(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['why', 'supersedes'],
    bools: ['json'],
  })
  const text = words.join(' ').trim()
  if (!text) {
    throw new Error('用法：agent-man rule add "<规矩>" --why "<为什么>" [--supersedes r-…]')
  }
  const got = await memory.addRule(homeOf(ctx), {
    text,
    why: arg(flags, 'why'),
    supersedes: idsOf(arg(flags, 'supersedes')),
    at: ctx.now,
    dayStart: cfgOf(ctx).clock.dayStart,
  })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`已立规矩 ${got.id}（现在 ${got.live}/${got.limit} 条在生效）\n`)
    if (got.superseded.length > 0) {
      ctx.err(`! 旧的 ${got.superseded.join('、')} 已被取代（旧行没删，只是不再生效）\n`)
    }
  }
  noisy(ctx, got.skipped ?? 0)
  return 0
}

function ruleLs(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['all', 'json'] })
  noWords(words, 'agent-man rule ls [--all] [--json]')
  const got = memory.listRules(homeOf(ctx), { all: on(flags, 'all'), now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`${rowsOf(ctx, got.items, 'rule', (one, c) => ({
      id: one.id,
      when: rel(one.at, c.now),
      // 复述次数只在真被复述过时补一句：0 次是常态，天天印一个 0 会把行读成噪声。
      text: one.seen > 0 ? `${one.text}（复述过 ${one.seen} 次）` : one.text,
    }))}\n`)
  }
  if (got.over > 0) {
    ctx.err(`! 同时生效 ${got.live} 条，超过上限 ${got.limit}：先点名替代一条\n`)
  }
  noisy(ctx, got.skipped)
  return 0
}

// 自我块：一份纯文本，不分块也不做版本（design §4），所以 set 收的是整份文本。
function selfShow(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man self show [--json]（裸 self 等同此命令）')
  const got = memory.readSelf(homeOf(ctx))
  if (on(flags, 'json')) jsonOut(ctx, got)
  else if (got.text.trim() === '') {
    ctx.out('（还没写过自我块：agent-man self append "<一句话>" 记下此刻，self set "<整份>" 整份覆盖）\n')
  } else ctx.out(got.text.endsWith('\n') ? got.text : `${got.text}\n`)
  if (got.over) ctx.err(`! 自我块 ${tenth(got.cost)}/${got.limit}，超预算了：注入时放不下（design §10）\n`)
  return 0
}

async function selfSet(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['id'], bools: ['json'] })
  if (arg(flags, 'id') !== undefined) {
    throw new Error('--id 这一版没接：自我块是整份覆盖（setSelf），没有按块替换（design §4：不分块）')
  }
  const text = words.join(' ').trim()
  if (!text) throw new Error('用法：agent-man self set "<整份文本>"（整份覆盖，旧文本不保留）')
  const got = await memory.setSelf(homeOf(ctx), text, { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else ctx.out(`已覆盖自我块（${tenth(got.cost)}/${got.limit} cost，原来 ${tenth(got.was)}）\n`)
  return 0
}

async function selfAppend(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  const text = words.join(' ').trim()
  if (!text) throw new Error('用法：agent-man self append "<一段话>"（段首自动补今天的日期）')
  const got = await memory.appendSelf(homeOf(ctx), text, { now: ctx.now, dayStart: cfgOf(ctx).clock.dayStart })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    const head = got.header ? `（新起 ${got.header.replace(/^## /, '')} 这一段）` : '（接在今天这段后面）'
    ctx.out(`已记进自我块${head}：${tenth(got.cost)}/${got.limit} cost\n`)
  }
  return 0
}

// ── 处境与摘要 ─────────────────────────────────────────────────────────────

// 处境屏（design §6：裸 `agent-man` 就是它）。mind 算"此刻站在哪一段日子里"，view 排成一屏，
// 这里只接线——不在这里挑哪条上屏，也不在这里算分数。
async function contextShow(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man context show [--json]（裸 agent-man 等同此命令）')
  // 零件先问一遍再排屏（design §8 的聚合模式）：它们答的话是这一屏最后那一段的料。
  // 预算用处境那一份——建议行最终也要跟日程、便条抢同一个额度，先按小份抓回来
  // 就不会出现"零件答得很响，屏上却一条都装不下"的浪费。
  const got = await parts.sense(ctx.env, { budget: cfgOf(ctx).inject.situation })
  const scene = mind.situation(homeOf(ctx), { now: ctx.now, parts: got })
  if (on(flags, 'json')) jsonOut(ctx, scene)
  else ctx.out(`${renderScreen(scene)}\n`)
  // 零件自己的坏消息由这一层说清：哪个没答上来、哪个被它的预算挤掉——
  // 它们不在 scene.dropped 里，因为那是"屏上装不下"，这是"根本没拿到"。
  for (const one of got.warnings) ctx.err(one.startsWith('! ') ? `${one}\n` : `! ${one}\n`)
  for (const one of got.dropped) ctx.err(`! 零件 ${one.name} 装不下：抓取预算 ${got.budget} 已经用完\n`)
  for (const one of got.failures) ctx.err(`! 零件 ${one.name} 没出声：${one.why}\n`)
  screenNotes(ctx, scene)
  return 0
}

// 屏外的话：坏行、装不下、配置不对——凡是不在正文里的，一律走 stderr 的 "! "（design §6）。
function screenNotes(ctx, scene) {
  for (const one of scene.warnings ?? []) {
    ctx.err(one.startsWith('! ') ? `${one}\n` : `! ${one}\n`)
  }
  for (const one of scene.dropped ?? []) ctx.err(`! ${one.section} ${one.why}\n`)
  if (scene.over) ctx.err(`! 一屏放不下：用了 ${tenth(scene.used)}/${scene.budget}\n`)
  const bad = scene.bad ?? {}
  noisy(ctx, Object.values(bad).reduce((sum, n) => sum + (Number(n) || 0), 0))
}

// 开口门（design §6/§14.5）：只判不说，台词由宿主决定。
// 说与不说都留账（§14.13）——但 `--peek` 是纯预览：不记账、也不推进"上次开口"，
// 否则看一眼就把唯一一次机会用掉了。`--why` 是"人明确要求此刻就说"，不是替判决编理由。
async function contextCue(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['min-gap', 'why'],
    bools: ['json', 'peek'],
  })
  noWords(words, 'agent-man context cue [--min-gap 6h] [--peek] [--why "<理由>"] [--json]')
  const dir = homeOf(ctx)
  const said = arg(flags, 'why')
  const verdict = mind.gate.judge(dir, {
    now: ctx.now,
    minGap: gapOf(arg(flags, 'min-gap')),
    force: said !== undefined,
  })
  if (on(flags, 'json')) {
    ctx.out(`${JSON.stringify(verdict)}\n`)
  } else if (verdict.say) {
    ctx.out(`可以说：${verdict.why}\n`)
  } else {
    ctx.err(`! 这会儿不说：${verdict.why}\n`)
  }
  if (said !== undefined) {
    ctx.err(`! 人要求此刻就说（--why「${said}」）：静默与最小间隔都没拦\n`)
  }
  const bad = verdict.bad ?? {}
  noisy(ctx, Object.values(bad).reduce((sum, n) => sum + (Number(n) || 0), 0))
  if (on(flags, 'peek')) {
    ctx.err('! peek：这次不记账，也没推进"上次开口"\n')
  } else {
    await mind.gate.commit(dir, verdict)
  }
  return verdict.say ? 0 : 1
}

async function contextDigest(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['budget', 'out'],
    bools: ['json', 'dry-run', 'due'],
  })
  noWords(words, 'agent-man context digest [--budget 1200] [--due] [--out 文件] [--json] [--dry-run]')
  const dry = on(flags, 'dry-run')
  if (on(flags, 'due')) {
    // design §6 有这个开关，digest.build 还不收"只算到期项"：收下却不生效比报错更害人。
    throw new Error('--due 这一版还没接：digest.build 现在每次都算全部候选，不收到期过滤')
  }
  const got = await digest.run({
    home: homeOf(ctx),
    now: ctx.now,
    budget: arg(flags, 'budget') === undefined ? undefined : numberOr(arg(flags, 'budget'), 'budget'),
    out: arg(flags, 'out'),
    write: !dry,
    render: renderDigest,
    say: on(flags, 'json') ? () => {} : (line) => ctx.out(line),
    warn: (line) => ctx.err(line),
  })
  if (on(flags, 'json')) {
    ctx.out(`${JSON.stringify({
      text: got.text,
      wrote: Boolean(got.wrote),
      out: got.out ?? null,
      warnings: got.warnings,
    })}\n`)
    return 0
  }
  if (got.out) ctx.out(`${dry ? '（dry-run，没写）' : '已写到'} ${got.out}\n`)
  return 0
}

// 零件汇总（design §8 的 aggregate 模式）：正文一行一个零件，其余的话都走 stderr。
async function contextSense(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['budget'], bools: ['json'] })
  noWords(words, 'agent-man context sense [--budget N] [--json]')
  const cfg = cfgOf(ctx)
  const budget = arg(flags, 'budget') === undefined
    ? cfg.inject.situation
    : numberOr(arg(flags, 'budget'), 'budget')
  const got = await parts.sense(ctx.env, { budget })
  if (on(flags, 'json')) {
    ctx.out(`${JSON.stringify(got)}\n`)
  } else {
    for (const one of got.lines) {
      ctx.out(`${one.section ? `${one.section}: ` : ''}${one.text}\n`)
    }
    if (got.lines.length === 0) ctx.out('（没有可用的零件：PATH 上放 agent-man-<名字> 就能接进来）\n')
  }
  for (const one of got.warnings) ctx.err(one.startsWith('! ') ? `${one}\n` : `! ${one}\n`)
  if (got.dropped.length > 0) {
    const names = got.dropped.map((one) => one.name).join('、')
    ctx.err(`! 装不下：${names}（预算 ${got.budget} 已经用完）\n`)
  }
  for (const one of got.failures) ctx.err(`! 零件 ${one.name} 没出声：${one.why}\n`)
  return 0
}

// ── 审计 ───────────────────────────────────────────────────────────────────

// trace 记的是"每次摘要怎么裁的"：预算、装下几条、丢了谁、为什么（design §5）。
function auditTrace(ctx) {
  const { words, flags } = split(ctx.rest, { names: ['limit'], bools: ['json'] })
  noWords(words, 'agent-man audit trace [--limit N]')
  const got = audit.trace({ home: homeOf(ctx), now: ctx.now, limit: limitOf(flags) })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    for (const one of got.items) {
      const reasons = one.dropped.map((two) => two.reason).filter(Boolean)
      const tail = reasons.length > 0 ? `（${[...new Set(reasons)].join('、')}）` : ''
      ctx.out(`${dayKey(one.at)} ${rel(one.at, ctx.now)}  用了 ${tenth(one.used)}/${one.budget}` +
        ` · 装下 ${one.kept.length} 条 · 丢 ${one.dropped.length} 条${tail}\n`)
      ctx.out(`  ${one.header}\n`)
    }
    if (got.items.length === 0) {
      ctx.out('（还没有摘要账本：agent-man context digest 会记第一条）\n')
    }
  }
  if (got.items.length < got.total) {
    ctx.err(`! 只列了最近 ${got.items.length} 条，账本一共 ${got.total} 条（--limit 调大看更多）\n`)
  }
  noisy(ctx, got.skipped)
  return 0
}

// timeline 答的是"最近发生了什么"：五类一起按时间排，窗口也一起生效（design §6）。
function auditTimeline(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['limit'],
    bools: ['all', 'json'],
  })
  noWords(words, 'agent-man audit timeline [--limit N] [--all]')
  const got = audit.timeline({
    home: homeOf(ctx),
    now: ctx.now,
    limit: limitOf(flags),
    all: on(flags, 'all'),
  })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else if (got.items.length === 0) {
    ctx.out(`（${got.all ? '' : `最近 ${DEFAULT_WINDOW_DAYS} 天`}什么都没发生；--all 看全部）\n`)
  } else {
    for (const one of got.items) {
      ctx.out(`${record({ id: one.id, when: rel(one.at, ctx.now), text: one.text }, one.kind)}\n`)
    }
  }
  if (got.limit !== null && got.items.length < got.total) {
    ctx.err(`! 只列了最近 ${got.items.length} 条，一共 ${got.total} 条（--limit 调大，或 --all 看全部）\n`)
  }
  noisy(ctx, got.skipped)
  return 0
}

// 孤立结论 = 证据找不到了：那是数据不合格（退 1），不是命令打错。
function auditOrphan(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man audit orphan')
  const got = audit.orphan({ home: homeOf(ctx) })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else if (got.items.length === 0) ctx.out('ok 没有孤立结论：每条结论的证据都还在\n')
  else {
    ctx.out(`${rowsOf(ctx, got.items, 'memory', (one, c) => ({
      id: one.id,
      when: rel(one.at, c.now),
      text: one.fact,
      key: one.key,
    }))}\n`)
    for (const one of got.items) {
      if (one.missing.length > 0) ctx.out(`  ${one.id} 缺证据：${one.missing.join('、')}\n`)
    }
  }
  noisy(ctx, got.skipped)
  if (got.items.length > 0) {
    ctx.err('! 有孤立的结论：证据找不到就不该再当真（memory revise 补证据，或让它自然失效）\n')
    return 1
  }
  return 0
}

// ── 情绪 ───────────────────────────────────────────────────────────────────

// 设计只许印数字、标签、刺激条数（§14.6）：情绪上屏一旦自由发挥，就变成了替她写感受。
const AXIS_LABEL = {
  愉悦: 'v', 精力: 'e', 信任: 't', 尊重: 'r', v: 'v', e: 'e', t: 't', r: 'r',
}

function axisOf(text) {
  const one = AXIS_LABEL[String(text).trim()]
  if (!one) {
    throw new Error(`不认识的轴：「${text}」（只认 愉悦 / 精力 / 信任 / 尊重，或 v / e / t / r）`)
  }
  return one
}

// 标签能不能露，只由配置与 --no-mood 决定；judgement 不看这个开关（design §14.6）。
function moodVisible(ctx, flags) {
  if (on(flags, 'no-mood')) return false
  return cfgOf(ctx).affect.visible !== false
}

function affectLine(snapshot, visible) {
  const numbers = `v=${Math.round(snapshot.v)} e=${Math.round(snapshot.e)} ` +
    `t=${Math.round(snapshot.t)} r=${Math.round(snapshot.r)}`
  const count = `${snapshot.transient.length} 条刺激`
  return visible ? `${numbers} · ${snapshot.mood} · ${count}` : `${numbers} · ${count}`
}

function affectShow(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json', 'no-mood'] })
  noWords(words, 'agent-man affect show [--json] [--no-mood]')
  const snapshot = affect.snapshot(homeOf(ctx), { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, snapshot)
  else ctx.out(`${affectLine(snapshot, moodVisible(ctx, flags))}\n`)
  noisy(ctx, snapshot.skipped, '情绪日志')
  return 0
}

async function affectSet(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['for', 'until', 'why', 'at'],
    bools: ['json'],
  })
  const [label, value] = words
  if (label === undefined || value === undefined || words.length > 2) {
    throw new Error('用法：agent-man affect set <愉悦|精力|信任|尊重> <数值> --why "<为什么>" [--for 2h]')
  }
  const got = await affect.set(homeOf(ctx), {
    axis: axisOf(label),
    value: Number(value),
    why: arg(flags, 'why'),
    until: instant(ctx, arg(flags, 'until') ?? arg(flags, 'for'), 'for'),
    at: ctx.now,
  })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else ctx.out(`已记下 ${got.item.id}  ${affectLine(got.snapshot, moodVisible(ctx, flags))}\n`)
  landed(ctx, got)
  return 0
}

async function affectClear(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json'] })
  noWords(words, 'agent-man affect clear')
  const got = await affect.clear(homeOf(ctx), { at: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else {
    ctx.out(`已撤掉手动覆盖  ${affectLine(got.snapshot, moodVisible(ctx, flags))}\n`)
  }
  landed(ctx, got)
  return 0
}

// why 才说理由：算术过程、峰值、标签为什么换，都在这里（design §14.11 / §14.14）。
function affectWhy(ctx) {
  const { words, flags } = split(ctx.rest, { bools: ['json', 'no-mood'] })
  noWords(words, 'agent-man affect why [--json] [--no-mood]')
  const snapshot = affect.snapshot(homeOf(ctx), { now: ctx.now })
  if (on(flags, 'json')) jsonOut(ctx, snapshot)
  else {
    ctx.out(`${affectLine(snapshot, moodVisible(ctx, flags))}\n`)
    for (const one of snapshot.why) ctx.out(`  ${one}\n`)
    if (snapshot.by === 'manual' && Number.isFinite(snapshot.until)) {
      ctx.out(`  手动覆盖到 ${rel(snapshot.until, ctx.now)}（agent-man affect clear 撤掉）\n`)
    }
  }
  noisy(ctx, snapshot.skipped, '情绪日志')
  return 0
}

async function affectStim(ctx) {
  const { words, flags } = split(ctx.rest, {
    names: ['why', 'imp', 'at'],
    bools: ['json'],
  })
  const [kind, ...rest] = words
  if (!kind) throw new Error(`用法：agent-man affect stim <kind> --why "…"（kind 只认 ${affect.KINDS.join(' / ')}）`)
  if (rest.length > 0) throw new Error(`不认识的用法：「${rest.join(' ')}」（stim 只收一个 kind）`)
  if (arg(flags, 'imp') !== undefined) {
    // 权重由 kind 定（§14.7）：收下 --imp 却不改权重，等于让人以为调过了。
    throw new Error('刺激的权重由 kind 定，--imp 不收（见 design §14.7）')
  }
  const got = await affect.stim(homeOf(ctx), {
    kind,
    why: arg(flags, 'why'),
    at: instant(ctx, arg(flags, 'at'), 'at') ?? ctx.now,
  })
  if (on(flags, 'json')) jsonOut(ctx, got)
  else ctx.out(`已记下 ${got.item.id}  ${kind}（权重 ${got.weight}）\n`)
  if (got.ignored > 0) {
    ctx.err(`! ${got.ignored} 条同类刺激超额未计（每小时最多 ${AFFECT_STIM_PER_HOUR} 次）\n`)
  }
  landed(ctx, got)
  return 0
}

// ── 灵魂（design §13） ─────────────────────────────────────────────────────

// 灵魂：ls / use / show / check / import。卡怎么解析、怎么装进预算都在 src/soul，
// 这里只把结果排成屏。退出码：说不清就是 2；"卡不成立"也是 2（那不是成功，只是有话说）。
async function soul(ctx) {
  const args = ctx.argv.slice(1)
  const sub = args[0]
  const argOne = args[1]
  const dir = homeOf(ctx)
  try {
    if (sub === 'ls') return soulLs(ctx, dir)
    if (sub === 'use') return await soulUse(ctx, dir, argOne)
    if (sub === 'show') return soulShow(ctx, dir, argOne)
    if (sub === 'check') return soulCheck(ctx, dir, argOne)
    if (sub === 'import') return await soulImport(ctx, dir, argOne)
  } catch (e) {
    ctx.err(`! ${e && e.message ? e.message : e}\n`)
    return 2
  }
  ctx.err('! 用法：agent-man soul ls | use <名字> | show [名字] | check [名字] | import <卡文件.json>\n')
  return 2
}

function soulLs(ctx, dir) {
  const items = soulCards.list(dir)
  const now = soulCards.current(dir)
  if (items.length === 0) {
    ctx.out('（还没有灵魂卡：agent-man soul import <卡文件.json>）\n')
    return 0
  }
  for (const one of items) {
    ctx.out(`${one.name === now.name ? '*' : ' '} ${one.name}  ${one.size} B\n`)
  }
  const note = now.by === 'builtin' ? '（内置，没有卡）' : ''
  ctx.out(`当前：${now.name}${note}\n`)
  return 0
}

async function soulUse(ctx, dir, name) {
  if (!name) {
    ctx.err('! 用法：agent-man soul use <名字>\n')
    return 2
  }
  const rec = await soulCards.use(dir, name, { at: ctx.now, by: 'cli' })
  ctx.out(`已切到 ${rec.name}（记忆与事件一个字节没动）\n`)
  return 0
}

// 名字缺省就取当前那张；一张卡都没导入过时 pickName 会把人引到 import，
// 而不是打"没有这个灵魂：default"。
function soulShow(ctx, dir, name) {
  const wanted = pickName(ctx, dir, name)
  if (wanted === null) return 2
  const view = soulCards.build(dir, { name: wanted })
  const k = view.knobs
  ctx.out(`灵魂：${wanted}  旋钮 warm ${sign(k.warm)} / drive ${sign(k.drive)} / sharp ${sign(k.sharp)}\n`)
  ctx.out(`注入 ${tenth(view.used)}/${tenth(view.cost)}：\n`)
  for (const line of view.lines) ctx.out(`  ${line}\n`)
  if (view.dropped.length > 0) {
    ctx.out(`装不下 ${view.dropped.length} 段（槽位与总预算 ${view.cost}）：\n`)
    for (const one of view.dropped) ctx.out(`  ${one.file} ${one.section}\n`)
  }
  if (view.inferred.length > 0) {
    ctx.out(`~ ${view.inferred.length} 处推断：改前先跟人确认（docs/soul-card.md 的规矩）\n`)
  }
  return 0
}

function soulCheck(ctx, dir, name) {
  const wanted = pickName(ctx, dir, name)
  if (wanted === null) return 2
  const result = soulCards.check(dir, wanted)
  for (const one of result.errors) ctx.err(`! ${one}\n`)
  for (const one of result.warnings) ctx.err(one.startsWith('! ') ? `${one}\n` : `! ${one}\n`)
  if (result.inferred.length > 0) {
    ctx.out(`~ ${result.inferred.length} 处推断待确认（soul show 里带 ~ 的段）\n`)
  }
  if (!result.ok) {
    ctx.err(`! 这张卡还不成立（${result.errors.length} 处）：按上面的提示改\n`)
    return 2
  }
  ctx.out(`ok ${wanted}\n`)
  return 0
}

async function soulImport(ctx, dir, file) {
  if (!file) {
    ctx.err('! 用法：agent-man soul import <卡文件.json（角色卡规范 V2 或 V1）>\n')
    return 2
  }
  const result = await soulCards.importCard(dir, file)
  ctx.out(`已导入 ${result.name}（${result.files.length} 个文件，往事 ${result.lore} 条）\n`)
  if (result.source) ctx.out(`来源：${result.source}\n`)
  ctx.out(`下一步：agent-man soul check ${result.name}\n`)
  return 0
}

// 写了却没落盘（磁盘满、权限、坏扇区）：这正是"静默丢弃"要防的事，必须说出口。
function landed(ctx, got) {
  if (got && got.saved && got.saved.saved === false) {
    ctx.err(`! 没落盘：${got.saved.why ?? '写不进去'}\n`)
  }
}

function sign(value) {
  const n = Number.isFinite(value) ? value : 0
  return n > 0 ? `+${n}` : String(n)
}

// 预算按一位小数上屏：`cost()` 是浮点累加，156.08000000000004 这种尾巴只该留在账本里。
function tenth(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
}

// 没说名字就取当前那张。当前是内置 default（还没 import 过任何卡）时别拿"没有这个灵魂：default"
// 糊人——那句话像是卡被人删了，实际是"你还没导入过"。
function pickName(ctx, dir, name) {
  if (name) return name
  const now = soulCards.current(dir)
  if (now.by === 'builtin') {
    ctx.err('! 还没有灵魂卡：agent-man soul import <卡文件.json>\n')
    return null
  }
  return now.name
}
