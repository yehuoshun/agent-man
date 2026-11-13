// 旧会话字面回顾（design §9 首步注入里的那一段）。
// 这一层不碰 DSH：检索由宿主侧包成 search 交进来，本层只做三件事——
// 挑几条、按预算拼、把没装进去的说出来。拿不到 search 就返回空并给一条警告，绝不抛：
// 回顾是锦上添花，它坏了不该让会话开不起来。
import { INJECT_BUDGET, SECTION_ITEMS_MAX, cost, cut, oneLine } from '../core/index.mjs'

// 先说清来历，否则模型会把旧会话的内容当成当前上下文。
export const RECALL_HEADER = '来自旧会话的字面命中，不是当前会话内容。'

// recall({ search, lines, now, budget, query, limit }) → { text, lines, used, budget, dropped, warnings }
// 两种取数方式：调用方已经拿到 lines（[{ text, sessionId?, seq? }] 或字符串），
// 或者给一个 search 函数由这里去问（问法由调用方定义，本层只认它的返回值）。
export async function recall(input = {}) {
  const opts = input && typeof input === 'object' ? input : {}
  const cap = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : INJECT_BUDGET
  const limit = Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.trunc(opts.limit)
    : SECTION_ITEMS_MAX
  const warnings = []
  const dropped = []

  let raw = Array.isArray(opts.lines) ? opts.lines : null
  if (raw === null) {
    if (typeof opts.search !== 'function') {
      // 没有检索能力是最常见的一种"还没接上"：说清楚是这一步跳过，而不是"旧会话里没东西"。
      return result('', [], cap, dropped, ['! 拿不到旧会话检索（search 没接上）：这一步跳过'])
    }
    try {
      raw = await opts.search({
        query: typeof opts.query === 'string' ? opts.query : '',
        limit,
        now: opts.now,
      })
    } catch (e) {
      return result('', [], cap, dropped, [`! 旧会话检索失败（${messageOf(e)}）：这一步跳过`])
    }
  }
  if (!Array.isArray(raw)) raw = []

  const headerCost = cost(RECALL_HEADER)
  if (cap < headerCost) {
    return result('', [], cap, dropped, [
      `! 回顾槽位 ${round(cap)} 放不下标题（${round(headerCost)}）：把 inject.recall 调大`,
    ])
  }

  // 标题先占住预算：剩下的才是"能放几条"。
  let text = RECALL_HEADER
  const kept = []
  const seen = new Set()

  for (const one of raw) {
    const item = normalize(one)
    if (item === null || item.body === '') {
      dropped.push({ reason: 'empty' })
      continue
    }
    const line = render(item)
    const key = line.toLowerCase()
    if (seen.has(key)) {
      dropped.push({ text: line, reason: 'duplicate' })
      continue
    }
    if (kept.length >= limit) {
      dropped.push({ text: line, reason: 'limit' })
      continue
    }
    seen.add(key)

    const remaining = cap - cost(`${text}\n`)
    if (cost(line) <= remaining) {
      text = `${text}\n${line}`
      kept.push(line)
      continue
    }

    // 整条放不下：只在句末/逗号处切一段。切过记一笔 cut，让调用方看得见（不静默截断）。
    const part = cut(line, remaining)
    if (part.text === '' || part.text === line) {
      dropped.push({ text: line, reason: 'budget' })
      continue
    }
    text = `${text}\n${part.text}`
    kept.push(part.text)
    dropped.push({ text: line, reason: 'cut' })
    // 切过一次就把预算用到头了，再塞下一条只会让人以为"剩下的都不重要"。
    break
  }

  if (kept.length === 0) return result('', [], cap, dropped, warnings)
  return { text, lines: kept, used: cost(text), budget: cap, dropped, warnings }
}

function result(text, lines, cap, dropped, warnings) {
  return { text, lines, used: cost(text), budget: cap, dropped, warnings }
}

// 一条旧会话的命中：正文折成一行（回顾是"字面命中"，多行会把块撑成第二种结构），
// 有 sessionId/seq 就带上——模型能看见它从哪儿来，人也查得回去。
function normalize(one) {
  if (typeof one === 'string') {
    const body = oneLine(one).trim()
    return body === '' ? null : { label: '', body }
  }
  if (!one || typeof one !== 'object') return null
  const text = typeof one.text === 'string' ? one.text : ''
  const body = oneLine(text).trim()
  if (body === '') return null
  return { label: labelOf(one), body }
}

function labelOf(one) {
  const session = typeof one.sessionId === 'string' ? one.sessionId : ''
  if (session === '') return ''
  return Number.isFinite(one.seq) ? `${session}#${one.seq}` : session
}

function render(item) {
  return item.label === '' ? `- ${item.body}` : `- ${item.label}：${item.body}`
}

function messageOf(e) {
  return e && e.message ? e.message : String(e)
}

function round(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
}
