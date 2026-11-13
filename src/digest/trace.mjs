// 落账（design §4）：每跑一次巩固，账本上多一行。
// 账本是"我当时到底说了什么"的唯一证据——没有它，"你昨天为什么没提那条"
// 就只能靠模型自己回忆，而那正是这个项目要修的病。
import { AUDIT_LIMIT } from '../core/index.mjs'
import { appendJsonl, ensure, listShards, readJsonl, stateFile } from '../store/index.mjs'

import { nowOf, requireHome } from './build.mjs'

// record({home,now,budget,used,header,kept,dropped}) → 写进 state/trace-<月>.jsonl 的一行。
// header 记的是形态名（"full"/"compact"/…，design §4 的例子就是 "full"）：
// 抬头文本由当天的候选数决定，记形态才是一份不会过期的账。
export function record(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const line = {
    at,
    budget: Number.isFinite(opts.budget) ? opts.budget : null,
    used: Number.isFinite(opts.used) ? opts.used : null,
    header: typeof opts.header === 'string' ? opts.header : '',
    kept: idsOf(opts.kept),
    // 每一条丢掉的都带 reason：账本里出现一个没有理由的 id，等于没记。
    dropped: (Array.isArray(opts.dropped) ? opts.dropped : []).map((entry) => ({
      id: typeof entry?.id === 'string' ? entry.id : '',
      reason: typeof entry?.reason === 'string' && entry.reason !== '' ? entry.reason : 'unknown',
    })),
  }
  // 第一次写盘才建目录（design §3：写入才初始化）；目录不在时 appendJsonl 会 ENOENT。
  ensure(dir)
  const file = stateFile(dir, 'trace', at)
  appendJsonl(file, line)
  return { ...line, file }
}

// 账本读回：跨月也要连起来看，否则每月一号"我刚说过什么"就凭空断了。
// 缺省条数用 core 的 AUDIT_LIMIT：同一个账本两个读命令各定一个数，早晚长出两套口径。
export function list(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : AUDIT_LIMIT

  const items = []
  let skipped = 0
  for (const file of listShards(dir, 'trace', { to: at })) {
    const got = readJsonl(file)
    skipped += got.bad
    for (const rec of got.items) {
      if (typeof rec !== 'object' || rec === null || !Number.isFinite(rec.at)) {
        skipped += 1
        continue
      }
      if (rec.at > at) continue
      items.push(rec)
    }
  }
  // 只认 at 的数字差（AGENTS 五）；同一毫秒的两行靠文件内次序，不另编序号。
  items.sort((a, b) => a.at - b.at)
  return { items: items.slice(-limit), skipped, limit }
}

// never({home}) → 这本账从没落过一行吗（design §7 的 never）。
// 上层要能说"还没巩固过"，而不是把"零条"当成"零条账"——两句话差得很远。
// 只要盘上有一行（哪怕读不懂）就不说 never：坏账也是账，不装作没发生。
export function never(opts = {}) {
  const dir = requireHome(opts.home)
  for (const file of listShards(dir, 'trace')) {
    const got = readJsonl(file)
    if (got.items.length > 0 || got.bad > 0) return false
  }
  return true
}

function idsOf(kept) {
  if (!Array.isArray(kept)) return []
  const out = []
  for (const entry of kept) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id === 'string' && id !== '') out.push(id)
  }
  return out
}
