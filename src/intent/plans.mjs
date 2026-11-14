// 日程 = 有明确时间点的前瞻记忆（design §4）。与便条的区别只有两点：
// 必带 due、到点而不是靠触发——所以 plans 没有 match，日程不触发 cue（design §2）。
import { now } from '../core/index.mjs'
import { claim } from '../store/index.mjs'
import { appendOp, fold, readOps } from './ledger.mjs'
import { atOf, gate, optsOf, textOf, timeOf } from './shape.mjs'

const KIND = 'plans'
const CLOSED = new Set(['done'])
const DAY_MS = 24 * 60 * 60 * 1000 // 单位换算，不是 §10 的调参常数

export async function add(homeDir, input, extra) {
  const opts = optsOf(input, extra)
  const at = atOf(opts)
  const text = textOf(opts.text, '日程内容')
  const due = timeOf(opts.due, at, 'due')
  // 日程没有"什么时候"就不叫日程：不猜一个"明天"塞进去（AGENTS 五：不猜、不补）。
  if (due === undefined) {
    throw new Error('日程要给 due：2026-11-20 09:00 / 明天 9:00 / 3d 都行，缺了就不叫日程')
  }
  const rec = { op: 'add', id: await claim(homeDir, 'p', at, { dayStart: opts.dayStart ?? 0 }), at, text, due }
  return appendOp(homeDir, KIND, gate(KIND, rec))
}

// ls：折叠出未完成项，due 过的标 late（渲染交 view，这里只给数据）。
export function list(homeDir, { now: nowTs, days } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  // days 是"往后看几天"；不给就不设窗口——日程本来没几条，藏掉三个月后的那一条
  // 正是"静默丢弃"要防的事，所以窗口外的不丢，改成计数（later）。
  const horizon = Number.isFinite(days) && days >= 0 ? at + days * DAY_MS : Infinity
  const { ops, bad } = readOps(homeDir, KIND)
  const folded = fold(ops, CLOSED)
  const items = []
  let later = 0
  for (const slot of folded.byId.values()) {
    if (slot.closedAt !== null) continue // done 过：不再出现，但流水账里还留着
    const one = item(slot.rec, at)
    // 逾期的不受窗口影响：已经错过的日程永远得让人看见。
    if (!one.late && one.due !== null && one.due > horizon) {
      later += 1
      continue
    }
    items.push(one)
  }
  // 先到期先看见；没有 due 的老记录排最后，不因为缺一格就消失。
  items.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.at - b.at)
  return { items, late: items.filter((one) => one.late).length, later, bad: bad + folded.bad }
}

// CLI 里叫 plan ls、design §7 的导出名是 list：同一个函数两个名字，只为一处顺手。
export const ls = list

export function done(homeDir, id, { now: nowTs } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  const rec = openPlan(homeDir, id)
  appendOp(homeDir, KIND, { op: 'done', id: rec.id, at })
  return { ...item(rec, at), doneAt: at }
}

// late 只给数据：晚到什么程度、要不要催，是 view 与 gate 的判断。
function item(rec, at) {
  const due = Number.isFinite(rec.due) ? rec.due : null
  return { id: rec.id, at: rec.at, text: rec.text, due, late: due !== null && due < at }
}

// 找不到 / 已经 done 都抛：让 CLI 变成退出码 2，而不是"好像做了"。
function openPlan(homeDir, id) {
  const want = typeof id === 'string' ? id.trim() : ''
  if (want === '') throw new Error('done 要给日程 id：plan ls 的第一列就是')
  const { ops } = readOps(homeDir, KIND)
  const slot = fold(ops, CLOSED).byId.get(want)
  if (!slot) throw new Error(`没有这条日程：${want}（plan ls 看现在有哪些）`)
  if (slot.closedAt !== null) throw new Error(`这条日程已经 done 过：${want}`)
  return slot.rec
}
