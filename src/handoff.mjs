import { dayKey, parseAt } from './time.mjs'

/**
 * 递话：写给"下一次的自己"的便利贴。
 *
 * 和另外两层的区别是"会自己消失"：
 * - 日记（events）回答"发生过什么"，一直在
 * - 长期层（memory）回答"我认定什么"，靠 supersedes 退场
 * - 便条只对某一次有效，递出即焚，过期作废
 *
 * 三条硬限制都是防噪音的：必须写"什么时候该看"（--when）、只端一次、默认 7 天过期。
 * 条件本身脚本看不懂（"她提到加班时"是语义），所以只照搬给模型，由模型判断该不该用——
 * 见 AGENTS.md §一：零件只做确定性的那部分。
 */

/** 便条默认活多久：7 天。三天前的"记得问她头痛好点没"还有意义，两个月后的就是垃圾。 */
export const TTL_DAYS = 7

const DAY = 24 * 3600e3

/**
 * 造一张便条。existing 用来发号（同一天的第几张），和长期层的 id 形状一致。
 */
export function makeNote(input, { now = Date.now(), existing = [] } = {}) {
  const text = String(input.text ?? '').trim()
  if (!text) {
    throw new Error('便条要有内容：agent-man leave "记得问她头痛好点没" --when 她提到加班时')
  }

  const when = String(input.when ?? '').trim()
  if (!when) {
    // 没有"什么时候该看"的便条，等于墙上随便贴的纸条：到用的时候没人想得起它。
    throw new Error('便条要写清什么时候看：--when 她提到加班时（实在没有条件就写"下次开口时"）')
  }

  const ttl = Number(input.ttl ?? TTL_DAYS)
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`--ttl 必须是正整数天，收到 ${input.ttl}`)
  }

  const at = parseAt(input.at, { now })
  const day = dayKey(at)
  const leaves = existing.filter((r) => r.op === 'leave')
  let n = 0
  for (const r of leaves) {
    if (typeof r.id === 'string' && r.id.startsWith(`${day}-`)) n++
  }

  return {
    op: 'leave',
    id: `${day}-${String(n + 1).padStart(2, '0')}`,
    at,
    text,
    when,
    until: at + ttl * DAY,
  }
}

/**
 * 现在还没被递出的便条，和已经过期作废的。
 *
 * 过期的不静默吞掉：调用方要报出来，再记一条 drop——报一次就够，别每次 cue 都念一遍。
 */
export function pendingNotes(records, { now }) {
  const gone = new Set()
  for (const r of records) {
    if (r.op === 'take' || r.op === 'drop') gone.add(r.id)
  }
  const live = records.filter((r) => r.op === 'leave' && !gone.has(r.id))
  return {
    pending: live.filter((r) => r.until > now),
    expired: live.filter((r) => !(r.until > now)),
  }
}

