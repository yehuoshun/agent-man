// decay 只放纯函数（design §14.7 / §14.14）：不碰文件、不读时钟，同一份刺激日志重放得同一数值。
// 半衰期、量程、基线一律从 core 门面拿，这里一个数字都不抄（design §10：常数只有一处）。
import {
  AFFECT_BASE, AFFECT_EMOTION_HALF, AFFECT_ENERGY_HALF, AFFECT_MOOD_HALF,
  AFFECT_MOOD_HALF_NEG, AFFECT_RESPECT_HALF, AFFECT_TRUST_HALF,
} from '../core/index.mjs'

// 四轴的定义（design §14.1）：量程、基线、半衰期。只有愉悦轴的负向另有一套半衰期——
// 8h/13h 是"心情"的参数；信任 60d、尊重 90d 没有第二套数（§14.14.1 只谈心情）。
export const AXES = Object.freeze({
  v: { base: AFFECT_BASE.v, half: AFFECT_MOOD_HALF, negHalf: AFFECT_MOOD_HALF_NEG, lo: 0, hi: 100 },
  e: { base: AFFECT_BASE.e, half: AFFECT_ENERGY_HALF, negHalf: AFFECT_ENERGY_HALF, lo: 0, hi: 100 },
  t: { base: AFFECT_BASE.t, half: AFFECT_TRUST_HALF, negHalf: AFFECT_TRUST_HALF, lo: 0, hi: 100 },
  r: { base: AFFECT_BASE.r, half: AFFECT_RESPECT_HALF, negHalf: AFFECT_RESPECT_HALF, lo: -100, hi: 100 },
})

export const AXIS_NAMES = Object.freeze(Object.keys(AXES))

// 瞬时情绪的半衰期也放一处：label.transient 与 snapshot 用同一个数，不各写一遍。
export const EMOTION_HALF = AFFECT_EMOTION_HALF

// 指数半衰期（design §14.7 第一式）。i0<=0 → 0、dt<0 按 0 算：这两个边界是给
// "强度"用的——带符号的偏移走 decayOffset，别在这里塞负数硬圆。
export function decay(i0, dt, half) {
  const i = Number.isFinite(i0) ? i0 : 0
  if (i <= 0) return 0
  const span = Number.isFinite(dt) && dt > 0 ? dt : 0
  const h = Number.isFinite(half) && half > 0 ? half : Infinity
  if (span === 0) return i
  return i * 0.5 ** (span / h)
}

// 同类叠加（design §14.7 第二式）：ln(e^a + e^b)，3 次同级 ≈ 1.1 倍，不是 3 倍。
// merge(0,x)=x 是 design §14.8 明写的：ln(e^0+e^x) 会多出 ln(1+e^-x)，所以零单独返回。
export function mergeStim(a, b) {
  const x = Number.isFinite(a) ? a : 0
  const y = Number.isFinite(b) ? b : 0
  if (x === 0) return y
  if (y === 0) return x
  // 先提公因子再 log1p：直接算 e^big 会在 big 稍大时溢出成 Infinity。
  const big = Math.max(x, y)
  const small = Math.min(x, y)
  return big + Math.log1p(Math.exp(small - big))
}

// design §7 的表里叫 merge；简报叫 mergeStim。两个名字同一个函数，免得调用方各记一套。
export const merge = mergeStim

// 一根轴从 current 向 base 回落，不穿越基线（design §14.14.1）：
// v 从 90 落回 50 就停在 50，不会因为"刺激过期"掉到 20。
export function axis(current, base, { half, negHalf = half, dt } = {}) {
  const from = Number.isFinite(base) ? base : 0
  const cur = Number.isFinite(current) ? current : from
  const off = cur - from
  if (off === 0) return from
  // 负向用 negHalf：坏心情走得慢。方向由"当前值相对基线"决定，不由调用方另传标志。
  const h = off < 0 ? negHalf : half
  const gone = decay(Math.abs(off), dt, h) * Math.sign(off)
  // 符号变了就停在基线：衰减只逼近，不越过去。
  if (Math.sign(gone) !== Math.sign(off)) return from
  return from + gone
}

// 带符号的偏移衰减：把"离基线多远"当成强度，走 axis 的同一条路。
// 轴的半衰期只在这里挑一次，调用方不用记哪根轴该用哪个数。
export function decayOffset(off, dt, name) {
  const spec = AXES[name]
  if (!spec) throw new TypeError(`未知的轴：${String(name)}（只认 ${AXIS_NAMES.join(' / ')}）`)
  if (!Number.isFinite(off) || off === 0) return Number.isFinite(off) ? off : 0
  const half = off < 0 ? spec.negHalf : spec.half
  return axis(off, 0, { half, negHalf: half, dt })
}

// 带符号的叠加：同向走 LSE（同类叠加上限），反向直接抵消。
// 反向往对数域硬凑没有意义——"被夸一次、被骂一次"本来就该互相扣掉。
export function mergeOffset(a, b) {
  const x = Number.isFinite(a) ? a : 0
  const y = Number.isFinite(b) ? b : 0
  if (x === 0) return y
  if (y === 0) return x
  if (x < 0 !== y < 0) return x + y
  const sign = x < 0 ? -1 : 1
  return sign * mergeStim(Math.abs(x), Math.abs(y))
}

// 数值恒在量程内（简报硬规则）：v/e/t ∈ [0,100]，r ∈ [−100,100]。
export function clampAxis(name, value) {
  const spec = AXES[name]
  if (!spec) throw new TypeError(`未知的轴：${String(name)}（只认 ${AXIS_NAMES.join(' / ')}）`)
  const v = Number.isFinite(value) ? value : spec.base
  if (v < spec.lo) return spec.lo
  if (v > spec.hi) return spec.hi
  return v
}
