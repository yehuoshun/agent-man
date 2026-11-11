import path from 'node:path'
import { parseAt, stamp } from './time.mjs'
import { cost } from './cost.mjs'
import { resolveHome, appendEvent, readEvents, writeAtomic } from './store.mjs'
import { renderDigest } from './render.mjs'

const VERSION = '0.1.0'
const DUP_WINDOW = 24 * 3600e3

const HELP = `agent-man ${VERSION} — 给 agent 一个会话之外的生活

用法：
  agent-man log <记的事> [选项]      记一条
  agent-man digest [选项]            渲染当前摘要
  agent-man ls [--limit 20]          看原始事件
  agent-man --help

log 选项：
  --kind dm|qq|video|note   来源，默认 note
  --weight 0..3             重要度，>=2 进"不会忘的"
  --feel <感受>             附着在这件事上的感觉
  --at <时间>               默认现在；接受 ISO / epoch / "2026-11-05 12:45"
  --src <出处>              原始文件或会话

digest 选项：
  --budget 1200             总预算（不是字符数，见 src/cost.mjs）
  --out <文件>              写到文件（原子写），默认打到 stdout
  --title <标题>            第一行标题

环境变量：
  AGENT_MAN_HOME            数据目录，默认 ~/.agent-man`

export function parseArgs(argv) {
  const [cmd, ...rest] = argv
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
    if (eq > 2) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { cmd, pos, flags }
}

export function main(argv = process.argv.slice(2), ctx = {}) {
  const { env = process.env, out = console, now = Date.now() } = ctx
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
  try {
    if (cmd === 'log') return cmdLog(home, pos, flags, { out, now })
    if (cmd === 'digest') return cmdDigest(home, flags, { out, now })
    if (cmd === 'ls') return cmdLs(home, flags, { out })
    out.error(`未知命令: ${cmd}\n\n${HELP}`)
    return 2
  } catch (e) {
    out.error(`! ${e.message}`)
    return 1
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

function cmdDigest(home, flags, { out, now }) {
  const budget = Number(flags.budget ?? 1200)
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget 必须是正数，收到 ${flags.budget}`)

  const { events, bad } = readEvents(home)
  const { text, stats } = renderDigest(events, { budget, now, title: flags.title ?? '我记得的事' })

  if (typeof flags.out === 'string') {
    const target = path.resolve(flags.out)
    writeAtomic(target, text)
    out.log(`写好了: ${target}  （${stats.kept}/${stats.total} 条，占 ${stats.used}/${stats.budget}）`)
  } else {
    out.log(text.trimEnd())
  }

  if (bad) out.error(`! ${bad} 行读不出来，已跳过`)
  reportDrops(stats, out)
  return 0
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

function cmdLs(home, flags, { out }) {
  const limit = Number(flags.limit ?? 20)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 必须是正整数，收到 ${flags.limit}`)

  const { events, bad } = readEvents(home)
  const tail = events.slice(-limit)
  out.log(`${events.length} 条（显示最近 ${tail.length} 条）`)
  for (const e of tail) {
    const feel = e.feel ? `（${e.feel}）` : ''
    out.log(`${stamp(e.at)}${e.weight ? ` w${e.weight}` : ''}  [${e.kind}]  ${e.fact}${feel}`)
  }
  if (bad) out.error(`! ${bad} 行读不出来`)
  return 0
}
