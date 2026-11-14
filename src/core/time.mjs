// 时间只解释一次（AGENTS 二·3）：入口 parseWhen() 把字符串归一成 epoch ms，
// 之后全链路只认数字，展示时才 rel() / clock() 现算。
// 全仓也只有这里碰 Date.now()（另一个是 CLI 入口取 now 的地方）——时间一旦散落，
// 用例就没法传死 now，"保留率随时间下降"这类断言只能靠运气。
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// 四个入口正则。刻意只认这几种写法：多认一种就多一处"猜用户想说什么"。
const P_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const P_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const P_SPAN = /^(\d+)\s*(d|h|m)$/
const P_WORD = /^(今天|明天|后天)(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const WORD_DAYS = new Map([['今天', 0], ['明天', 1], ['后天', 2]])

export function now() {
  return Date.now()
}

// 日界必须能平移：夜里 3 点还算"昨天"是人的直觉，事件分片与 digest 都要这个口径。
export function dayKey(ts, { dayStart = 0 } = {}) {
  const at = toDate(ts)
  if (!at) return ''
  const shift = dayStartHours(dayStart)
  if (shift === 0) return stamp(at)
  // 按本地日历日回退一天，不用 ts - 4h：夏令时那天少一小时，减出来的"昨天"会错一格。
  if (at.getHours() < shift) return stamp(new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1))
  return stamp(at)
}

export function monthKey(ts) {
  const at = toDate(ts)
  if (!at) return ''
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`
}

export function clock(ts) {
  const at = toDate(ts)
  if (!at) return ''
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// 相对时间的唯一原则：先判日历日，再判时长。晚上 22:10 到次日 01:40 只过了 3.5 小时，
// 但"3 小时前"让人认不出是哪天，而"27 小时前"更是没人读得懂——所以跨天一律报日子。
export function rel(ts, nowTs) {
  if (!Number.isFinite(ts) || !Number.isFinite(nowTs)) return ''
  const gap = nowTs - ts
  const days = dayIndex(ts) - dayIndex(nowTs)

  // 未来的点（plan 的 when）不能说"负 3 小时前"：今天给钟点，明天给"明天 22:10"。
  if (gap < 0) {
    if (days === 0) return clock(ts)
    if (days === 1) return `明天 ${clock(ts)}`
    return dayKey(ts)
  }
  if (gap < MINUTE) return '刚刚'
  if (days === 0) {
    if (gap < HOUR) return `${Math.floor(gap / MINUTE)} 分钟前`
    return `${Math.floor(gap / HOUR)} 小时前`
  }
  if (days === -1) return `昨天 ${clock(ts)}`
  // 30 天以外不再数天数：人在那个尺度上认的是日期，不是"第几天"。
  if (-days <= 30) return `${-days} 天前`
  return dayKey(ts)
}

// 解析不了返回 null，不抛：调用方要能把它变成"退出码 2 + 怎么改"，而不是一屏栈。
// '21:40' 按今天算，即使已经过去——"过期了要不要说"是上层的事，不是解析器的事。
export function parseWhen(s, nowTs) {
  if (typeof s !== 'string') return null
  const text = s.trim()
  if (text === '') return null
  const base = Number.isFinite(nowTs) ? nowTs : null

  const span = P_SPAN.exec(text)
  if (span) {
    if (base === null) return null
    const n = Number(span[1])
    if (!Number.isFinite(n)) return null
    return base + n * (span[2] === 'd' ? DAY : span[2] === 'h' ? HOUR : MINUTE)
  }

  const full = P_DAY.exec(text)
  if (full) {
    const parts = [Number(full[1]), Number(full[2]), Number(full[3])]
    return build(parts[0], parts[1], parts[2], num(full[4], 0), num(full[5], 0), num(full[6], 0))
  }

  const clockOnly = P_CLOCK.exec(text)
  if (clockOnly) {
    if (base === null) return null
    const d = new Date(base)
    return build(d.getFullYear(), d.getMonth() + 1, d.getDate(), Number(clockOnly[1]),
      Number(clockOnly[2]), num(clockOnly[3], 0))
  }

  const word = P_WORD.exec(text)
  if (word) {
    if (base === null) return null
    const from = new Date(base)
    // 先让 Date 把"12 月 31 日的明天"进位到 1 月 1 日，再把结果拆回年月日：
    // 直接拿 day+1 去校验会误判成不存在的日期。
    const target = new Date(from.getFullYear(), from.getMonth(), from.getDate() + WORD_DAYS.get(word[1]))
    const hh = word[2] === undefined ? 0 : Number(word[2])
    const mm = word[3] === undefined ? 0 : Number(word[3])
    return build(target.getFullYear(), target.getMonth() + 1, target.getDate(), hh, mm, num(word[4], 0))
  }

  return null
}

// 一律走本地构造函数：new Date('2026-11-13') 会把无时区日期当 UTC 零点，
// 东八区差 8 小时、纽约差一天（AGENTS 六）。这里也顺手挡掉 2026-02-30 这种进位日期。
function build(y, mo, day, hh, mm, ss) {
  if (!inRange(y, 1970, 9999) || !inRange(mo, 1, 12) || !inRange(day, 1, 31)) return null
  if (!inRange(hh, 0, 23) || !inRange(mm, 0, 59) || !inRange(ss, 0, 59)) return null
  const d = new Date(y, mo - 1, day, hh, mm, ss)
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null
  return d.getTime()
}

// 只取本地日历三元组折算天数：夏令时那天不是 24 小时，用毫秒差除以 DAY 会算出 0.958 天。
function dayIndex(ts) {
  const d = new Date(ts)
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY)
}

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toDate(ts) {
  if (!Number.isFinite(ts)) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

// dayStart 越界就按 0 算：这是配置值，不该让一次手误把整条事件流写到 '.jsonl' 里去。
function dayStartHours(v) {
  // 配置里存的是 `HH:MM`（config 的 clock 类型），这里认两种写法：整点数字与字符串。
  // 日界的解释只有这一处——两个调用方各转一次，迟早转出两个"今天"。
  if (typeof v === 'string') {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim())
    if (m === null) return 0
    return Number(m[1])
  }
  if (!Number.isFinite(v)) return 0
  const n = Math.trunc(v)
  return n >= 0 && n <= 23 ? n : 0
}

function inRange(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi
}

function num(v, fallback) {
  return v === undefined ? fallback : Number(v)
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}
