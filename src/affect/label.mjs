// label 只管"数值 → 词"（design §14.2 / §14.3 / §14.4）：16 格、五段、持久情绪、瞬时情绪。
// 用词逐字照 design 抄——换模型、换语言、换灵魂都不许改这些字（§14.2：格子只由两个数决定）。
import { AFFECT_BASE, AFFECT_DEADBAND, AFFECT_HYST } from '../core/index.mjs'
import { decay, EMOTION_HALF } from './decay.mjs'

// 16 格：行 = 愉悦（高 65+ / 中高 51–64 / 中低 36–50 / 低 ≤35），
// 列 = 精力（高 76+ / 中 51–75 / 低中 26–50 / 低 ≤25）。顺序照 §14.2 的表。
export const MOODS = Object.freeze([
  Object.freeze(['兴奋', '愉快', '满足', '平静']),
  Object.freeze(['期待', '轻松', '平淡', '慵懒']),
  Object.freeze(['紧张', '不安', '疲倦', '低落']),
  Object.freeze(['焦躁', '烦躁', '沮丧', '消沉']),
])

// 档位分界（表的整数写法）：v 的 65 / 51 / 35，e 的 76 / 51 / 25。
// 表按整数写，"36–50"与"≤35"之间留了 1 分缝；小数取中点 35.5，否则 35.7 会无家可归。
const V_EDGES = Object.freeze([65, 51, 35.5])
const E_EDGES = Object.freeze([76, 51, 25.5])

// 词 → 它所在的格子：滞回要问"上一格在哪"，只能靠这张反查表。
const CELL_OF = new Map()
MOODS.forEach((row, r) => row.forEach((mood, c) => CELL_OF.set(mood, { row: r, col: c })))

function indexOf(value, edges) {
  for (let i = 0; i < edges.length; i += 1) if (value >= edges[i]) return i
  return edges.length
}

// 不在 0–100 的值（NaN、null、写错的数字）按基线算：宁可报"没变"，也不报一个靠猜的标签。
function bounded(value, fallback) {
  const v = Number.isFinite(value) ? value : fallback
  if (v < 0) return 0
  if (v > 100) return 100
  return v
}

// 16 格之一（design §14.2）：(52,61) 恒为"平淡"——这一条是网格的全部意义。
// prev 给上一格的词时走滞回：新格子要越过边界 AFFECT_HYST 分才真换（§14.8 抖动 ≤1 次）。
// 死区（§14.2 末）：两轴都贴着基线就算"没变"，标签不刷新。
export function moodOf(v, e, prev) {
  const x = bounded(v, AFFECT_BASE.v)
  const y = bounded(e, AFFECT_BASE.e)
  const row = indexOf(x, V_EDGES)
  const col = indexOf(y, E_EDGES)
  const was = typeof prev === 'string' ? CELL_OF.get(prev) : undefined
  if (!was) return MOODS[row][col]
  if (was.row === row && was.col === col) return prev
  if (deadband(x, y)) return prev
  if (was.row !== row && !pastEdge(x, V_EDGES, was.row, row)) return prev
  if (was.col !== col && !pastEdge(y, E_EDGES, was.col, col)) return prev
  return MOODS[row][col]
}

// 跨档只跨"一条边界"：往低档跨的是本档的下沿，往高档跨的是目标档的下沿。
function pastEdge(value, edges, from, to) {
  const edge = to > from ? edges[from] : edges[to]
  return Math.abs(value - edge) >= AFFECT_HYST
}

// 死区（design §14.2 末 / §14.8）：两轴同时贴着基线就当"没变"。只影响措辞，不改数值。
export function deadband(v, e) {
  const x = bounded(v, AFFECT_BASE.v)
  const y = bounded(e, AFFECT_BASE.e)
  const near = Math.abs(x - AFFECT_BASE.v) < AFFECT_DEADBAND
  const calm = Math.abs(y - AFFECT_BASE.e) < AFFECT_DEADBAND
  return near && calm
}

// 尊重轴五段（design §14.4 的语气参照；表里没给分界，这里按对称取整）：
// 敬重 ≥60、认可 20–59、中性 −19–19、不以为然 −59–−20、厌恶 ≤−60。
export function respectBand(r) {
  const x = Number.isFinite(r) ? r : AFFECT_BASE.r
  if (x >= 60) return '敬重'
  if (x >= 20) return '认可'
  if (x > -20) return '中性'
  if (x > -60) return '不以为然'
  return '厌恶'
}

// 持久情绪（design §14.4）：由尊重轴推出，随 r 恢复而退。
// 厌恶/轻蔑两行的条件与用词照 design 逐字；厌弃 是"厌恶"的更重一档（r 掉到 −70 以下），
// 失望 是 design §14.4 第三行（信任低、尊重仍正常）。每一条都带 why——透明，不许静默记仇。
export function persistent({ t, r } = {}) {
  const trust = Number.isFinite(t) ? t : AFFECT_BASE.t
  const respect = Number.isFinite(r) ? r : AFFECT_BASE.r
  const show = (x) => String(Math.round(x * 10) / 10)
  if (respect <= -40) {
    if (trust < 50) {
      if (respect <= -70) {
        return { kind: '厌弃', why: `尊重 ${show(respect)}（≤ −70）且信任 ${show(trust)}（< 50）` }
      }
      return { kind: '厌恶', why: `尊重 ${show(respect)}（≤ −40）且信任 ${show(trust)}（< 50）` }
    }
    const why = `尊重 ${show(respect)}（≤ −40）但信任 ${show(trust)}（≥ 50）：认可能力，不认可人品`
    return { kind: '轻蔑', why }
  }
  if (trust <= 30) {
    return { kind: '失望', why: `信任 ${show(trust)}（≤ 30），尊重仍正常：随兑现恢复` }
  }
  return { kind: null, why: '' }
}

// 瞬时情绪（design §14.3）：只活 45 分钟，最多 3 条，不进网格、不改长期轴。
// 最小实现：交回"还在半衰期里、压得住格"的那几条刺激本身（带 kind + why + 剩余强度）。
// §14.3 的六个名字（惊讶/愤怒/委屈/尴尬/愧疚/感动）需要一张"触发 → 情绪"的表，
// 而 §14.7 的封闭枚举不包含那些触发——没有映射就不编（§14.10 禁止猜），缺的是那张表。
export function transient(stims, nowTs, { limit = 3 } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : 0
  const live = []
  for (const one of Array.isArray(stims) ? stims : []) {
    if (!one || typeof one !== 'object') continue
    if (!Number.isFinite(one.at)) continue
    const dt = at - one.at
    if (dt < 0 || dt > EMOTION_HALF) continue
    live.push({ kind: one.kind, why: one.why, at: one.at, left: decay(1, dt, EMOTION_HALF) })
  }
  // 只认时间差，同毫秒保持日志顺序（Array#sort 稳定）。
  live.sort((a, b) => b.at - a.at)
  const max = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 3
  return live.slice(0, max)
}
