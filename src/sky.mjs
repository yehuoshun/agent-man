/**
 * 看天气的纯逻辑：天况怎么说、变了什么。
 *
 * 这里不联网、不读文件、不看时钟——取数在 src/net.mjs，读写在 src/store.mjs。
 * 全部输入从参数进来，所以可以用死的快照测。
 *
 * 门槛为什么这么定（§25）：
 * 每天涨两度不叫新闻，天天报就成了噪音，前面攒的降噪全白做。所以只报"变了"：
 * 天况换类、最高温跳 >=5℃、有雨（>=1mm）而上次没有、第一次进极热极冷。
 * 这些数字没有数据支撑，是先验；有真实抱怨了再改。
 */

/** 有降水（毫米）。毛毛雨不算"要带伞"，1mm 起算。 */
export const WET_MM = 1

/** 最高温差多少度算变了天。 */
export const JUMP_C = 5

/** 极热 / 极冷的门槛。 */
export const HOT_C = 35
export const COLD_C = 0

/** 缓存多久算新鲜：调度器可能每小时调一次，别每次都打一次天气源。 */
export const STALE_MS = 30 * 60e3

/**
 * 缓存最多留多久：比一天还旧的数就不再当它说过话。
 *
 * 天况说的是"今天外面什么样"，隔了一天的数已经不是一个东西了；
 * 给它说话的资格，等于把前天的雨说成今天的（§25）。
 */
export const MAX_AGE_MS = 24 * 60 * 60e3

/**
 * now 落在 tz 的哪一天（'YYYY-MM-DD'）。
 *
 * 天气源给的日期是**它那个时区**的日历日，跟本机的不一定是同一天：
 * 人在东八区、地方在纽约，"今天"差十三个小时。
 * 时区名不认识就退回本机日历日——不猜，也不拿 UTC 硬顶。
 */
export function sourceDay(now, tz = null) {
  const d = new Date(now)
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d)
    } catch {
      // 落到下面：用本机的日历日
    }
  }
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** '2026-11-11' → '11 月 11 日'：别把日期原样倒给读者。 */
export function dateText(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''))
  if (!m) return String(date ?? '那天')
  return `${Number(m[2])} 月 ${Number(m[3])} 日`
}

/**
 * 这份缓存还能怎么用（§25）。
 *
 *   none       没有（或读坏了）——联网失败就直说，没有旧数可退
 *   fresh      半小时内取的、同一天——不联网
 *   same-day   同一天，只是旧了点——能用，联网失败时提一句
 *   cross-day  存的那天已经不是今天——不许说"今天"，只能当"上次看到的样子"
 *   too-old    超过一天——当没有，宁可说没数
 *
 * 判跨日看的是数据里那个日期（daily[0].date = 取数那天源时区的今天），不是
 * rec.at：at 是"什么时候取的"，跟"这份数说的是哪一天"是两件事。昨晚 23:50
 * 取的数和今早取的数只差八小时，说的却是两天。
 */
export function cacheState(rec, { now = Date.now(), tz = null } = {}) {
  const data = rec?.data
  const at = rec?.at
  if (!data || !Number.isFinite(at)) return 'none'
  if (now - at > MAX_AGE_MS) return 'too-old'
  const day = data.daily?.[0]?.date
  if (typeof day !== 'string' || day !== sourceDay(now, tz)) return 'cross-day'
  return now - at < STALE_MS ? 'fresh' : 'same-day'
}

/**
 * WMO weather code → 中文。只收会出现的那些，未知码照实说"未知天况(N)"，
 * 不猜成"多云"——猜错比空着更糟。
 */
const CODES = new Map([
  [0, '晴'],
  [1, '晴间多云'],
  [2, '多云'],
  [3, '阴'],
  [45, '雾'],
  [48, '冻雾'],
  [51, '毛毛雨'],
  [53, '小雨'],
  [55, '中雨'],
  [56, '冻毛毛雨'],
  [57, '冻雨'],
  [61, '小雨'],
  [63, '中雨'],
  [65, '大雨'],
  [66, '冻雨'],
  [67, '强冻雨'],
  [71, '小雪'],
  [73, '中雪'],
  [75, '大雪'],
  [77, '雪粒'],
  [80, '阵雨'],
  [81, '中阵雨'],
  [82, '强阵雨'],
  [85, '阵雪'],
  [86, '强阵雪'],
  [95, '雷阵雨'],
  [96, '雷阵雨伴冰雹'],
  [99, '强雷阵雨伴冰雹'],
])

/**
 * 天况归一成几类。判"换类"比判"换了代码"稳：
 * 小雨 61 / 中雨 63 是同一种天，上午报一次下午再报一次就是啰嗦。
 */
export function skyKind(code) {
  if (code === 0 || code === 1) return '晴'
  if (code === 2 || code === 3) return '阴'
  if (code >= 71 && code <= 77) return '雪'
  if (code === 85 || code === 86) return '雪'
  if (code >= 51 && code <= 67) return '雨'
  if (code >= 80 && code <= 82) return '雨'
  if (code >= 95) return '雨'
  if (code === 45 || code === 48) return '雾'
  return '未知'
}

export function skyText(code) {
  return CODES.get(code) ?? `未知天况(${code})`
}

/** 把 API 回来的东西拍平成快照：只留判定要用的字段。 */
export function snapshotOf(sky) {
  const day = sky.daily?.[0]
  if (!day) throw new Error('天气源没给今天的预报，没法判断外面什么样')
  return {
    at: sky.at,
    date: day.date,
    code: sky.current.code,
    temp: sky.current.temp,
    tmax: day.tmax,
    tmin: day.tmin,
    precip: day.precip,
  }
}

/**
 * 该不该说、说什么。
 *
 * prev 是"上次说过的快照"。没有 prev 就是第一次——第一次一定要说，
 * 否则要等它变化才知道外面什么样，那是本末倒置。
 */
export function judgeSky(sky, prev) {
  const now = snapshotOf(sky)
  const head = `${skyText(now.code)}，${round(now.temp)}℃`
  const wet = now.precip >= WET_MM ? `，雨 ${round(now.precip)}mm` : ''
  const today = `今天 ${round(now.tmin)}–${round(now.tmax)}℃${wet}`
  const tomorrow = sky.daily?.[1]
  const next = tomorrow ? `明天 ${round(tomorrow.tmin)}–${round(tomorrow.tmax)}℃` : null
  const lines = [head, next ? `${today}，${next}` : today]
  if (!prev) {
    return { speak: true, fresh: true, changes: [], lines, snapshot: now }
  }

  const changes = []
  if (skyKind(prev.code) !== skyKind(now.code)) {
    changes.push(`${skyText(prev.code)}变${skyText(now.code)}`)
  }
  if (Math.abs(now.tmax - prev.tmax) >= JUMP_C) {
    changes.push(`最高 ${round(prev.tmax)}→${round(now.tmax)}℃`)
  }
  if (now.precip >= WET_MM && prev.precip < WET_MM) {
    changes.push(`要下雨 ${round(now.precip)}mm`)
  }
  if (now.tmax >= HOT_C && prev.tmax < HOT_C) changes.push(`热，最高 ${round(now.tmax)}℃`)
  if (now.tmin <= COLD_C && prev.tmin > COLD_C) changes.push(`冷，最低 ${round(now.tmin)}℃`)

  return { speak: changes.length > 0, fresh: false, changes, lines, snapshot: now }
}

function round(n) {
  return Math.round(n * 10) / 10
}
