// 检索分 = 0.6·R + 0.4·cue（design §5）。两个加数都在这里定死，权重不许改：
// 改权重就是改设计，而设计是唯一真源。
import { SCORE_CUE, SCORE_R, jaccard, tokens } from '../core/index.mjs'
import { atOf, idOf, strength, textOf } from './strength.mjs'

// 线索只认"同样的字出现没出现"（design §2 诚实放弃）：中文二元组、英文按词。
// 同义改写查不到是设计选择，不是等待修复的 bug——所以这里也不偷偷加模糊匹配。
export function cue(query, rec) {
  const asked = tokens(query)
  // 空查询不加分：给 0 就退化成"只按保留率排"，给 1 会把毫不相干的条目顶到最前。
  if (asked.length === 0) return 0
  // cues ∪ text：线索常常只写在 cues 里（design §4），正文里不一定有原话。
  // 用空格拼再接 tokens：两块之间不会长出跨界的假二元组。
  const bag = []
  if (Array.isArray(rec?.cues)) for (const c of rec.cues) if (typeof c === 'string') bag.push(c)
  bag.push(textOf(rec))
  return jaccard(asked, tokens(bag.join(' ')))
}

// design §7 的 score(rec,q,now,kind)：只要分数，不要中间量。
export function score(rec, query, now, kind) {
  return evaluate(rec, { now, query, kind }).score
}

// 排序只认分数、时间、id 三段，末段是"完全相同的两条"也不能靠引擎的稳定性兜底：
// 同一批数据换台机器、换个 Node 版本，次序必须一字不差（AGENTS 五）。
export function rank(cands, { now, query = '', kind } = {}) {
  if (!Array.isArray(cands)) throw new TypeError('rank 需要候选数组：调用方先读盘，再交过来')
  const rows = cands.map((rec, seq) => ({ ...evaluate(rec, { now, query, kind }), seq }))
  rows.sort(compare)
  // seq 只用来给最后一级 tie-break 一个确定值，不往外漏。
  return rows.map(({ seq, ...entry }) => entry)
}

// design §7 的 sortByScore(items,q,now,kind)：与 rank 同一份次序，只是参数位置照设计走。
export function sortByScore(items, query, now, kind) {
  return rank(items, { now, query, kind })
}

// 返回的是记录的副本 + 四个算出来的字段：调用方（fit / view）拿到就能用，
// 而传进来的对象一个都不改——候选可能还是 store 的缓存。
function evaluate(rec, { now, query, kind }) {
  const base = isObject(rec) ? rec : {}
  const s = strength(base, now, kind)
  const c = cue(query, base)
  return {
    ...base,
    id: idOf(base), // 缺 id 也给字符串：下游要拿它做码位比较，undefined 会炸
    at: atOf(base), // 缺 at 归一到 0（1970），比较不会出 NaN
    kind: s.kind,
    S: s.S,
    R: s.R,
    cue: c,
    score: SCORE_R * s.R + SCORE_CUE * c,
  }
}

function compare(a, b) {
  if (a.score !== b.score) return b.score - a.score
  if (a.at !== b.at) return b.at - a.at // 同分新的在前；at 是数字，直接减（AGENTS 五）
  const byId = compareCodePoint(a.id, b.id)
  return byId !== 0 ? byId : a.seq - b.seq
}

// 码位序，不用 localeCompare：后者受 ICU 版本与语言环境影响，'r-Z' 与 'r-a' 这类
// 大小写混排的 id 在不同机器上会排出两种次序，而审计账本要能逐位对上。
function compareCodePoint(a, b) {
  const left = Array.from(a)
  const right = Array.from(b)
  const common = Math.min(left.length, right.length)
  for (let i = 0; i < common; i += 1) {
    const diff = left[i].codePointAt(0) - right[i].codePointAt(0)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

function isObject(v) {
  return typeof v === 'object' && v !== null
}
