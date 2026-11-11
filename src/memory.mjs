import { cost } from './cost.mjs'
import { dayKey, parseAt } from './time.mjs'

/**
 * 长期层：模型整理出来的条目。
 *
 * 脚本在这里只做四件事：校验、发号、判断谁被谁取代、挑哪些进摘要。
 * 它不总结、不合并、不猜——那是模型的活（见 docs/decisions.md#11）。
 */

export const TIERS = [0, 1, 2]

/**
 * 新建一条长期记忆。校验放在写入之前：坏条目进不了文件。
 *
 * `refs` 是硬要求——没有出处的长期条目是一段无法验证的改写，漂移了没人发现。
 * 真需要一条无出处的判断，用 `noRefs` 明说。
 */
export function makeItem(input, { now = Date.now(), existing = [] } = {}) {
  const topic = String(input.topic ?? '').trim()
  const fact = String(input.fact ?? '').trim()
  if (!topic) throw new Error('长期条目要有 --topic：一句话说的是哪个主题（例：她怕冷）')
  if (!fact) throw new Error('长期条目要有事实内容：agent-man remember "入秋后先关窗再抱怨风" --topic 她怕冷')

  const tier = Number(input.tier ?? 0)
  if (!TIERS.includes(tier)) throw new Error(`--tier 只能是 0/1/2，收到 ${input.tier}`)

  const at = parseAt(input.at, { now })
  const from = parseAt(input.from ?? at, { now })
  const to = parseAt(input.to ?? at, { now })
  if (to < from) throw new Error('--span-to 早于 --span-from：覆盖范围写反了')

  const refs = splitList(input.refs)
  if (!refs.length && !input.noRefs) {
    throw new Error('长期条目要带 --refs（指向原文的日期或时间）；确实没有出处就加 --no-refs')
  }

  const weight = Number(input.weight ?? 0)
  if (!Number.isInteger(weight) || weight < 0 || weight > 3) throw new Error(`--weight 只能是 0..3，收到 ${input.weight}`)

  const item = {
    id: String(input.id ?? nextId(dayKey(at), existing)),
    at,
    tier,
    batch: String(input.batch ?? dayKey(at)),
    topic,
    fact,
    span: { from, to },
    refs,
    supersedes: splitList(input.supersedes),
  }
  if (weight) item.weight = weight
  return item
}

/** 同一天内顺序发号，看文件就能读出先后。并发写同一文件不在考虑范围内（单人 CLI）。 */
function nextId(day, existing) {
  let n = 0
  for (const it of existing) {
    if (typeof it.id === 'string' && it.id.startsWith(`${day}-`)) n++
  }
  return `${day}-${String(n + 1).padStart(2, '0')}`
}

function splitList(v) {
  if (v === undefined || v === null || v === true) return []
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 被别的条目 supersedes 掉的 id。不改旧行，只在这里算"谁还活着"。 */
export function supersededIds(items) {
  const dead = new Set()
  for (const it of items) for (const id of it.supersedes ?? []) dead.add(id)
  return dead
}

export function activeItems(items) {
  const dead = supersededIds(items)
  return items.filter((it) => !dead.has(it.id))
}

/**
 * 挑哪些长期条目进摘要。
 *
 * 顺序：tier 小的先说（近期整理比永久结论更需要被看见），同 tier 里
 * 权重高的、覆盖范围靠后的先说。放不下就跳过并记 drops——和 budget.mjs 同一规矩。
 */
export function selectMemory(items, { budget, now = Date.now(), dayStart = 0 } = {}) {
  if (!(budget > 0)) return { shown: [], drops: items.map((it) => ({ ...it, why: 'no-room' })), used: 0, superseded: 0 }

  const live = activeItems(items)
  const ordered = [...live].sort(
    (a, b) =>
      (a.tier ?? 0) - (b.tier ?? 0) ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      (b.span?.to ?? b.at ?? 0) - (a.span?.to ?? a.at ?? 0),
  )

  const shown = []
  const drops = []
  let used = 0
  for (const it of ordered) {
    const charge = memoryCost(it, { now, dayStart })
    if (used + charge <= budget) {
      shown.push({ ...it, charge })
      used += charge
    } else {
      drops.push({ ...it, why: 'no-room' })
    }
  }
  return { shown, drops, used, superseded: items.length - live.length }
}

/**
 * 一条长期条目占多少预算。
 * 行格式必须和 render.mjs 里输出的一致，否则账又对不上。
 */
export function memoryCost(it, opts = {}) {
  return cost(longLine(it, opts))
}

/** `- 主题：结论（覆盖范围）`。refs 不渲染——它是指针，不是给人读的正文。 */
export function longLine(it, { dayStart = 0 } = {}) {
  const span = spanLabel(it.span, { dayStart })
  return `- ${it.topic}：${it.fact}${span ? `（${span}）` : ''}`
}

/** 覆盖范围只在超过一天时才写：同一天的条目不必报区间。 */
export function spanLabel(span, { dayStart = 0 } = {}) {
  if (!span || typeof span.from !== 'number' || typeof span.to !== 'number') return ''
  const a = dayKey(span.from, { dayStart })
  const b = dayKey(span.to, { dayStart })
  if (a === b) return ''
  return `${a.slice(5)} ~ ${b.slice(5)}`
}
