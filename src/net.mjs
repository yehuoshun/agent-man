/**
 * 联网取数。全部副作用都在这一层：进程外只有 HTTP，没有别的。
 *
 * 用 Open-Meteo 而不是商业天气 API：不要 key、不要注册、不要签名算法，
 * 少一个凭据就少一件会过期的东西（§25）。代价是它只给数值和 WMO 码，
 * 中文说法得自己在 src/sky.mjs 里对。
 *
 * 不常驻（§22）：这里没有定时器、没有重试循环、没有本地缓存服务——
 * 被叫一次就得一次结果，拿不到就报错，由调用方决定用旧数还是这次不说。
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const SKY_URL = 'https://api.open-meteo.com/v1/forecast'

/** 八秒还没有响应就当它不在——调度器在等我，不该被一个天气源拖住。 */
const TIMEOUT_MS = 8000

async function fetchJson(url) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new Error(`连不上天气源（${e.message}）；这次没取到数`)
  }
  if (!res.ok) throw new Error(`天气源回了 ${res.status}；这次没取到数`)
  try {
    return await res.json()
  } catch {
    throw new Error('天气源回的不是 JSON；这次没取到数')
  }
}

/**
 * 城市名 → 坐标。只做一次，结果存进 state/place.json：
 * 每次看天都先查一遍地名，是把"我住在哪"当成变量，那是另一件事。
 */
export async function geocode(name) {
  const q = encodeURIComponent(name.trim())
  const url = `${GEO_URL}?name=${q}&count=1&language=zh&format=json`
  const j = await fetchJson(url)
  const hit = j?.results?.[0]
  if (!hit) throw new Error(`没找到“${name}”这个地方；换个写法试试（中文、拼音或英文都行）`)
  const lat = Number(hit.latitude)
  const lon = Number(hit.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`天气源给的坐标不是数（${hit.latitude}, ${hit.longitude}），不敢用`)
  }
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join('，'),
    short: hit.name,
    lat,
    lon,
    tz: hit.timezone || null,
  }
}

/**
 * 取现在和今明两天。
 *
 * 只取判定要用的字段：温度、天况码、最高最低、降水。
 * 多取的字段不会让人更懂天气，只会让快照更难比（§25）。
 */
export async function fetchSky(place, { now = Date.now() } = {}) {
  const p = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: 'temperature_2m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: place.tz || 'auto',
    forecast_days: '2',
  })
  const j = await fetchJson(`${SKY_URL}?${p}`)
  const cur = j?.current
  const d = j?.daily
  if (!cur || !d?.time?.length) throw new Error('天气源没给现在和预报；这次没取到数')

  const num = (v, what) => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`天气源给的${what}不是数（${v}），不敢用`)
    return n
  }

  return {
    at: now,
    place: place.short || place.name,
    current: {
      temp: num(cur.temperature_2m, '气温'),
      code: num(cur.weather_code, '天况码'),
    },
    daily: d.time.map((date, i) => ({
      date,
      tmax: num(d.temperature_2m_max?.[i], '最高温'),
      tmin: num(d.temperature_2m_min?.[i], '最低温'),
      precip: num(d.precipitation_sum?.[i] ?? 0, '降水量'),
    })),
  }
}
