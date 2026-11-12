import { dayIndex, dayKey, weekIndex, weekKey } from './time.mjs'
import { cost } from './cost.mjs'

/**
 * 欠账：不排 cron，只回答"该结的账结了没有"（见 docs/decisions.md#15）。
 *
 * 为什么不是定时任务：凌晨 3 点 agent 不在场，排了也不会发生；脚本也没有语义能力去
 * "总结"。真正确定的是"agent 被叫起来时顺手结账"，所以这里只算欠了几次，让模型自己决定。
 *
 * 纯函数——不看时钟、不碰文件系统，`now` 与结账记录都从参数进来。
 */

export const BACKLOG_COUNT = 30
export const BACKLOG_COST = 600

/** 上次结账之后的日记：条数与代价。`since` 是 epoch ms，传 -Infinity 表示"从来没结过"。 */
export function backlog(events, since = -Infinity) {
  let count = 0
  let spent = 0
  for (const e of events) {
    if (!(e.at > since)) continue
    count++
    spent += cost(e.fact ?? '')
  }
  return { count, cost: spent }
}

/**
 * 欠了几次巩固。
 *
 * 判定式是"隔了几个周期再减一"：今天和本周都还没写完，不该算欠；也允许滞后一个
 * 周期——日结每两天催一次，周结每两周催一次。这是刻意的滞后，不是漏算。
 *
 * 没有结账记录时基准取第一条日记，而不是今天：否则"从来没整理过"会被算成 0 次，
 * 而它恰恰是最该报出来的那种积压。
 */
export function owed(events, { basis = null, now = Date.now(), dayStart = 0 } = {}) {
  const firstAt = events.length ? events[0].at : null // readEvents 已按 at 升序
  const from = basis ?? firstAt
  const days =
    from === null ? 0 : Math.max(0, dayIndex(now, { dayStart }) - 1 - dayIndex(from, { dayStart }))
  const weeks =
    from === null ? 0 : Math.max(0, weekIndex(now, { dayStart }) - 1 - weekIndex(from, { dayStart }))

  const pile = backlog(events, basis ?? -Infinity)
  const over = pile.count >= BACKLOG_COUNT || pile.cost >= BACKLOG_COST

  return {
    days,
    weeks,
    over,
    settled: basis !== null, // false 时 days/weeks 是从第一条日记算起的，报告里要说清楚
    from,
    fromDay: from === null ? null : dayKey(from, { dayStart }),
    fromWeek: from === null ? null : weekKey(from, { dayStart }),
    backlog: pile,
    any: days > 0 || weeks > 0 || over,
  }
}

/** 欠账次数：日结 + 周结 + 按量（按量只算一次，它只是"该结账了"的第三个理由）。 */
export function owedCount(due) {
  return due.days + due.weeks + (due.over ? 1 : 0)
}
