// 一屏的预算怎么落到两段上：先按 design §10 的 0.6 / 0.4 分，再让没用完的一段把份额借出去。
// 份额只是起点，不是上限——否则 events 只有 400 的额度，而 memory 那 720 里有 600 空着也白空着。
import { SHARE_EVENTS, SHARE_MEMORY } from '../core/index.mjs'
import { atOf } from './strength.mjs'

// 保底的顺序：最重的那条（调用方已按分数排好，头部就是它），再是最新的那条（at 最大）。
// 两条之后仍按分数序：min 传到 2 以上时（design 允许每段 4 条），顺位不该被打乱。
export function guarantee(section) {
  const items = Array.isArray(section?.items) ? section.items : []
  if (items.length === 0) return []
  const head = items[0]
  let newest = head
  for (const rec of items) if (atOf(rec) > atOf(newest)) newest = rec
  const order = newest === head ? [head] : [head, newest]
  return order.concat(items.filter((rec) => rec !== head && rec !== newest))
}

// allocate(total) 只算份额；带上 used（两段各自真正想要多少）就算借还。
// 返回的 memory + events + spare 恒等于 total：预算不在这里蒸发，也不在这里膨胀。
export function allocate(total, used = null) {
  const cap = Number.isFinite(total) ? Math.max(0, total) : 0
  const shareMemory = Math.round(cap * SHARE_MEMORY)
  const shareEvents = Math.round(cap * SHARE_EVENTS)
  // 两份四舍五入之和可能差一点点（1201 分成 721+480 正好，77.5 就要 47+30.5）；
  // 差的这一点补进 events，让"分配"这一步本身不吞预算。
  const base = { memory: shareMemory, events: shareEvents + (cap - shareMemory - shareEvents) }
  if (used === null || used === undefined) {
    return { total: cap, memory: base.memory, events: base.events, borrowed: 0, spare: 0, short: shortOf(0, 0) }
  }

  const want = { memory: wantOf(used, 'memory'), events: wantOf(used, 'events') }
  let memory = Math.min(want.memory, base.memory)
  let events = Math.min(want.events, base.events)
  let spare = cap - memory - events
  let borrowed = 0
  for (const name of ['memory', 'events']) {
    const wantMore = want[name] - (name === 'memory' ? memory : events)
    if (wantMore <= 0) continue
    const give = Math.min(wantMore, spare)
    if (give <= 0) continue
    if (name === 'memory') memory += give
    else events += give
    spare -= give
    borrowed += give
  }
  return { total: cap, memory, events, borrowed, spare, short: shortOf(want.memory - memory, want.events - events) }
}

function shortOf(memory, events) {
  return { memory: Math.max(0, memory), events: Math.max(0, events) }
}

// 想要多少就得说多少：不是数字、是负数都不算"想要"（负预算没有意义，夹到 0）。
function wantOf(used, name) {
  if (typeof used !== 'object' || used === null) return 0
  const v = used[name]
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v
}
