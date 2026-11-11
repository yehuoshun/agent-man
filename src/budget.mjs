import { cost, truncate } from './cost.mjs'

export const PINNED_WEIGHT = 2

/**
 * 每行除正文外的固定开销：`- ` + 相对时间 + ` · `。
 * 不算进去的话预算会系统性超支——1200 的预算装 40 条，光前缀就吃掉 400。
 * 取保守上界（"3 分钟前"/"6 天前" 都在 12 以内）。
 */
export const LINE_OVERHEAD = 12

export const entryText = (e) => `${e.fact ?? e.text ?? ''}${e.feel ? `（${e.feel}）` : ''}`

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
  const usedP1 = fill(pinnedOrder, shareCap)
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
  return {
    pinned: chosen.filter((e) => pinnedSet.has(e.idx)).sort(byTime),
    recent: chosen.filter((e) => !pinnedSet.has(e.idx)).sort(byTime),
    drops,
    used: usedP1 + usedR + usedP2,
    budget,
  }
}
