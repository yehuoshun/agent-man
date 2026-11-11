/**
 * 时间只在这里解释一次。
 *
 * 事故：参考实现用 `String(a.at).localeCompare(String(b.at))` 排序。
 * 三条同权重事件 2026-11-05T09:00+08:00 / 2026-11-05T02:00Z / 2026-11-04T21:00-05:00
 * 排出来是 09:00 → 02:00 → 21:00，也就是字面序，不是时间序。
 * 根因不是排序写错，是 at 从入口起就没被归一过。
 *
 * 规则：入库存 epoch ms，全链路只认数字，展示时才转本地时间。
 */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0')

/**
 * 解析任意输入成 epoch ms。空值取 now；解析不了就抛，不猜。
 * 注意：带偏移的 ISO 串按绝对时刻解释；"2026-11-05 12:45" 这种裸串按本地时间，
 * 这是刻意的——人写这种东西时想的就是本地钟。
 */
export function parseAt(input, { now = Date.now() } = {}) {
  if (input === undefined || input === null || input === '') return now
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`时间不是有限数: ${input}`)
    return input < 1e11 ? input * 1000 : input // 10 位当秒
  }
  const s = String(input).trim()
  if (/^\d{10}$/.test(s)) return Number(s) * 1000
  if (/^\d{13}$/.test(s)) return Number(s)
  const t = Date.parse(s)
  if (!Number.isFinite(t)) throw new Error(`看不懂的时间: ${JSON.stringify(input)}`)
  return t
}

/** 本地时区的 ISO 串，带偏移。给人看，也给日志对齐。 */
export function stamp(at) {
  const d = new Date(at)
  const off = -d.getTimezoneOffset() // 分钟，东正西负
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)}`
  )
}

/**
 * 本地日历日，YYYY-MM-DD。只用来分桶，不用来做时间比较。
 *
 * `dayStart` 把日界往后挪几小时：0 是午夜，4 表示"凌晨 4 点才算新的一天"。
 * 实现是让时刻往回平移再取日期，所以 00:30 在 dayStart=4 时归到前一天。
 */
export function dayKey(at, { dayStart = 0 } = {}) {
  const d = new Date(at - dayStart * HOUR)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 从环境变量读日界：AGENT_MAN_DAY_START，0..23 的整点。坏了就抛，不猜。 */
export function dayStartFromEnv(env = process.env) {
  const raw = env.AGENT_MAN_DAY_START?.trim()
  if (!raw) return 0
  const h = Number(raw)
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`AGENT_MAN_DAY_START 只能是 0..23 的整点，收到 ${JSON.stringify(raw)}`)
  }
  return h
}

/**
 * 相对时间。每次渲染现算，绝不写死进文本——
 * 写死的时间戳会让摘要随时间腐坏："9 小时前" 三天后不该还是 "9 小时前"。
 *
 * 12 小时内只看距离：同一段距离不因"跨没跨午夜"换说法。
 * 半天以后必须先判日历日——只按距离会说"昨天 00:30"，而那其实是今天凌晨。
 * 代价：同一时刻从两个锚点看可能一个说"11 小时前"、一个说"昨天 23:30"，
 * 但它们不会并排出现，事实正确优先。见 docs/decisions.md#2。
 */
export function relTime(at, { now = Date.now(), dayStart = 0 } = {}) {
  const d = now - at
  if (d < 0) return stamp(at).slice(0, 16).replace('T', ' ') // 未来给绝对时间
  if (d < MINUTE) return '刚刚'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分钟前`
  if (d < 12 * HOUR) return `${Math.floor(d / HOUR)} 小时前`
  // 半天以后先看日历日：同一天继续用小时，跨一天才叫"昨天"。
  const days = dayIndex(now, dayStart) - dayIndex(at, dayStart)
  if (days <= 0) return `${Math.floor(d / HOUR)} 小时前` // 同一天，只是隔得久
  if (days === 1) return `昨天 ${stamp(at).slice(11, 16)}`
  if (days < 7) return `${days} 天前`
  return stamp(at).slice(0, 10)
}

/**
 * 本地日历日的整数序号：把本地的 Y/M/D 当成 UTC 零点再除一天。
 * 只用于算"隔了几个日历日"，不受夏令时与跨时区影响。日界与 dayKey 保持一致。
 */
function dayIndex(at, dayStart = 0) {
  const d = new Date(at - dayStart * HOUR)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY
}
