// 保留率只回答一个问题：这条记录现在还剩下多少可信（design §5）。
// 纯函数：now 由调用方传，这里绝不读时钟——否则"越旧越低"只能用碰运气来断言（AGENTS 二·3）。
// 同层的 rank / budget / pick 都要认记录的形状（哪一层、正文在哪、何时发生），
// 与其四个文件各认一遍，不如让这些一眼能看出的字段跟 kindOf 一起住在这里。
import { S0_EVENT, S0_MEMORY, S0_RULE } from '../core/index.mjs'

// §10 的 S0 与层一一对应。表里只有这三个名字：别的字符串一律当作"认不出"，
// 不去猜"events"还是"event"以外的写法。
const S0 = new Map([['event', S0_EVENT], ['memory', S0_MEMORY], ['rule', S0_RULE]])

// design §6 的 --imp 只收 0-3，写盘时 schema 会拒。这里再夹一次：手改过的 JSONL 也能被读进来，
// 一条 imp 写成 1e9 的记录会让 S 变成几亿年，把"会忘"变成一句谎话。
const IMP_MAX = 3

// 层的三个字段线索里，id 前缀最硬（发号格式见 design §3）。没有 id 时才看字段：
// 结论有 key / fact，规矩有 why / supersedes。
export function kindOf(rec, kind) {
  const asked = normalizeKind(kind)
  if (asked) return asked
  const id = idOf(rec)
  if (id.startsWith('e-')) return 'event'
  if (id.startsWith('m-')) return 'memory'
  if (id.startsWith('r-')) return 'rule'
  if (isObject(rec) && (rec.key !== undefined || rec.fact !== undefined)) return 'memory'
  if (isObject(rec) && (rec.why !== undefined || rec.supersedes !== undefined)) return 'rule'
  // 都认不出就按情景：S0 最小、衰减最快。认错时宁可少留一条，也不把来历不明的记录
  // 说得比它更可信——保留率是"会忘"的账，夸大了就没人信。
  return 'event'
}

export function idOf(rec) {
  return isObject(rec) && typeof rec.id === 'string' ? rec.id : ''
}

// 正文的位置按层不一样：情景与规矩是 text，结论是 fact（design §4）。
// 少了这层兜底，结论会被当成空正文——空条目的 cost 只有行开销，会白占一屏的位置。
export function textOf(rec) {
  if (!isObject(rec)) return ''
  if (typeof rec.text === 'string') return rec.text
  if (typeof rec.fact === 'string') return rec.fact
  return ''
}

// 缺 at 时给 0（1970）：它是"最旧"，同分排序里排最后，而不会让比较出 NaN（AGENTS 五）。
export function atOf(rec) {
  return isObject(rec) && Number.isFinite(rec.at) ? rec.at : 0
}

// kind 是可选第三参：design §7 的 retention(rec,now,kind) 把层当参数传，
// 而 fit / rank 更希望从记录自己认出来，两条路在这里合流。
export function strength(rec, now, kind) {
  const at = requireNow(now)
  const layer = kindOf(rec, kind)
  const S = S0.get(layer) * (1 + 2 * impOf(rec)) * (1 + Math.log1p(seenOf(rec)))
  // 规矩几乎不衰减（design §2）：S0 是 ∞，exp(-x/∞) 本来也会算成 1，这里仍然写死 1——
  // "永不消退"是规矩的定义，不该依赖浮点数的一次巧合。
  if (layer === 'rule') return { kind: layer, S, R: 1 }
  // 没有 at 就不知道有多旧。给 0 是保守的：不知道就别当成还新。
  if (!isObject(rec) || !Number.isFinite(rec.at)) return { kind: layer, S, R: 0 }
  const R = Math.exp(-(at - rec.at) / S)
  // 未来的 at（计划的 when 被误当 at）会让 R > 1。夹到 [0,1]：没有"比完好更完好"。
  return { kind: layer, S, R: Number.isFinite(R) ? clamp01(R) : 0 }
}

// design §7 的 retention：只要 R，不要 S。kind 传了就以传入的为准。
export function retention(rec, now, kind) {
  return strength(rec, now, kind).R
}

// 不给 now 就报错，不退回 Date.now()：静默读时钟会让"时间只解释一次"（AGENTS 二·3）
// 在这里破一个口子，而且破得没人看得见。
function requireNow(now) {
  if (!Number.isFinite(now)) throw new TypeError('recall 需要调用方传 now（epoch ms）：这一层不读时钟')
  return now
}

function normalizeKind(kind) {
  if (typeof kind !== 'string') return ''
  const name = kind.toLowerCase().replace(/s$/, '')
  return S0.has(name) ? name : ''
}

function impOf(rec) {
  const v = isObject(rec) ? rec.imp : 0
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > IMP_MAX ? IMP_MAX : v
}

// seen 是"被复述过几次"（design §5：只在 digest 选进摘要时 +1）。
// 负数没有意义，夹到 0；上限不给，ln 自己长得够慢。
function seenOf(rec) {
  const v = isObject(rec) ? rec.seen : 0
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v
}

function clamp01(v) {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function isObject(v) {
  return typeof v === 'object' && v !== null
}
