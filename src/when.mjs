import { clock, hourOf, relTime } from './time.mjs'

/**
 * 定时候：回答"这会儿该不该开口"，不回答"该说什么"。
 *
 * 三道门槛都是确定性判断，所以能写成纯函数（不读时钟、不碰文件、不猜语义）：
 * - 有没有新东西：上次报过的水位之后还有几条日记
 * - 隔了多久：上次报处境的时刻
 * - 现在几点：静默时段不叫人
 *
 * 说的时候给的是处境（几点了、攒了什么），不是台词——见 AGENTS.md §一。
 * 同一条日记不会被反复端上来：报过一次就把水位抬过去，这是"降噪"的最低实现。
 */

/** 默认至少隔 6 小时才再叫人。 */
export const MIN_GAP = 6 * 3600e3
/** 默认静默时段：23:00 到次日 08:00。 */
export const QUIET_FROM = 23
export const QUIET_TO = 8

/** 静默时段按本地墙钟算，跨零点也成立（23 点到 8 点是两段，不是一段）。 */
export function inQuiet(at, { from = QUIET_FROM, to = QUIET_TO } = {}) {
  const h = hourOf(at)
  return from <= to ? h >= from && h < to : h >= from || h < to
}

export function describeQuiet({ from = QUIET_FROM, to = QUIET_TO } = {}) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(from)}:00–${pad(to)}:00`
}

/**
 * 该不该说话。lastCue 是上次报处境时留下的 `{ lastAt, watermark }`。
 *
 * 返回的 reasons 是"为什么不说"——不说也得给理由，否则模型分不清是脚本拦住了、
 * 还是自己没话说。沉默没有解释，等于让人猜。
 */
export function cue({ events = [], notes = [], lastCue = null, now, minGap = MIN_GAP, quiet = {} } = {}) {
  if (!Number.isFinite(now)) throw new Error(`cue 需要 now（epoch ms），收到 ${now}`)
  const watermark = Number.isFinite(lastCue?.watermark) ? lastCue.watermark : -Infinity
  const fresh = events.filter((e) => e.at > watermark)
  const gap = Number.isFinite(lastCue?.lastAt) ? now - lastCue.lastAt : Infinity
  const quietNow = inQuiet(now, quiet)

  const reasons = []
  // 便条也是“该开口”的理由：它是上一个我特意留给这一次的。
  if (!fresh.length && !notes.length) reasons.push('没有新东西')
  if (gap < minGap) {
    const hours = minGap % 3600e3 === 0 ? minGap / 3600e3 : (minGap / 3600e3).toFixed(1)
    reasons.push(`${relTime(lastCue.lastAt, { now })}才开过口，不到 ${hours} 小时`)
  }
  if (quietNow) reasons.push(`这会儿 ${clock(now)} 是静默时段（${describeQuiet(quiet)}）`)

  return { speak: reasons.length === 0, reasons, fresh, notes, gap, quiet: quietNow, watermark }
}
