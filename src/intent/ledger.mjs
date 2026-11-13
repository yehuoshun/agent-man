// 便条与日程都是 op 流水账（design §4）：只追加 add / take / done，当前状态靠折叠现算。
// 两条流共用这一份，因为它们的分片规则、坏行口径、排序口径完全一样——
// 抄第二份的唯一后果是将来改一处忘一处。
import { appendJsonl, ensure, listShards, readJsonl, stateFile } from '../store/index.mjs'
import { isOp } from './shape.mjs'

// 写一条 op：ensure 只在这里调——读命令一行都不该写盘（design §5 末尾）。
// 分片按这条 op 自己的 at 落月：11 月 take 一条 10 月的便条，take 就写在 11 月的文件里。
export function appendOp(homeDir, kind, rec) {
  ensure(homeDir)
  return appendJsonl(stateFile(homeDir, kind, rec.at), rec)
}

// 跨月分片读成一条连续流水账：listShards 只按自然边界粗筛、按月份升序返回，
// 这里再按 at 的数字差排一次——10 月写 add、11 月写 take 时，先后不能靠文件名碰运气。
// 坏行（解析不了 / 结构不全）跳过并计数，由调用方用 "! " 报出来（AGENTS 五）。
export function readOps(homeDir, kind) {
  const ops = []
  let bad = 0
  for (const file of listShards(homeDir, kind)) {
    const got = readJsonl(file)
    bad += got.bad
    for (const rec of got.items) {
      if (isOp(rec)) ops.push(rec)
      else bad += 1
    }
  }
  // 同毫秒保持文件顺序：Array#sort 稳定，读者看到的仍是"先写先算"。
  ops.sort((a, b) => a.at - b.at)
  return { ops, bad }
}

// 折叠：一条便条 / 日程的当前状态 = 它的 add，加上"之后有没有关闭的 op"。
// 关闭有几种（take 递出、drop 放弃、done 做完），语义留给各流的 closed 集合；
// 这里只认"关闭之后就不再是活的"这一件共同的事。
export function fold(ops, closed) {
  const byId = new Map()
  let bad = 0
  for (const op of ops) {
    if (op.op === 'add') {
      // 同一个 id 两条 add 只可能来自手写或并发事故：留头一条，多出来的计数报出去。
      if (byId.has(op.id)) bad += 1
      else byId.set(op.id, { rec: op, closedAt: null })
      continue
    }
    if (closed.has(op.op)) {
      const slot = byId.get(op.id)
      // 关一个没见过的 id：这一行对不上账，跳过并计数，不猜它是哪一条。
      if (!slot) bad += 1
      else slot.closedAt = op.at
      continue
    }
    bad += 1 // 认不出的 op：读不懂的行跳过并计数，不抛
  }
  return { byId, bad }
}
