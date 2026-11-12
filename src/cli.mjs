import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  readJudges,
  appendJudge,
  readHandoff,
  appendHandoff,
  readPlace,
  writePlace,
  readSky,
  writeSky,
  readPlan,
  appendPlan,
  claimId,
} from './store.mjs'
import { makeItem, activeItems, longLine, itemLine, makeRule, ruleLine, RULE_LIMIT, TIERS } from './memory.mjs'
import { backlog, owed, owedCount, BACKLOG_COUNT, BACKLOG_COST } from './consolidate.mjs'
import { renderDigest } from './render.mjs'
import { buildTrace, neverShown, traceLine } from './trace.mjs'
import { buildTimeline, timelineLine, timelineCounts, TIMELINE_NAMES, TIMELINE_KINDS } from './timeline.mjs'
import { cue, MIN_GAP, describeQuiet } from './when.mjs'
import { makeNote, pendingNotes } from './handoff.mjs'
import { makePlan, pendingPlans, upcoming, todayPlans } from './plan.mjs'
import { judgeSky, cacheState, dateText, snapshotOf, skyText } from './sky.mjs'
import * as defaultNet from './net.mjs'

const VERSION = '0.3.0'
const DUP_WINDOW = 24 * 3600e3

const HELP = `agent-man ${VERSION} — 给 agent 一个会话之外的生活

用法：
  agent-man log <记的事> [选项]      记一条日记（原文，只追加）
  agent-man remember <结论> [选项]   记一条长期记忆（模型整理出来的）
  agent-man rule <规矩> [选项]       给自己定一条规矩（只能收紧，不能扩权）
  agent-man recall [选项]            看长期记忆
  agent-man digest [选项]            渲染当前摘要
  agent-man ls [--limit 20]          看原始事件
  agent-man find <词> [选项]         在日记原文里搜（摘要只压不取，原文在这）
  agent-man trace [选项]             看每次 digest 装下了什么、丢了什么
  agent-man timeline [选项]          把日记、结论、规矩、判断摆成一条时间线
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

rule 选项：
  --why <事>                必填：哪件具体的事让你定的这条（不是道理，是事情）
  --refs <a,b>              指向原文的日期或时间
  --supersedes <id,id>      改掉哪几条旧规矩（旧行不动，只是退场）
  --id <id>                 默认按日期发号
  --at <时间>               定这条的时刻，默认现在
  --fact <文本>             等价于位置参数

rule 选项：
  --why <事>                必填：哪件具体的事让你定的这条（不是道理，是事情）
  --refs <a,b>              指向原文的日期或时间
  --supersedes <id,id>      这条改掉了哪几条旧规矩（旧行不动，只是退场）
  --id <id>                 默认按日期发号
  --at <时间>               定这条的时刻，默认现在
  --fact <文本>             等价于位置参数

rule 选项：
  --why <事>                必填：哪件具体的事让你定的这条（不是道理，是事情）
  --refs <a,b>              指向原文的日期或时间
  --supersedes <id,id>      这条改掉了哪几条旧规矩（旧行不动，只是退场）
  --id <id>                 默认按日期发号
  --at <时间>               定这条的时刻，默认现在

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

timeline 选项：
  --limit 20                最多列几条，取最近的
  --kind log|mem|rule|judge|digest  只看其中几份，逗号分开
  --since <时间>            从这时起；只写日期（2026-11-05）按本地整天算

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
  --why <理由>              把这次的判断记下来（为什么说／为什么没说），下次 cue 会先看见
  --out <文件>              写到文件（原子写），默认打到 stdout

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

零件（不在这个仓库里）：
  agent-man <名字> 在本项目不认识它时，转给 PATH 上的 agent-man-<名字>——
  装了就有，卸了就没了，这里不留清单（见 docs/decisions.md#32）。

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
  rule: { value: ['why', 'refs', 'supersedes', 'id', 'at', 'fact'], bool: [] },
  recall: { value: ['limit', 'tier', 'batch', 'grep'], bool: [] },
  digest: { value: ['budget', 'out', 'title'], bool: ['due'] },
  ls: { value: ['limit'], bool: [] },
  find: { value: ['since', 'until', 'kind', 'limit'], bool: [] },
  trace: { value: ['limit'], bool: ['never'] },
  timeline: { value: ['limit', 'kind', 'since'], bool: [] },
  cue: { value: ['limit', 'min-gap', 'out', 'why'], bool: ['peek', 'force'] },
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

// ---------------------------------------------------------------- 零件
// 零件在进程外：`agent-man foo …` 转给 PATH 上的 `agent-man-foo`。
// PATH 就是注册表，npm 就是安装器——装了就有，卸了就没了，主项目不留清单，
// 也不 import 别人的代码（见 docs/decisions.md#32）。

function findPart(name, env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  // Windows 上有的进程只给 Path 不给 PATH
  const search = String(env.PATH ?? env.Path ?? '')
  for (const dir of search.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = path.join(dir, `agent-man-${name}${ext}`)
      try {
        if (fs.statSync(file).isFile()) return { file, ext }
      } catch {}
    }
  }
  return null
}

// Windows 的 cmd.exe 会把 %名字% 换成环境变量，包在引号里也照换；^% 和 %% 都救不回来
// （四种写法实测过，见 §32）。命中就直说，别猜着转义。
function assertPartArgs(args, name) {
  if (process.platform !== 'win32') return
  for (const a of args) {
    if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(a)) {
      throw usage(`零件 ${name} 的参数里不能有 %名字%：Windows 上 cmd 会把它换成环境变量\n${a}`)
    }
  }
}

function runPart(part, args, env) {
  let r
  if (process.platform === 'win32' && part.ext !== '.exe') {
    // .cmd/.bat 不能直接 CreateProcess（EINVAL）；而 Node 默认还会给参数再包一层引号，
    // 所以必须 windowsVerbatimArguments：自己拼、自己加引号。
    const q = (x) => (/[\s"&|<>^]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)
    const line = [q(part.file), ...args.map(q)].join(' ')
    r = spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      stdio: 'inherit',
      env,
      windowsVerbatimArguments: true,
    })
  } else {
    r = spawnSync(part.file, args, { stdio: 'inherit', env })
    // POSIX 上 npm 的 shim 一般有可执行位；万一没有，用 node 跑（它一定是 JS）
    if (r.error?.code === 'EACCES' && /\.(mjs|cjs|js)$/.test(part.file)) {
      r = spawnSync(process.execPath, [part.file, ...args], { stdio: 'inherit', env })
    }
  }
  if (r.error) {
    throw new Error(`零件 ${path.basename(part.file)} 起不来：${r.error.code || r.error.message}`)
  }
  return r.signal ? 128 : (r.status ?? 1)
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
    // 零件先试：命令表里没有的名字，转给 PATH 上的 agent-man-<名字>（§32）。
    const first = argv[0]
    if (first && first !== 'help' && !first.startsWith('-') && !FLAGS[first]) {
      const part = findPart(first, env)
      if (part) {
        assertPartArgs(argv.slice(1), first)
        return runPart(part, argv.slice(1), env)
      }
    }
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
    if (cmd === 'rule') return cmdRule(home, pos, flags, { out, now })
    if (cmd === 'recall') return cmdRecall(home, flags, { out })
    if (cmd === 'digest') return cmdDigest(home, flags, { out, now, env })
    if (cmd === 'ls') return cmdLs(home, flags, { out })
    if (cmd === 'find') return cmdFind(home, pos, flags, { out, env })
    if (cmd === 'trace') return cmdTrace(home, flags, { out })
    if (cmd === 'timeline') return cmdTimeline(home, flags, { out, now })
    if (cmd === 'cue') return cmdCue(home, flags, { out, now, env })
    if (cmd === 'show') return cmdShow(home, pos, flags, { out, env })
    if (cmd === 'leave') return cmdLeave(home, pos, flags, { out, now })
    if (cmd === 'place') return guarded(cmdPlace(home, pos, flags, { out, net }), out)
    if (cmd === 'sky') return guarded(cmdSky(home, flags, { out, now, net, env }), out)
    if (cmd === 'plan') return cmdPlan(home, pos, flags, { out, now, env })
    out.error(
      `未知命令: ${cmd}\n` +
        `如果是零件，装它：npm i -g agent-man-${cmd}\n` +
        `（零件装在 PATH 上，叫 agent-man-<名字>，这里不留清单）\n\n${HELP}`,
    )
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

  const kind = String(flags.kind ?? 'note').trim()
  if (!kind) throw new Error('--kind 不能是空的：它标的是这条从哪儿来（note / dm / qq / video）')

  const ev = { at, kind, fact }
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
  const item = numberItem(home, items, flags, fact, now)
  appendMemory(home, item)

  // 结账：remember 就是"把日记整理成长期条目"的那一次动作，成功了才记账（§15）。
  // 上面任何一步抛错都走不到这里——校验不过的条目不配清账。
  // 走到这里长期条目已经落盘了，所以结账失败只影响"欠账报多少"，不能让整个命令
  // 看起来没发生：模型会照着那句 `! ...` 再记一遍（§29）。
  let settled = null
  try {
    settled = settle(home, now)
  } catch (e) {
    out.error(`! 这条记下了，但"结账到哪儿"没更新：${e.message}`)
    out.error('  下次 digest 会把这段日记再报一次欠账——那不是重记，别把这条再写一遍。')
  }

  out.log(`${item.id}  tier${item.tier}  ${longLine(item)}`)
  if (item.refs.length) out.log(`  出处: ${item.refs.join(', ')}`)
  if (item.supersedes.length) out.log(`  取代: ${item.supersedes.join(', ')}`)
  out.log(`  结账: ${settled === null ? '没更新（见上面的警告）' : `清了 ${settled} 条日记`}`)
  return 0
}

/**
 * 发号并抢名额。`--id` 是调用方自己认的号，不抢（撞了是调用方的事）；
 * 默认号由"当天已有几条"算出来，并发时两个进程会算出同一个，所以算完要抢，
 * 抢不到就把它当成已存在再算一次（§29）。
 */
function numberItem(home, items, flags, fact, now) {
  const make = (existing) =>
    makeItem(
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
      { now, existing },
    )

  if (flags.id) return make(items)

  let existing = items
  for (let i = 0; i < 50; i += 1) {
    const item = make(existing)
    if (claimId(home, item.id)) return item
    existing = [...existing, { id: item.id }]
  }
  throw new Error('发号抢了 50 次都没抢到：state/ids/ 里当天的号被谁一直占着，去看看')
}

/** 把"截至 now 的积压"记为已结，返回这次清掉的条数。 */
function settle(home, now) {
  const { events } = readEvents(home)
  const prev = readConsolidation(home)
  const cleared = backlog(events, prev?.at ?? -Infinity).count
  writeConsolidation(home, { at: now, settled: cleared })
  return cleared
}

/**
 * 给自己定一条规矩（§36）。
 *
 * 和 remember 的区别不在落盘，在写给谁看：结论是回忆，规矩是约束。
 * 所以它排在摘要最前面、改版要留痕、而且必须有来由——没有来由的规矩，
 * 下一次读到的时候没人知道它还算不算数。
 */
function cmdRule(home, pos, flags, { out, now }) {
  const fact = (pos.join(' ') || String(flags.fact ?? '')).trim()
  if (!fact) {
    throw new Error('要定什么规矩？例：agent-man rule "夜里十一点后不提工作" --why "昨天 23:40 提加班，她只回了句嗯"')
  }

  const { items } = readMemory(home)
  const item = makeRule(
    {
      fact,
      why: flags.why,
      refs: flags.refs,
      supersedes: flags.supersedes,
      id: flags.id,
      at: flags.at,
    },
    { now, existing: items },
  )
  appendMemory(home, item)

  const after = [...items, item]
  out.log(`${item.id}  tier0  ${ruleLine(item, { items: after })}`)
  out.log(`  为什么: ${item.why}`)
  if (item.refs.length) out.log(`  出处: ${item.refs.join(', ')}`)
  if (item.supersedes.length) out.log(`  取代: ${item.supersedes.join(', ')}`)
  const live = activeItems(after).filter((it) => it.kind === 'rule').length
  out.log(`  规矩: ${live} / ${RULE_LIMIT} 条`)
  return 0
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
  reportDup(stats, out)
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

/**
 * 逐字相同的重复被合成了几行。
 *
 * 合并也算一种"没进去"，所以要说一声；但它的原因和预算无关，不该混进
 * 「预算不够，丢了 N 条」里去——那句话会让人去加 --budget，而这件事加预算解决不了。
 */
function reportDup(stats, out) {
  const dup = (stats.drops ?? []).filter((d) => d.why === 'dup')
  if (!dup.length) return
  out.error(`! 合掉 ${dup.length} 条逐字重复，只留最新的那条：`)
  for (const d of dup.slice(0, 5)) out.error(`    ${stamp(d.at)}  w${d.weight ?? 0}  ${d.fact}`)
  if (dup.length > 5) out.error(`    ……（还有 ${dup.length - 5} 条）`)
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
  // 出处写进方括号：零件记的条目和手写的条目，得能一眼分开（§32）
  const src = e.src ? `|${e.src}` : ''
  return `[${e.kind}${src}]  ${e.fact}${feel}`
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
/**
 * 时间线：四份日志摆成一条（§37）。
 *
 * 这是"追溯"的入口，不是第五份日志——它不落盘、不缓存，每次现读现排。
 * 想知道某条规矩是怎么来的，就从这一行跳到 remember/rule 的原文；
 * 想知道某天为什么没说话，就看那天的判断行。
 */
function cmdTimeline(home, flags, { out, now }) {
  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const kinds = flags.kind === undefined ? null : String(flags.kind).split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of kinds ?? []) {
    if (!TIMELINE_NAMES.includes(k)) {
      throw new Error(`--kind 只认 ${TIMELINE_NAMES.join(' / ')}（${TIMELINE_NAMES.map((n) => TIMELINE_KINDS[n]).join(' / ')}），收到 ${k}`)
    }
  }
  const since = flags.since === undefined ? null : parseAt(flags.since, { now })

  const { events } = readEvents(home)
  const { items } = readMemory(home)
  const { judges } = readJudges(home)
  const { traces } = readTraces(home)

  const all = buildTimeline({ events, items, judges, traces }, { since, kinds, limit: 0 })
  if (!all.length) {
    out.log(flags.since || kinds ? '这段时间里没有对得上的记录' : '一条都还没有：先 log 几笔')
    return 0
  }

  const shown = all.slice(0, limit)
  out.log(`${all.length} 条${all.length > shown.length ? `，列最近 ${shown.length} 条` : ''}（${timelineCounts(all)}）：`)
  for (const row of shown) out.log(timelineLine(row))
  return 0
}

function cmdCue(home, flags, { out, now, env }) {
  const why = flags.why === undefined ? '' : String(flags.why).trim()
  if (flags.why !== undefined && !why) {
    throw new Error('--why 不能是空的：它记的是这一次为什么说／为什么没说')
  }

  // 打哪儿由调用方定：屏幕上是一行行，文件里是同一批行的整段（§33）。
  // 早退的出口有三个，所以正文只往 lines 里攒，攒完再决定去处。
  const lines = []
  // 先读上一次的判断：这一次该踩着上一次，而不是从零开始（§35）。
  const { judges, bad: badJudge } = readJudges(home)
  const lastJudge = judges[judges.length - 1]
  const { code, said } = cueLines(home, flags, { out, now, env, say: (s) => lines.push(s) })
  if (badJudge) out.error(`! ${badJudge} 条判断记录读不出来，已跳过`)
  if (lastJudge) lines.push(judgeLine(lastJudge, { now }))

  if (typeof flags.out === 'string') {
    const target = path.resolve(flags.out)
    writeAtomic(target, `${lines.join('\n')}\n`)
    out.log(`写好了: ${target}`)
  } else {
    for (const line of lines) out.log(line)
  }

  // 判断记在说完之后：一次决定只有一个落点，"说了什么"和"为什么说"不该分开写。
  if (why) appendJudge(home, { at: stamp(now), said, why })
  return code
}

function cueLines(home, flags, { out, now, env, say }) {
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
    say(`这会儿 ${clock(now)}，不打扰：${r.reasons.join('；')}${dead}${planTail}`)
    if (!flags.peek) for (const n of expired) appendHandoff(home, { op: 'drop', id: n.id, at: now })
    return { code: 0, said: false }
  }
  if (!r.fresh.length && !r.notes.length) {
    const quietTail = r.quiet ? `（${describeQuiet()} 静默时段，本来也不叫人）` : ''
    const planTail = today.length ? `（今天还有 ${today.length} 条安排）` : ''
    say(`这会儿 ${clock(now)}，没有新东西${quietTail}${planTail}`)
    return { code: 0, said: false }
  }

  say(`这会儿 ${clock(now)}。`)
  say(lastCue ? `上次开口 ${relTime(lastCue.lastAt, { now })}。` : '你还没在这儿开过口。')
  if (r.fresh.length) {
    const tail = r.fresh.slice(-limit)
    say(`之后攒了 ${r.fresh.length} 条：`)
    for (const e of tail) {
      const w = e.weight ? ` w${e.weight}` : ''
      say(`${stamp(e.at)}${w}  ${eventLine(e)}`)
    }
    if (r.fresh.length > limit) say(`……（只列最近 ${limit} 条，--limit 可调）`)
    say('想看全：digest --budget 300')
  }
  if (r.notes.length) {
    say(`还留了 ${r.notes.length} 张便条（看过就烧，不会再端一次）：`)
    for (const n of r.notes) {
      say(`· ${n.id}  ${n.text}`)
      say(`  说的时候：${n.when}`)
    }
  }
  for (const n of expired) {
    // 过期的不静默吞掉，但也只报这一次：记一条 drop，之后不再念。
    say(`· ${n.id} 已过期作废（写的时候说：${n.when}）：${n.text}`)
  }
  if (today.length) {
    say('今天的安排：')
    for (const r of today) say(`· ${planItem(r, now)}`)
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
  return { code: 0, said: !flags.peek }
}

/**
 * 上一次的判断：什么时候、说没说话、为什么。脚本只复述，不评价——
 * 判断对不对，仍然是模型自己的事（§35）。
 */
function judgeLine(j, { now }) {
  const when = relTime(parseAt(j.at, { now }), { now })
  return `上次：${when}${j.said ? '说了话' : '没说话'}——${j.why}`
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
  const state = cacheState(rec, { now, tz: place.tz })
  // 一天以前的那份数不再当它说过话（§25）；跨日的那份能看，但不能当"今天"。
  const usable = state === 'fresh' || state === 'same-day' || state === 'cross-day'
  let data = usable ? rec.data : null
  let at = usable ? rec.at : null
  let used = usable ? state : null

  if (state !== 'fresh' || flags.fresh || flags.force) {
    try {
      data = await net.fetchSky(place, { now })
      at = now
      used = 'fresh'
    } catch (e) {
      if (!usable) throw e
      out.error(`! ${e.message}；下面用的是 ${relTime(rec.at, { now })}的数据`)
    }
  }

  const j = judgeSky(data, rec?.said?.snapshot ?? null)
  const head = `${place.short || place.name} ${clock(now)}`
  const today = todayPlans(readPlan(home).records, { now, dayStart })

  // 手上那份数说的不是今天：只能报"上次看到的样子"，不能说"今天"（§25）。
  // 也别比"变了什么"——比的对象是前一天，比出来的结论今天不成立。
  if (used === 'cross-day') {
    const snap = snapshotOf(data)
    out.log(`${head}，今天没取到数`)
    out.log(
      `上次是 ${dateText(snap.date)}：${skyText(snap.code)}，` +
        `${Math.round(snap.temp)}℃，${Math.round(snap.tmin)}–${Math.round(snap.tmax)}℃`,
    )
    if (today.length) {
      out.log('今天的安排：')
      for (const r of today) out.log(`· ${planItem(r, now)}`)
    }
    return 0
  }

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
    for (const r of today) out.log(`· ${planItem(r, now)}`)
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
    const late = lateMark(r, now)
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

/**
 * 安排列表里的一行：过点的要当场说清。
 *
 * cue 和看天直接用它；plan 那边的列表还要带编号和完整时间，只借 lateMark。
 * 分成两半是为了这条：**一处忘了标，模型就把 09:30 的事当还没到**。
 */
function planItem(r, now) {
  return `${planLine(r)}${lateMark(r, now)}`
}

function lateMark(r, now) {
  return r.at < now ? '（已经过点了）' : ''
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
