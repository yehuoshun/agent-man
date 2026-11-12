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

/**
 * 同一天内顺序发号，看文件就能读出先后。这里只算"看起来该发几号"——
 * 并发下两个进程会算出同一个号，所以真正发号前要拿 `claimId()` 抢名额（§29）。
 */
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
 * 规矩：模型写给自己的约束（docs/decisions.md§36）。
 *
 * 和普通长期条目同住 `memory.jsonl`，因为演化要的正是这一套：`supersedes` 改版、
 * `refs` 指向原文、`digest` 每次把它摆到最前面。三处不同：`kind:'rule'`、
 * 必须有 `why`（不是道理，是那件具体的事）、有条数上限。
 *
 * 上限不是洁癖：规矩不会自己消失，写一条就永久占一行预算；过二十条，
 * 读的人开始整节跳过——那时候它约束的是行数，不是行为。
 */
export const RULE_MAX = 120
export const RULE_LIMIT = 20
export const RULE_TOPIC = '规矩'

export function isRule(it) {
  return it?.kind === 'rule'
}

export function makeRule(input, { now = Date.now(), existing = [] } = {}) {
  const fact = String(input.fact ?? '').trim()
  const why = String(input.why ?? '').trim()
  if (!fact) {
    throw new Error('规矩是什么？例：agent-man rule "夜里十一点后不提工作" --why "昨天 23:40 提加班，她只回了句嗯"')
  }
  if (!why) {
    throw new Error('规矩要带 --why：写清是哪件具体的事让你定的（不是道理，是事情）——没有来由的规矩下次也守不住')
  }
  const chars = [...fact].length
  if (chars > RULE_MAX) {
    throw new Error(`规矩别超过 ${RULE_MAX} 个字（这条 ${chars} 字）：一念就得明白，写长了下次不会读它`)
  }

  const at = parseAt(input.at, { now })
  const supersedes = splitList(input.supersedes)
  for (const id of supersedes) {
    const old = existing.find((it) => it.id === id)
    if (!old) throw new Error(`--supersedes 指的是不存在的条目：${id}`)
    if (!isRule(old)) {
      throw new Error(`--supersedes 只能接规矩：${id} 是一条普通结论（结论要用 remember --supersedes 改）`)
    }
  }

  const item = {
    id: String(input.id ?? nextId(dayKey(at), existing)),
    at,
    kind: 'rule',
    tier: 0,
    batch: String(input.batch ?? dayKey(at)),
    topic: RULE_TOPIC,
    fact,
    why,
    span: { from: at, to: at },
    refs: splitList(input.refs),
    supersedes,
  }

  const live = activeItems([...existing, item]).filter(isRule).length
  if (live > RULE_LIMIT) {
    throw new Error(
      `规矩最多 ${RULE_LIMIT} 条，这条是第 ${live} 条：先拿 --supersedes 改掉一条旧的，或者把两条并成一条`,
    )
  }
  return item
}

/** 一条规矩是第几版：自己 + 它一路取代过的那些（合并多条也只按"代"算）。 */
export function ruleVersion(items, id) {
  const byId = new Map(items.map((it) => [it.id, it]))
  const seen = new Set([id])
  const stack = [byId.get(id)]
  while (stack.length) {
    for (const p of stack.pop()?.supersedes ?? []) {
      if (seen.has(p)) continue
      seen.add(p)
      stack.push(byId.get(p))
    }
  }
  return seen.size
}

/** 摘要里的一行规矩：只写规矩本身；第几版提一句就够——版本号是给人追溯的，不是台词。 */
export function ruleLine(it, { items = [] } = {}) {
  const v = items.length ? ruleVersion(items, it.id) : 1
  return `- ${it.fact}${v > 1 ? `（第 ${v} 版）` : ''}`
}

/** 一条长期条目在摘要里占的那一行：规矩和普通结论共用一份预算，算法必须一致。 */
export function itemLine(it, { items = [], dayStart = 0 } = {}) {
  return isRule(it) ? ruleLine(it, { items }) : longLine(it, { dayStart })
}

/**
 * 挑哪些长期条目进摘要。
 *
 * 顺序：tier 小的先说（近期整理比永久结论更需要被看见），同 tier 里
 * 权重高的、覆盖范围靠后的先说。放不下就跳过并记 drops——和 budget.mjs 同一规矩。
 */
export function selectMemory(items, { budget, now = Date.now(), dayStart = 0 } = {}) {
  if (!(budget > 0)) return { shown: [], drops: items.map((it) => ({ ...it, drop: 'no-room' })), used: 0, superseded: 0 }

  const live = activeItems(items)
  const ordered = [...live].sort(
    (a, b) =>
      // 规矩先挑：它们是"约束"，不是"回忆"，被一条昨天的流水挤掉就没有意义了。
      (isRule(a) ? 0 : 1) - (isRule(b) ? 0 : 1) ||
      (a.tier ?? 0) - (b.tier ?? 0) ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      (b.span?.to ?? b.at ?? 0) - (a.span?.to ?? a.at ?? 0),
  )

  const shown = []
  const drops = []
  let used = 0
  for (const it of ordered) {
    const charge = memoryCost(it, { now, dayStart, items })
    if (used + charge <= budget) {
      shown.push({ ...it, charge })
      used += charge
    } else {
      // 淘汰理由叫 drop 不叫 why：条目自己的 why 是"为什么定这条"，两件事别挤一个字段。
      drops.push({ ...it, drop: 'no-room' })
    }
  }
  return { shown, drops, used, superseded: items.length - live.length }
}

/**
 * 一条长期条目占多少预算。
 * 行格式必须和 render.mjs 里输出的一致，否则账又对不上。
 */
export function memoryCost(it, opts = {}) {
  return cost(itemLine(it, { items: opts.items ?? [], dayStart: opts.dayStart ?? 0 }))
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
