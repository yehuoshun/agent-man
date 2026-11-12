import path from 'node:path'
import {
  parseAt,
  dayStartFromEnv,
  stamp,
  daySpan,
  dayRange,
  clock,
  relTime,
  relWhen,
} from './time.mjs'
import { cost } from './cost.mjs'
import {
  resolveHome,
  appendEvent,
  readEvents,
  readMemory,
  appendMemory,
  writeAtomic,
  readConsolidation,
  writeConsolidation,
  appendTrace,
  readTraces,
  readCue,
  writeCue,
  readHandoff,
  appendHandoff,
  readPlace,
  writePlace,
  readSky,
  writeSky,
  readPlan,
  appendPlan,
} from './store.mjs'
import { makeItem, activeItems, longLine, TIERS } from './memory.mjs'
import { backlog, owed, owedCount, BACKLOG_COUNT, BACKLOG_COST } from './consolidate.mjs'
import { renderDigest } from './render.mjs'
import { buildTrace, neverShown, traceLine } from './trace.mjs'
import { cue, MIN_GAP, describeQuiet } from './when.mjs'
import { makeNote, pendingNotes } from './handoff.mjs'
import { makePlan, pendingPlans, upcoming, todayPlans } from './plan.mjs'
import { judgeSky, STALE_MS } from './sky.mjs'
import * as defaultNet from './net.mjs'

const VERSION = '0.1.0'
const DUP_WINDOW = 24 * 3600e3

const HELP = `agent-man ${VERSION} — 给 agent 一个会话之外的生活

用法：
  agent-man log <记的事> [选项]      记一条日记（原文，只追加）
  agent-man remember <结论> [选项]   记一条长期记忆（模型整理出来的）
  agent-man recall [选项]            看长期记忆
  agent-man digest [选项]            渲染当前摘要
  agent-man ls [--limit 20]          看原始事件
  agent-man find <词> [选项]         在日记原文里搜（摘要只压不取，原文在这）
  agent-man trace [选项]             看每次 digest 装下了什么、丢了什么
  agent-man cue [选项]               这会儿该不该开口（给处境，不给台词）
  agent-man show <主题|id> [选项]    顺着一条结论找回原文（refs 指向的日子）
  agent-man leave <便条> --when <场合>  给下一次的自己留一句（cue 递出，看过就烧）
  agent-man place <城市>             记下你在哪儿（查一次坐标，以后不再问）
  agent-man sky [选项]               外面什么样、跟上次比变了什么
  agent-man plan [选项]              接下来的安排；带一句话就是新加一条
  agent-man --help

log 选项：
  --kind dm|qq|video|note   来源，默认 note
  --weight 0..3             重要度，>=2 进"不会忘的"
  --feel <感受>             附着在这件事上的感觉
  --at <时间>               默认现在；接受 ISO / epoch / "2026-11-05 12:45"
  --src <出处>              原始文件或会话
  --fact <文本>             等价于位置参数，给不方便传位置参数的调用方

remember 选项：
  --topic <主题>            必填，例：她怕冷
  --tier 0|1|2              0 近期（默认）/ 1 中期 / 2 永久
  --refs <a,b>              必填：指向原文的日期或时间
  --no-refs                 确实没有出处时才用
  --supersedes <id,id>      这条取代了哪些旧条目
  --batch <标签>            哪次整理写的，默认当天；周记 2026-W45
  --span-from/--span-to     覆盖范围，默认等于 --at
  --weight 0..3
  --id <id>                 默认按日期发号
  --fact <文本>             等价于位置参数

recall 选项：
  --tier 0|1|2              只看某一档
  --batch <标签>            只看某次整理
  --grep <词>               主题或结论里含这个词
  --limit 20

digest 选项：
  --due                     只报欠了几次巩固（日结/周结/按量），不渲染摘要
  --budget 1200             总预算，含标题与注释行（不是字符数，见 src/cost.mjs）
  --out <文件>              写到文件（原子写），默认打到 stdout
  --title <标题>            第一行标题

trace 选项：
  --limit 10                最近几次 digest
  --never                   反过来：哪些日记从来没进过摘要

find 选项：
  --since <时间>            从这时起；只写日期（2026-11-05）按本地整天算
  --until <时间>            到这时为止，含端点
  --kind dm|qq|video|note   只看某一类来源
  --limit 20                最多列几条，取最近的

cue 选项：
  --min-gap 6               至少隔几小时才再叫人，默认 6
  --force                   无视间隔与静默时段（手动问的时候用）
  --peek                    只看一眼，不记水位（下次还会报同样的东西）
  --limit 10                最多列几条新东西

leave 选项：
  --when <场合>             什么时候该看（必填，例：她提到加班时）
  --ttl 7                   活几天，过期作废
  --at <时间>               留这张的时刻（默认现在）

show 选项：
  --limit 20                每个出处最多列几条原文
  --fact <文本>             等价于位置参数

sky 选项：
  --fresh                   这次一定重新取数（不吃半小时内的缓存）
  --force                   连"和上次说的一样"也不管，这次一定说

plan 选项：
  --at <时间>               新安排的什么时候（加一条时必填）
  --days 7                  列表看几天
  --done <id>               划掉某条（id 见 agent-man plan）

环境变量：
  AGENT_MAN_HOME            数据目录，默认 ~/.agent-man
  AGENT_MAN_DAY_START       日界小时数 0..23，默认 0`

/**
 * 每个命令认哪些选项。表外的名字一律报错——认不认识一个名字是确定性的判断，
 * 不需要模型在场，也不该靠猜（见 docs/decisions.md#16）。
 *
 * value：后面必须跟值的；bool：开关，只接受裸用或 =true / =false。
 * 加选项要同时改这里、`HELP` 和 README——有一条用例对着 HELP 核这张表。
 */
export const FLAGS = {
  log: { value: ['at', 'weight', 'kind', 'feel', 'src', 'fact'], bool: [] },
  remember: {
    value: [
      'topic',
      'fact',
      'tier',
      'batch',
      'refs',
      'supersedes',
      'span-from',
      'span-to',
      'weight',
      'id',
      'at',
    ],
    bool: ['no-refs'],
  },
  recall: { value: ['limit', 'tier', 'batch', 'grep'], bool: [] },
  digest: { value: ['budget', 'out', 'title'], bool: ['due'] },
  ls: { value: ['limit'], bool: [] },
  find: { value: ['since', 'until', 'kind', 'limit'], bool: [] },
  trace: { value: ['limit'], bool: ['never'] },
  cue: { value: ['limit', 'min-gap'], bool: ['peek', 'force'] },
  show: { value: ['limit', 'fact'], bool: [] },
  leave: { value: ['when', 'ttl', 'at'], bool: [] },
  place: { value: [], bool: [] },
  sky: { value: [], bool: ['fresh', 'force'] },
  plan: { value: ['at', 'days', 'done'], bool: [] },
}

/** 不吃位置参数的命令：多出来的词没人会看见，那就不许它静默落在地上。 */
const NO_POS = new Set(['recall', 'digest', 'ls', 'trace', 'cue', 'sky'])

/** 用法错误（解析层就拦下的）单独标一下：它和"要记的事是空的"不是一类，退出码也不同。 */
function usage(msg) {
  const e = new Error(msg)
  e.usage = true
  return e
}

function boolValue(key, raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw usage(`--${key} 是开关，只接受 true / false，收到 ${raw}`)
}

/** 差一个字母才给提示：差得远就是另一个词，猜错了比不猜更烦人。 */
function nearMiss(key, known) {
  let best = null
  let bestD = 3
  for (const k of known) {
    const d = distance(key, k)
    if (d < bestD) {
      best = k
      bestD = d
    }
  }
  return best
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, sub)
    }
    prev = cur
  }
  return prev[b.length]
}

function checkKnown(cmd, spec, key) {
  if (key === 'help') return // 每个命令都能问怎么用
  const known = [...spec.value, ...spec.bool]
  if (known.includes(key)) return
  const near = nearMiss(key, known)
  const list = [...known, 'help'].map((k) => `--${k}`).join(' ')
  throw usage(`未知选项 --${key}${near ? `；是不是想写 --${near}？` : ''}\n${cmd} 只认：${list}`)
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const spec = FLAGS[cmd]
  const flags = {}
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--') {
      pos.push(...rest.slice(i + 1))
      break
    }
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const key = eq > 2 ? a.slice(2, eq) : a.slice(2)
    const inline = eq > 2 ? a.slice(eq + 1) : undefined
    if (spec) checkKnown(cmd, spec, key)
    if (inline === '') throw usage(`选项 --${key} 需要值`)
    // 开关不吃后面的词：`--due 备注` 里的"备注"是位置参数，不是 --due 的值。
    const isBool = spec?.bool.includes(key) || key === 'help'
    if (isBool) {
      flags[key] = inline === undefined ? true : boolValue(key, inline)
      continue
    }
    if (inline !== undefined) {
      flags[key] = inline
      continue
    }
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
      continue
    }
    if (spec) throw usage(`选项 --${key} 需要值`)
    flags[key] = true
  }
  if (spec && NO_POS.has(cmd) && pos.length) {
    throw usage(`多余的位置参数：${pos.join(' ')}（${cmd} 只吃选项）`)
  }
  return { cmd, pos, flags }
}

export function main(argv = process.argv.slice(2), ctx = {}) {
  const { env = process.env, out = console, now = Date.now(), net = defaultNet } = ctx
  try {
    // 解析也在 try 里：选项名写错要像命令名写错一样"喊出来"，而不是抛栈。
    const { cmd, pos, flags } = parseArgs(argv)

    if (!cmd || cmd === 'help' || flags.help) {
      out.log(HELP)
      return 0
    }
    if (cmd === '--help' || cmd === '-h') {
      out.log(HELP)
      return 0
    }
    if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
      out.log(VERSION)
      return 0
    }

    const home = resolveHome(env)
    if (cmd === 'log') return cmdLog(home, pos, flags, { out, now })
    if (cmd === 'remember') return cmdRemember(home, pos, flags, { out, now })
    if (cmd === 'recall') return cmdRecall(home, flags, { out })
    if (cmd === 'digest') return cmdDigest(home, flags, { out, now, env })
    if (cmd === 'ls') return cmdLs(home, flags, { out })
    if (cmd === 'find') return cmdFind(home, pos, flags, { out, env })
    if (cmd === 'trace') return cmdTrace(home, flags, { out })
    if (cmd === 'cue') return cmdCue(home, flags, { out, now, env })
    if (cmd === 'show') return cmdShow(home, pos, flags, { out, env })
    if (cmd === 'leave') return cmdLeave(home, pos, flags, { out, now })
    if (cmd === 'place') return guarded(cmdPlace(home, pos, flags, { out, net }), out)
    if (cmd === 'sky') return guarded(cmdSky(home, flags, { out, now, net, env }), out)
    if (cmd === 'plan') return cmdPlan(home, pos, flags, { out, now, env })
    out.error(`未知命令: ${cmd}\n\n${HELP}`)
    return 2
  } catch (e) {
    out.error(`! ${e.message}`)
    return e.usage ? 2 : 1
  }
}

function cmdLog(home, pos, flags, { out, now }) {
  const fact = (pos.join(' ') || String(flags.fact ?? '')).trim()
  if (!fact) throw new Error('要记什么？例：agent-man log "今天风大，她把窗关上了" --weight 2')

  const at = parseAt(flags.at, { now })
  const w = Number(flags.weight ?? 0)
  if (!Number.isInteger(w) || w < 0 || w > 3) throw new Error(`--weight 只能是 0..3，收到 ${flags.weight}`)

  const ev = { at, kind: String(flags.kind ?? 'note'), fact }
  if (w) ev.weight = w
  if (flags.feel) ev.feel = String(flags.feel)
  if (flags.src) ev.src = String(flags.src)

  // 流水账的通病是重复。这里不拦，只提醒——判断权仍然在用的人手里。
  const dup = findDup(home, ev, now)
  appendEvent(home, ev)

  out.log(`${stamp(at)}${w ? ` w${w}` : ''} +${cost(fact)}  ${fact}`)
  if (dup) out.error(`! 24 小时内记过一模一样的一条（${stamp(dup.at)}）；要合并就自己删旧的`)
  return 0
}

function findDup(home, ev, now) {
  const { events } = readEvents(home, { since: now - DUP_WINDOW })
  return events.find((e) => e.kind === ev.kind && e.fact === ev.fact) ?? null
}

/**
 * 记一条长期记忆。
 *
 * 这个命令不总结、不合并：结论是调用方（模型）给的，这里只负责校验、
 * 发号、落盘。合并用 --supersedes 指过去，旧行不动（见 docs/decisions.md#11）。
 */
function cmdRemember(home, pos, flags, { out, now }) {
  const fact = (pos.join(' ') || String(flags.fact ?? '')).trim()
  if (!fact) {
    throw new Error('要记住什么？例：agent-man remember "入秋后先关窗再抱怨风" --topic 她怕冷 --refs 2026-11-05')
  }

  const { items } = readMemory(home)
  const item = makeItem(
    {
      topic: flags.topic,
      fact,
      tier: flags.tier,
      batch: flags.batch,
      refs: flags.refs,
      noRefs: Boolean(flags['no-refs']),
      supersedes: flags.supersedes,
      from: flags['span-from'],
      to: flags['span-to'],
      weight: flags.weight,
      id: flags.id,
      at: flags.at,
    },
    { now, existing: items },
  )
  appendMemory(home, item)

  // 结账：remember 就是"把日记整理成长期条目"的那一次动作，成功了才记账（§15）。
  // 上面任何一步抛错都走不到这里——校验不过的条目不配清账。
  const settled = settle(home, now)

  out.log(`${item.id}  tier${item.tier}  ${longLine(item)}`)
  if (item.refs.length) out.log(`  出处: ${item.refs.join(', ')}`)
  if (item.supersedes.length) out.log(`  取代: ${item.supersedes.join(', ')}`)
  out.log(`  结账: 清了 ${settled} 条日记`)
  return 0
}

/** 把"截至 now 的积压"记为已结，返回这次清掉的条数。 */
function settle(home, now) {
  const { events } = readEvents(home)
  const prev = readConsolidation(home)
  const cleared = backlog(events, prev?.at ?? -Infinity).count
  writeConsolidation(home, { at: now, settled: cleared })
  return cleared
}

function cmdRecall(home, flags, { out }) {
  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const tier = flags.tier === undefined ? null : Number(flags.tier)
  if (tier !== null && !TIERS.includes(tier)) throw new Error(`--tier 只能是 0/1/2，收到 ${flags.tier}`)
  const batch = flags.batch === undefined ? null : String(flags.batch)
  const grep = flags.grep === undefined ? null : String(flags.grep)

  const { items, bad } = readMemory(home)
  const live = activeItems(items)
  const dead = items.length - live.length
  const hit = live.filter(
    (it) =>
      (tier === null || (it.tier ?? 0) === tier) &&
      (batch === null || it.batch === batch) &&
      (grep === null || `${it.topic}${it.fact}`.includes(grep)),
  )
  const tail = hit.slice(-limit)

  out.log(`${live.length} 条有效长期记忆${dead ? `（另有 ${dead} 条已被取代）` : ''}，显示 ${tail.length} 条`)
  for (const it of tail) {
    out.log(`${it.id}  tier${it.tier ?? 0}  ${longLine(it)}  refs: ${it.refs?.join(',') || '—'}`)
  }
  if (bad) out.error(`! ${bad} 行读不出来`)
  return 0
}

function cmdDigest(home, flags, { out, now, env }) {
  if (flags.due) return reportDue(home, { out, now, env })

  const budget = Number(flags.budget ?? 1200)
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget 必须是正数，收到 ${flags.budget}`)
  const dayStart = dayStartFromEnv(env)

  const { events, bad } = readEvents(home)
  const { items, bad: badLong } = readMemory(home)
  const { text, stats } = renderDigest(
    { events, memory: items },
    { budget, now, title: flags.title ?? '我记得的事', dayStart },
  )

  if (typeof flags.out === 'string') {
    const target = path.resolve(flags.out)
    writeAtomic(target, text)
    out.log(
      `写好了: ${target}  （日记 ${stats.kept}/${stats.total}，长期 ${stats.longKept}/${stats.longTotal}，` +
        `占 ${stats.used}/${stats.budget}）`,
    )
  } else {
    out.log(text.trimEnd())
  }

  if (bad) out.error(`! ${bad} 行日记读不出来，已跳过`)
  if (badLong) out.error(`! ${badLong} 行长期记忆读不出来，已跳过`)
  reportDrops(stats, out)
  reportLongDrops(stats, out)
  // 落账放在最后：中途抛错（比如 --out 写不进去）说明这份摘要没人用上，不该记账。
  appendTrace(home, buildTrace(stats, { now }))
  return 0
}

/**
 * `--due` 只摊账，不渲染摘要，也不拦人：结不结账由模型决定（§15）。
 *
 * 出口永远是 0——欠账是常态，不是错误。要让调用方判断"该不该动手"，
 * 读第一行的次数就够了。
 */
function reportDue(home, { out, now, env }) {
  const dayStart = dayStartFromEnv(env)
  const { events, bad } = readEvents(home)
  const prev = readConsolidation(home)
  const d = owed(events, { basis: prev?.at ?? null, now, dayStart })
  const n = owedCount(d)
  const pile = d.backlog

  if (!n) {
    out.log(`没有欠账：${settledWhere(d)}，积压 ${pile.count} 条 / ${pile.cost} 代价`)
  } else {
    out.log(`欠 ${n} 次巩固：`)
    if (d.days) out.log(`  · 日结 ${d.days} 次（${settledWhere(d)}）`)
    if (d.weeks) out.log(`  · 周结 ${d.weeks} 次（${settledWhere(d, d.fromWeek)}）`)
    if (d.over) {
      out.log(
        `  · 按量：积压 ${pile.count} 条 / ${pile.cost} 代价` +
          `（≥${BACKLOG_COUNT} 条或 ≥${BACKLOG_COST} 代价就该结）`,
      )
    }
  }
  if (bad) out.error(`! ${bad} 行日记读不出来，已跳过`)
  return 0
}

/** 结账基准的说法：从来没有记录时不能说"上次结到第一条日记那天"，那是两件事。 */
function settledWhere(d, key = d.fromDay) {
  if (d.from === null) return '一条日记都还没有'
  if (!d.settled) return `从第一条日记 ${key} 起就没结过`
  return `上次结到 ${key}`
}

function reportDrops(stats, out) {
  const gone = stats.drops.filter((d) => d.why === 'no-room')
  if (!gone.length) return

  out.error(`! 预算不够，丢了 ${gone.length} 条：`)
  for (const d of gone.slice(0, 10)) {
    out.error(`    ${stamp(d.at)}  w${d.weight ?? 0}  ${d.fact}`)
  }
  if (gone.length > 10) out.error(`    ……（还有 ${gone.length - 10} 条）`)

  // w3 是最不该静默消失的：参考实现正是把它丢得无声无息
  if (gone.some((d) => (d.weight ?? 0) >= 3)) {
    out.error('!! 里面有 weight=3 的记录被丢了。要么加 --budget，要么承认这条不在"永久"档。')
  }
}

/** 长期层被挤掉也要说：它本该比日记层更"永久"。 */
function reportLongDrops(stats, out) {
  const gone = stats.longDrops ?? []
  if (!gone.length) return
  out.error(`! 长期层没装下 ${gone.length} 条：`)
  for (const d of gone.slice(0, 5)) out.error(`    ${d.id}  ${d.topic}：${d.fact}`)
  if (gone.length > 5) out.error(`    ……（还有 ${gone.length - 5} 条）`)
}

/**
 * 找原文。
 *
 * `digest` 只压不取（§9 的老账）：它把日记压成几行，但"那件事当时到底怎么说的"
 * 只有原文答得上来。这里不排相关性、不做摘要，只回答"哪条、什么时候、原话是什么"。
 * 也不搜长期层——结论用 `recall --grep`，原文用这个；两个入口各管一层，别混。
 *
 * 匹配就是 `includes`，和 `recall --grep` 一致：脚本不猜"这个字算不算同一个意思"。
 */
function cmdFind(home, pos, flags, { out, env }) {
  const term = pos.join(' ').trim()
  if (!term) throw new Error('要找什么？例：agent-man find 窗 --since 2026-11-01')

  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const dayStart = dayStartFromEnv(env)
  const since = flags.since === undefined ? null : daySpan(flags.since, { dayStart })
  const until = flags.until === undefined ? null : daySpan(flags.until, { dayStart })
  const kind = flags.kind === undefined ? null : String(flags.kind)

  const { events, bad } = readEvents(home)
  const hit = events.filter(
    (e) =>
      `${e.fact}${e.feel ?? ''}`.includes(term) &&
      (!since || e.at >= since.from) &&
      // 只写日期时到当天最后一毫秒；写的是具体时刻就含端点——两种写法都该"包含自己写的那一刻"
      (!until || e.at <= (until.whole ? until.to - 1 : until.to)) &&
      (!kind || e.kind === kind),
  )
  const tail = hit.slice(-limit)
  const where = describeFind(flags)

  out.log(
    hit.length
      ? `${events.length} 条日记里，含“${term}”的 ${hit.length} 条${where}，显示最近 ${tail.length} 条`
      : `${events.length} 条日记里没有含“${term}”的${where}`,
  )
  for (const e of tail) out.log(`${stamp(e.at)}${e.weight ? ` w${e.weight}` : ''}  ${eventLine(e)}`)
  if (hit.length > limit) out.log(`……（只列最近 ${limit} 条，--limit 可调）`)
  if (bad) out.error(`! ${bad} 行日记读不出来，已跳过`)
  return 0
}

/** 回显用户自己写的筛选条件：重排成 `2026-11-05T00:00:00+08:00` 只会让人对不上自己敲的字。 */
function describeFind(flags) {
  const parts = []
  if (flags.since !== undefined) parts.push(`从 ${flags.since}`)
  if (flags.until !== undefined) parts.push(`到 ${flags.until}`)
  if (flags.kind !== undefined) parts.push(`kind=${flags.kind}`)
  return parts.length ? `（${parts.join('，')}）` : ''
}

function eventLine(e) {
  const feel = e.feel ? `（${e.feel}）` : ''
  return `[${e.kind}]  ${e.fact}${feel}`
}

function cmdLs(home, flags, { out }) {
  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const { events, bad } = readEvents(home)
  const tail = events.slice(-limit)
  out.log(`${events.length} 条（显示最近 ${tail.length} 条）`)
  for (const e of tail) out.log(`${stamp(e.at)}${e.weight ? ` w${e.weight}` : ''}  ${eventLine(e)}`)
  if (bad) out.error(`! ${bad} 行读不出来`)
  return 0
}

/**
 * 留一张便条给"下一次的自己"。
 *
 * 为什么不用 log：日记记的是"发生过什么"，把自己的备忘混进去会把事实搞脏。
 * 为什么不用 remember：长期层是"我认定的事"，有效期是永远，用完还得记得 supersedes——
 * 忘了就是永久生效，比忘了便利贴危险得多。便条是这两层都装不下的那类话。
 */
function cmdLeave(home, pos, flags, { out, now }) {
  const text = pos.join(' ').trim()
  const { records } = readHandoff(home)
  const note = makeNote({ ...flags, text }, { now, existing: records })
  appendHandoff(home, note)
  out.log(`留好了 ${note.id}：${note.text}`)
  out.log(`  说的时候：${note.when}`)
  const days = Math.round((note.until - note.at) / (24 * 3600e3))
  out.log(`  留 ${days} 天，到 ${stamp(note.until).slice(0, 10)} 为止；递出一次就烧掉`)
  return 0
}
/**
 * 顺着一条结论找回原文。
 *
 * 长期层的 refs 一直只是显示出来（`recall` 尾巴上的 `refs: 2026-11-05`），没有入口能跳回
 * 那天的日记——§11 说"refs 必须能回溯"，在此之前它只能靠人手敲 `find --since`。
 * 这里只做索引：结论 → refs → 那几天的原文，一个字都不改写。
 */
function cmdShow(home, pos, flags, { out, env }) {
  const term = String(pos[0] ?? flags.fact ?? '').trim()
  if (!term) throw new Error('要给个词：show <主题或 id>；只搜原文用 find')
  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)
  }

  const dayStart = dayStartFromEnv(env)
  const { items, bad } = readMemory(home)
  const live = activeItems(items)
  const hit = live.filter((it) => it.id === term || `${it.topic}${it.fact}`.includes(term))
  if (bad) out.error(`! ${bad} 行长期记忆读不出来`)
  if (!hit.length) {
    out.log(`长期层里没有含“${term}”的结论。show 只顺着结论找出处，原文用 find ${term}`)
    return 0
  }

  const { events, bad: badEvents } = readEvents(home)
  if (badEvents) out.error(`! ${badEvents} 行日记读不出来，已跳过`)

  hit.forEach((it, i) => {
    if (i) out.log('')
    out.log(`${it.id}  tier${it.tier ?? 0}  ${longLine(it, { dayStart })}`)
    const refs = (it.refs ?? []).filter((r) => typeof r === 'string' && r.trim())
    if (!refs.length) {
      out.log('  出处：没写（存的时候用了 --no-refs）')
      return
    }
    out.log(`  出处 ${refs.length} 处：`)
    for (const ref of refs) {
      const range = refRange(ref, { dayStart })
      const found = events.filter((e) => e.at >= range.from && e.at < range.to)
      if (!found.length) {
        out.log(`  · ${ref}：那天没有日记`)
        continue
      }
      for (const e of found.slice(0, limit)) {
        const w = e.weight ? ` w${e.weight}` : ''
        out.log(`  ${stamp(e.at)}${w}  ${eventLine(e)}`)
      }
      if (found.length > limit) out.log(`  ……（${ref} 共 ${found.length} 条，只列 ${limit} 条）`)
    }
  })
  return 0
}

/**
 * refs 里的一条怎么变成时间区间：纯日期按本地整天算，写了时刻的按它所在的那一天算。
 * 只用 `daySpan` / `parseAt`，不自己 `new Date(str)`——日期字符串的解析只有一处（§二.3）。
 */
function refRange(ref, { dayStart }) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) return daySpan(ref, { dayStart })
  return dayRange(parseAt(ref), { dayStart })
}
/**
 * 定时候：问一句"这会儿该不该开口"。
 *
 * 只给处境：几点了、上次开口是什么时候、这之后攒了什么。说不说、说什么，
 * 仍然是模型自己的判断（AGENTS.md §一：只存不说、给处境不给台词）。
 *
 * 开口之后把水位记下来——同一条日记不会被反复端上来，这就是"降噪"。
 * 水位记的是"交给模型看过"，不是"对用户说过"：有没有真说出口，脚本无从
 * 知道，也不该假装知道（§21 的代价）。
 */
function cmdCue(home, flags, { out, now, env }) {
  const limit = Number(flags.limit ?? 10)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)
  }

  const minGap = flags['min-gap'] === undefined ? MIN_GAP : Number(flags['min-gap']) * 3600e3
  if (!Number.isFinite(minGap) || minGap < 0) {
    throw new Error(`--min-gap 是小时数，收到 ${flags['min-gap']}`)
  }

  const dayStart = dayStartFromEnv(env)
  const { events, bad } = readEvents(home)
  const { records, bad: badNotes } = readHandoff(home)
  const { pending, expired } = pendingNotes(records, { now })
  // 日程只是处境，不是开口的理由：它没有"说过了"的水位，硬当理由会每 6 小时念同一条。
  const { records: planRecs, bad: badPlan } = readPlan(home)
  const today = todayPlans(planRecs, { now, dayStart })
  const lastCue = readCue(home)
  const r = cue({ events, notes: pending, lastCue, now, minGap })
  if (bad) out.error(`! ${bad} 行日记读不出来，已跳过`)
  if (badNotes) out.error(`! ${badNotes} 行便条读不出来，已跳过`)
  if (badPlan) out.error(`! ${badPlan} 行日程读不出来，已跳过`)

  if (!r.speak && !flags.force) {
    // 不打扰也要交代过期作废的那几张：静默丢弃比多一行更糟。
    const dead = expired.length ? `；另有 ${expired.length} 张便条过期作废` : ''
    const planTail = today.length ? `；今天还有 ${today.length} 条安排` : ''
    out.log(`这会儿 ${clock(now)}，不打扰：${r.reasons.join('；')}${dead}${planTail}`)
    if (!flags.peek) for (const n of expired) appendHandoff(home, { op: 'drop', id: n.id, at: now })
    return 0
  }
  if (!r.fresh.length && !r.notes.length) {
    const quietTail = r.quiet ? `（${describeQuiet()} 静默时段，本来也不叫人）` : ''
    const planTail = today.length ? `（今天还有 ${today.length} 条安排）` : ''
    out.log(`这会儿 ${clock(now)}，没有新东西${quietTail}${planTail}`)
    return 0
  }

  out.log(`这会儿 ${clock(now)}。`)
  out.log(lastCue ? `上次开口 ${relTime(lastCue.lastAt, { now })}。` : '你还没在这儿开过口。')
  if (r.fresh.length) {
    const tail = r.fresh.slice(-limit)
    out.log(`之后攒了 ${r.fresh.length} 条：`)
    for (const e of tail) {
      const w = e.weight ? ` w${e.weight}` : ''
      out.log(`${stamp(e.at)}${w}  ${eventLine(e)}`)
    }
    if (r.fresh.length > limit) out.log(`……（只列最近 ${limit} 条，--limit 可调）`)
    out.log('想看全：digest --budget 300')
  }
  if (r.notes.length) {
    out.log(`还留了 ${r.notes.length} 张便条（看过就烧，不会再端一次）：`)
    for (const n of r.notes) {
      out.log(`· ${n.id}  ${n.text}`)
      out.log(`  说的时候：${n.when}`)
    }
  }
  for (const n of expired) {
    // 过期的不静默吞掉，但也只报这一次：记一条 drop，之后不再念。
    out.log(`· ${n.id} 已过期作废（写的时候说：${n.when}）：${n.text}`)
  }
  if (today.length) {
    out.log('今天的安排：')
    for (const p of today) out.log(`· ${planLine(p)}${p.at < now ? '（已经过点了）' : ''}`)
  }

  if (!flags.peek) {
    for (const n of r.notes) appendHandoff(home, { op: 'take', id: n.id, at: now })
    for (const n of expired) appendHandoff(home, { op: 'drop', id: n.id, at: now })
    // 只看过便条、没有新日记时也要抬 lastAt（6 小时间隔照算），但水位不能乱动。
    if (r.fresh.length) {
      writeCue(home, { lastAt: now, watermark: r.fresh[r.fresh.length - 1].at })
    } else {
      writeCue(home, { lastAt: now, watermark: lastCue?.watermark ?? null })
    }
  }
  return 0
}
/**
 * 账本：`trace` 看最近几次渲染，`trace --never` 反过来问哪些日记从没进过摘要。
 *
 * 这个命令刻意不总结、不排序"重要性"——账本只报事实。
 * 读到的事要不要提，仍是模型自己的判断（docs/decisions.md §17）。
 */
/**
 * 联网命令是异步的，普通命令是同步的：main 一直返回数字，只有 place / sky 会交出 Promise。
 * 这里把 async 里的抛错也接住——否则它绕过 main 的 try/catch，变成未处理拒绝。
 */
function guarded(result, out) {
  if (!result || typeof result.then !== 'function') return result
  return result.catch((e) => {
    out.error(`! ${e.message}`)
    return e.usage ? 2 : 1
  })
}

/**
 * 记下我在哪儿。
 *
 * 地名→坐标要联网，而"我住哪"一个月变不了几次：查一次存下来，
 * 之后每次看天只用一个坐标，少一次可能超时的请求（§25）。
 */
async function cmdPlace(home, pos, flags, { out, net }) {
  const want = pos.join(' ').trim()
  if (!want) {
    const cur = readPlace(home)
    if (!cur) throw new Error('还不知道你在哪儿：agent-man place 上海（写城市名，查一次就记住）')
    out.log(`记的是：${cur.name}（${cur.lat}, ${cur.lon}${cur.tz ? `，${cur.tz}` : ''}）`)
    return 0
  }

  const place = await net.geocode(want)
  writePlace(home, place)
  out.log(`记下了：${place.name}`)
  out.log(`  ${place.lat}, ${place.lon}${place.tz ? `（${place.tz}）` : ''}；以后看天就用这个坐标`)
  return 0
}

/**
 * 外面什么样，跟上次比变了什么。
 *
 * 三条确定性门槛全在 judgeSky 里，这里只管取数、缓存、落状态：
 * 半小时内取过的数不重复请求；说的内容对着"上次说过的快照"比，
 * 不是对着"上次取到的数"比——没说话的数据不该算进"我说过什么"。
 *
 * 取不到数又非要报时的处理：有旧数就报旧数，但必须说清是几点的数（§22）。
 * 不拿"现在"冒充"刚才取到的"。
 */
async function cmdSky(home, flags, { out, now, net, env }) {
  const dayStart = dayStartFromEnv(env)
  const place = readPlace(home)
  if (!place) throw new Error('还不知道你在哪儿：先 agent-man place 上海（查一次坐标，之后不再问）')

  const rec = readSky(home)
  const cached = rec?.data ?? null
  const stale = !cached || now - rec.at >= STALE_MS
  let data = cached
  let at = rec?.at ?? null

  if (stale || flags.fresh || flags.force) {
    try {
      data = await net.fetchSky(place, { now })
      at = now
    } catch (e) {
      if (!cached) throw e
      out.error(`! ${e.message}；下面用的是 ${relTime(rec.at, { now })}的数据`)
    }
  }

  const j = judgeSky(data, rec?.said?.snapshot ?? null)
  const head = `${place.short || place.name} ${clock(now)}`
  const today = todayPlans(readPlan(home).records, { now, dayStart })

  if (!j.speak && !flags.force) {
    const extra = today.length ? `；今天还有 ${today.length} 条安排` : ''
    out.log(`${head}，${j.lines[0]}——和上次说的一样，不打扰${extra}`)
    if (at !== rec?.at) writeSky(home, { at, data, said: rec?.said ?? null })
    return 0
  }

  out.log(`${head}，${j.lines[0]}`)
  out.log(j.lines[1])
  if (j.changes.length) {
    out.log('变了什么：')
    for (const c of j.changes) out.log(`· ${c}`)
  } else if (j.fresh) {
    out.log('第一次看天，先记下这个样子。')
  } else {
    out.log('（和上次一样，这回是你让我再说一遍）')
  }
  if (today.length) {
    out.log('今天的安排：')
    for (const r of today) out.log(`· ${planLine(r)}`)
  }
  writeSky(home, { at, data, said: { at: now, snapshot: j.snapshot } })
  return 0
}

/**
 * 日程：看接下来的安排，写一句话就是新加一条。
 *
 * 不判断"这条重不重要"，也不管它跟 weather 有没有关系——"时间到了该提一句"
 * 是唯一确定的部分，剩下的（要不要提、怎么提）是模型的事。
 */
function cmdPlan(home, pos, flags, { out, now, env }) {
  const dayStart = dayStartFromEnv(env)
  const { records, bad } = readPlan(home)
  if (bad) out.error(`! ${bad} 行日程读不出来，已跳过`)

  if (flags.done) {
    const id = String(flags.done)
    const hit = pendingPlans(records).find((r) => r.id === id)
    if (!hit) throw new Error(`没有这条安排：${id}（agent-man plan 列一下现在的）`)
    appendPlan(home, { op: 'done', id, at: now })
    out.log(`划掉了 ${id}：${hit.text}`)
    return 0
  }

  const text = pos.join(' ').trim()
  if (text) {
    if (!flags.at) throw new Error('新安排要写时间：--at "2026-11-14 09:30"（没有时间的安排不是安排）')
    const at = parseAt(flags.at, { now })
    const rec = makePlan({ text, at }, { now, existing: records, dayStart })
    appendPlan(home, rec)
    out.log(`记下了 ${rec.id}：${rec.text}`)
    out.log(`  ${atText(at)}（${relWhen(at, { now, dayStart })}）`)
    return 0
  }

  const days = Number(flags.days ?? 7)
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days 必须是正整数，收到 ${flags.days}`)

  const list = upcoming(records, { now, days })
  if (!list.length) {
    out.log(`接下来 ${days} 天没有安排。`)
    return 0
  }
  out.log(`接下来 ${days} 天：${list.length} 条`)
  for (const r of list) {
    const late = r.at < now ? '（已经过点了）' : ''
    out.log(`· ${r.id}  ${atText(r.at)}  ${r.text}${late}`)
  }
  return 0
}

function atText(at) {
  return stamp(at).slice(0, 16).replace('T', ' ')
}

function planLine(r) {
  return `${clock(r.at)}  ${r.text}`
}

function cmdTrace(home, flags, { out }) {
  const limit = Number(flags.limit ?? 10)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const { traces, bad } = readTraces(home)
  if (flags.never) return traceNever(home, traces, limit, { out })

  if (!traces.length) {
    out.log('还没有账：digest 每渲染一次就落一行，先跑一次')
  } else {
    const tail = traces.slice(-limit)
    out.log(`最近 ${tail.length} 次 digest（共 ${traces.length} 次）：`)
    for (const t of tail) out.log(`${stamp(t.at)}  ${traceLine(t)}`)
  }
  if (bad) out.error(`! ${bad} 行账读不出来，已跳过`)
  return 0
}

function traceNever(home, traces, limit, { out }) {
  const { events, bad } = readEvents(home)
  const miss = neverShown(events, traces)
  const measured = traces.length ? `${traces.length} 次` : '0 次——还没量过'
  out.log(`${miss.length} 条日记没进过摘要（共 ${events.length} 条；账本 ${measured}）`)
  for (const e of miss.slice(-limit)) {
    out.log(`${stamp(e.at)}${e.weight ? ` w${e.weight}` : ''}  ${e.fact}`)
  }
  if (miss.length > limit) out.log(`……（只列最近 ${limit} 条，--limit 可调）`)
  if (bad) out.error(`! ${bad} 行日记读不出来，已跳过`)
  return 0
}
