// 落账（design §4）：每跑一次巩固，账本上多一行。
// 账本是"我当时到底说了什么"的唯一证据——没有它，"你昨天为什么没提那条"
// 就只能靠模型自己回忆，而那正是这个项目要修的病。
import { appendJsonl, ensure, listShards, readJsonl, stateFile } from '../store/index.mjs'

import { nowOf, requireHome } from './build.mjs'

// 一次只读最近这几行：账本是给人看的，不是给程序扫的。
// 名字不叫 TRACE_KEEP：design §10 那个是保留月数（12 个月），这里只是默认读回的行数。
const KEEP_ROWS = 20

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
export function list(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : KEEP_ROWS

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

function idsOf(kept) {
  if (!Array.isArray(kept)) return []
  const out = []
  for (const entry of kept) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id === 'string' && id !== '') out.push(id)
  }
  return out
}
