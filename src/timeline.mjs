import { parseAt, stamp } from './time.mjs'
import { traceLine } from './trace.mjs'

/**
 * 时间线：把四份日志摆成一条，倒着排（§37）。
 *
 * 不新建文件，也不抄正文。四份各答一个问题，合起来才答得上"那天到底是怎么过来的"：
 *   events.jsonl       发生了什么——原文，唯一的事实来源
 *   memory.jsonl       整理成了什么——含 why、改过哪几条、退场的是哪几版
 *   state/judge.jsonl  说没说、为什么——cue 的每一次判断
 *   state/trace.jsonl  摘要装下了什么、丢了什么——每次渲染的账
 *
 * 追溯靠引用不靠副本：这里只把已有的行按时间摆到一起，一行正文都不另存一份。
 * 所以这个文件里没有读取、没有写入，只有两件事：合、排。
 */

/** 四份日志各自的叫法。短，够在一列里对齐。 */
export const TIMELINE_KINDS = {
  log: '日记',
  mem: '结论',
  rule: '规矩',
  judge: '判断',
  digest: '摘要',
}

export const TIMELINE_NAMES = Object.keys(TIMELINE_KINDS)

/**
 * 合成一条时间线。
 *
 * `limit: 0` 表示不截断——调用方想先知道"一共多少条"再决定列几条。
 * `at` 在各份文件里写法不一（日记和条目是 epoch，判断是 ISO 串），
 * 排序前一律换算成 epoch：字符串字典序排不出冬天到夏天。
 */
export function buildTimeline(
  { events = [], items = [], judges = [], traces = [] } = {},
  { since = null, kinds = null, limit = 20 } = {},
) {
  const want = kinds ? new Set(kinds) : null
  const keep = (k) => !want || want.has(k)
  const rows = []

  if (keep('log')) {
    for (const e of events) rows.push({ at: parseAt(e.at), kind: 'log', id: '', text: e.fact })
  }
  if (keep('mem') || keep('rule')) {
    for (const it of items) {
      const rule = it.kind === 'rule'
      if (!keep(rule ? 'rule' : 'mem')) continue
      rows.push({
        at: parseAt(it.at),
        kind: rule ? 'rule' : 'mem',
        id: it.id,
        text: it.fact,
        why: it.why,
        supersedes: it.supersedes ?? [],
      })
    }
  }
  if (keep('judge')) {
    for (const j of judges) {
      rows.push({ at: parseAt(j.at), kind: 'judge', id: '', said: j.said === true, text: j.why })
    }
  }
  if (keep('digest')) {
    for (const t of traces) rows.push({ at: parseAt(t.at), kind: 'digest', id: '', text: traceLine(t) })
  }

  const kept = since == null ? rows : rows.filter((r) => r.at >= since)
  // 同一毫秒的两条要有个确定的先后：先按时间倒，再按种类固定顺序，最后按 id——
  // 排序不稳定的话，同一份数据的两次运行会给出两种读法。
  kept.sort((a, b) => b.at - a.at || TIMELINE_NAMES.indexOf(a.kind) - TIMELINE_NAMES.indexOf(b.kind) || String(a.id).localeCompare(String(b.id)))
  return limit > 0 ? kept.slice(0, limit) : kept
}

/** 一行：什么时候、哪一份、哪一条。规矩和结论带上 id——追溯的下一条命令要用它。 */
export function timelineLine(row) {
  const when = stamp(row.at).slice(0, 16).replace('T', ' ')
  const label = TIMELINE_KINDS[row.kind] ?? row.kind
  let body = row.text
  if (row.kind === 'judge') body = `${row.said ? '说了' : '没说'}——${row.text}`
  if (row.kind === 'rule') body = `${row.id}  ${row.text}（因为：${row.why}）`
  if (row.kind === 'mem') body = `${row.id}  ${row.text}`
  const from = row.supersedes?.length ? `  ← 改自 ${row.supersedes.join(', ')}` : ''
  return `${when}  ${label}  ${body}${from}`
}

/** 各有多少条：一行说清这条时间线是从什么里面捡出来的。 */
export function timelineCounts(rows) {
  const n = {}
  for (const r of rows) n[r.kind] = (n[r.kind] ?? 0) + 1
  return TIMELINE_NAMES.filter((k) => n[k]).map((k) => `${TIMELINE_KINDS[k]} ${n[k]}`).join(' · ')
}
