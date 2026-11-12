import { cost, truncate } from './cost.mjs'

export const PINNED_WEIGHT = 2

/**
 * 每行除正文外的固定开销：`- ` + 相对时间 + ` · `。
 * 不算进去的话预算会系统性超支——1200 的预算装 40 条，光前缀就吃掉 400。
 *
 * 实测最长的前缀（`- 2026-11-05 · ` 或 `- 昨天 23:30 · `）约 5–6 代价，
 * 这里取 8 留余量。以前取 12，每行白丢 6–7 的额度。总账另有 render.mjs
 * 的整段夹逼兜底，所以这里宁可贴着实测值。
 */
export const LINE_OVERHEAD = 8

export const entryText = (e) => `${e.fact ?? e.text ?? ''}${e.feel ? `（${e.feel}）` : ''}`

/** 按"先权重、再时间"排在最前面的那条：w3 是疤，不该被一条新的 w2 挤掉。 */
const heaviestPinned = (events) =>
  events
    .filter((e) => (e.weight ?? 0) >= PINNED_WEIGHT)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || b.at - a.at)[0]

/**
 * 保底一条：最重的那条先占住自己那份代价，剩下的才按份额分。
 *
 * 只靠份额有一条死路——份额 = budget × pinnedShare，预算紧到份额装不下一条时，
 * pinned 第一轮就被判死；第二轮得等 recent 捡完剩饭，而 recent 拿的是全额预算，
 * 剩饭常常是 0。实测预算 60（日记层分到 27）时，w2「她把窗关上了」（代价 26）
 * 输给 w0「今天风大」（代价 12）："不会忘的"整块空掉，只剩一条无关紧要的近况。
 *
 * 抬到"份额和最重那条的代价取大"就够了，且只在它自己装得下时才算数——
 * 预算连这一条都装不下，保底也保不了它，下面的 fill 照常记 no-room，不骗人。
 */
export function pinnedFloor(events, budget = Infinity) {
  const top = heaviestPinned(events)
  if (!top) return 0
  const charge = cost(entryText(top)) + LINE_OVERHEAD
  return charge <= budget ? charge : 0
}

/**
 * 另一条保底：最近发生的那一件事，也得占住自己的代价。
 *
 * 只保"最重"而不保"最近"，等于承认一份摘要可以全是旧疤、没有今天——
 * 实测预算 60 时救回 w2 的代价，就是"今天风大"那句被整块挤掉；
 * 而摘要的用处一半在于"她上午说过什么"，那一半不该无条件让位。
 * 和 pinnedFloor 一样，装不下时返回 0，照常记 no-room，不假装保住了。
 */
export function recentFloor(events, budget = Infinity) {
  const top = events
    .filter((e) => (e.weight ?? 0) < PINNED_WEIGHT)
    .sort((a, b) => b.at - a.at)[0]
  if (!top) return 0
  const charge = cost(entryText(top)) + LINE_OVERHEAD
  return charge <= budget ? charge : 0
}

/**
 * 选谁进摘要。纯函数：不碰文件系统，也不看时钟。
 *
 * 三条硬规矩，每条都对着参考实现的一个事故：
 *
 * 1. 预算不可协商。任何一条都不能让总代价超出去——包括 weight=3。
 *    参考实现声称 w3 永不截断，实测预算 100 时两条 30 字 w3 只留下较新的一条，
 *    旧的那条静默消失。"名义永久"和"硬预算"只能选一个，这里选硬预算，
 *    但把丢掉的和切开的东西逐条报出去（drops），不静默。
 *
 * 2. 放不下就跳过这一个，不终止后面的候选。
 *    参考实现在这里用 break，一条放不下的 w2 会把后面所有 heavy 都带走。
 *
 * 3. 排序只认 epoch 数字。参考实现用 localeCompare，混时区就错序。
 *
 * 分配分三轮：pinned 走份额 → recent 走剩下的 → 没人要的额度还给 pinned。
 * 单轮做不到第三件事：只有一条 w3、没有 recent 时，70% 的份额会把它判死，
 * 而当时 100% 的预算都空着。
 *
 * 份额之上还有两条保底：最重的那条、最近的那条，各先占住自己的代价。
 * 份额只能决定"剩下的怎么分"，不能决定"这两条谁出局"。
 */
export function select(events, { budget, pinnedShare = 0.7 } = {}) {
  if (!(budget > 0)) throw new Error(`预算必须为正: ${budget}`)

  const list = events.map((e, i) => {
    const c = cost(entryText(e))
    return { ...e, idx: i, cost: c, charge: c + LINE_OVERHEAD }
  })

  // pinned 先按权重、再按时间：w3 是"疤"，不该被一条新的 w2 挤掉。
  // recent 只按时间：预算紧张时先保近的。
  const pinnedOrder = list
    .filter((e) => (e.weight ?? 0) >= PINNED_WEIGHT)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || b.at - a.at)
  const recentOrder = list.filter((e) => (e.weight ?? 0) < PINNED_WEIGHT).sort((a, b) => b.at - a.at)

  const placed = new Map() // idx -> 实际入账的那条（可能是切过的副本）
  const reason = new Map() // idx -> 'no-room'（只记真没进去的）

  function fill(order, cap) {
    let used = 0
    for (const e of order) {
      if (placed.has(e.idx) || cap <= 0) continue
      const room = cap - used
      if (e.charge <= room) {
        placed.set(e.idx, e)
        used += e.charge
        reason.delete(e.idx)
        continue
      }
      /**
       * 放不下，但还剩下够用的地方：切开它，别整条消失。
       *
       * 参考实现的两处事故在这里合流：
       * - self 块用 `keep.length > 0` 兜底，超长单行整行保留，块直接爆到 1400 字；
       * - dm 块遇到放不下的 w2 就 break，后面的候选连坐。
       * 这里的取舍是：留下的部分够不够像话？够（≥40% 且 ≥32）就留残段 + 省略号，
       * 不够就记名丢掉——两种都不能是静默的。
       */
      const bodyRoom = room - LINE_OVERHEAD
      const minKeep = Math.max(32, Math.ceil(e.cost * 0.4))
      if (bodyRoom >= minKeep) {
        const t = truncate(entryText(e), bodyRoom)
        if (t.cut && t.text.length > 1) {
          const cut = { ...e, fact: t.text, text: t.text, feel: undefined, cut: true }
          cut.cost = cost(t.text)
          cut.charge = Math.min(cut.cost + LINE_OVERHEAD, room)
          placed.set(e.idx, cut)
          used += cut.charge
          reason.delete(e.idx)
          continue
        }
      }
      reason.set(e.idx, 'no-room') // 跳过这一个，继续看后面的
    }
    return used
  }

  const shareCap = Math.floor(budget * pinnedShare)
  const pFloor = pinnedFloor(events, budget)
  const rFloor = recentFloor(events, budget - pFloor)
  /**
   * 两条保底先各占一个位子，剩下的才按份额分：份额再大也不许把最近那条挤出去。
   * 上界是 budget - rFloor（给近的那条留着），下界是 pFloor（重的那条不让人）。
   * 两个下界打架（预算连两条都装不下）时以 pFloor 为准——重要优先，但不是独占。
   */
  const pinnedCap = Math.min(Math.max(shareCap, pFloor), Math.max(pFloor, budget - rFloor))
  const usedP1 = fill(pinnedOrder, pinnedCap)
  const usedR = fill(recentOrder, budget - usedP1)
  const usedP2 = fill(pinnedOrder, budget - usedP1 - usedR) // 剩余额度还给 pinned

  const chosen = [...placed.values()]
  const drops = []
  for (const e of list) {
    const got = placed.get(e.idx)
    if (got?.cut) drops.push({ ...e, why: 'truncated', keptCost: got.cost })
    else if (!got) drops.push({ ...e, why: reason.get(e.idx) ?? 'no-room' })
  }

  const byTime = (a, b) => a.at - b.at // 输出按时间升序：人读的时候是往前读的
  const pinnedSet = new Set(pinnedOrder.map((e) => e.idx))
  // 保底那条到底进来没：头部形态之间要拿它比，光看"装了几条"会选错
  // （预算 60 时 compact 装下一条 w0，bare 装下那条 w2，条数一样）。
  const floorKeep = pinnedOrder.length > 0 && placed.has(pinnedOrder[0].idx)
  const recentFloorKeep = recentOrder.length > 0 && placed.has(recentOrder[0].idx)
  return {
    pinned: chosen.filter((e) => pinnedSet.has(e.idx)).sort(byTime),
    recent: chosen.filter((e) => !pinnedSet.has(e.idx)).sort(byTime),
    drops,
    used: usedP1 + usedR + usedP2,
    budget,
    floorKeep,
    recentFloorKeep,
  }
}
