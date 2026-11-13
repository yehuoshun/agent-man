// 落账（design §4）：每跑一次巩固，账本上多一行。
// 账本是"我当时到底说了什么"的唯一证据——没有它，"你昨天为什么没提那条"
// 就只能靠模型自己回忆，而那正是这个项目要修的病。
//
// 这一层只有写：读账归 audit.trace（design §6），一处写一处读，口径不会岔开。
import { appendJsonl, ensure, stateFile, validate } from '../store/index.mjs'

import { nowOf, requireHome } from './build.mjs'

// record({home,now,budget,used,header,kept,dropped}) → 写进 state/trace-<月>.jsonl 的一行。
// header 记的是形态名（"full"/"compact"/…，design §4 的例子就是 "full"）：
// 抬头文本由当天的候选数决定，记形态才是一份不会过期的账。
export function record(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const line = {
    at,
    budget: opts.budget,
    used: opts.used,
    header: typeof opts.header === 'string' ? opts.header : '',
    kept: idsOf(opts.kept),
    // 每一条丢掉的都带 reason：账本里出现一个没有理由的 id，等于没记。
    dropped: (Array.isArray(opts.dropped) ? opts.dropped : []).map((entry) => ({
      id: typeof entry?.id === 'string' ? entry.id : '',
      reason: typeof entry?.reason === 'string' && entry.reason !== '' ? entry.reason : 'unknown',
    })),
  }
  // 写之前过一遍 schema：落下一行读不出来的账，比没写更糟——audit 会静默跳过它，
  // 而屏幕那边以为"说过了"。不合法就说清哪里不合法，不替调用方补数。
  const check = validate('trace', line)
  if (!check.ok) {
    throw new Error(`账本这一行不合法：${check.errors.join('；')}`)
  }
  // 第一次写盘才建目录（design §3：写入才初始化）；目录不在时 appendJsonl 会 ENOENT。
  ensure(dir)
  const file = stateFile(dir, 'trace', at)
  appendJsonl(file, line)
  return { ...line, file }
}

// 读账不在这里：audit.trace（design §6）是账本唯一的读者，跨月合读、坏行计数、
// 缺省条数都由它一份口径说了算。原先这里的 list/never 与它各读一遍，谁改了形状
// 另一处不知道——所以拆掉了，"还没巩固过"就是 audit.trace 回空 items。

function idsOf(kept) {
  if (!Array.isArray(kept)) return []
  const out = []
  for (const entry of kept) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id === 'string' && id !== '') out.push(id)
  }
  return out
}
