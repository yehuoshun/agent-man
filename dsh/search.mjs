// DSH 侧的旧会话检索（design §9 的"字面回顾"）：只有这一层认识 sessionQuery。
// 两件事：从当前这一句里抽出值得字面找的串，拿这些串去问 session.query。
// 抽串的规矩是"宁少不滥"：找错一个词，回顾里塞进来的就是别人的话题，比没有更误导。
import { oneLine } from '../src/core/index.mjs'

export const MAX_NEEDLES = 4
export const MAX_CANDIDATES = 12
const MAX_NEEDLE_LEN = 40

// 值钱的字面信号：链接、路径、代码片段、成串的汉字。
const PATTERNS = [
  /https?:\/\/[^\s'"）)，。；]+/gu,
  /[A-Za-z]:\\[^\s'"）)，。；]+/gu,
  /(?:^|[\s'"（(])((?:[\w.-]+\/){1,}[\w.-]+)/gu,
  /`([^`\n]{2,60})`/gu,
  /[\u4e00-\u9fff]{4,12}/gu,
]

// 这些串到处都是，搜了只会把回顾塞满无关会话。
const STOPWORDS = new Set([
  '什么', '怎么', '为什么', '可以', '这个', '那个', '我们', '你们', '他们',
  '还是', '就是', '不是', '没有', '已经', '现在', '这里', '那里', '时候',
  '问题', '需求', '东西', '一起', '一下', '帮我', '需要', '应该', '觉得',
])

// extractNeedles(text) → 最多 MAX_NEEDLES 个互不相同的串（长的在前，短的更容易撞上无关内容）。
export function extractNeedles(text, max = MAX_NEEDLES) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return []
  const found = []
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0
    for (const hit of source.matchAll(pattern)) {
      // 第 1 组是"要的那截"（路径/代码），没有分组就取整个命中。
      const raw = typeof hit[1] === 'string' && hit[1] !== '' ? hit[1] : hit[0]
      const needle = oneLine(raw).trim().replace(/^[-—:：、，。]+/u, '')
      if (needle.length < 3 || needle.length > MAX_NEEDLE_LEN) continue
      if (STOPWORDS.has(needle)) continue
      if (found.includes(needle)) continue
      found.push(needle)
    }
  }
  return found.sort((a, b) => b.length - a.length).slice(0, max)
}

// 从一串消息里取"当前这一句"：从后往前找第一条 user 消息的正文。
// pre-step 的 payload 与 decision 的消息形状不完全一样，所以这里两种形状都认。
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const one = messages[i]
    if (!one || one.role !== 'user') continue
    const text = textOf(one)
    if (text !== '') return text
  }
  return ''
}

// 一条消息的正文：content 可能是字符串，也可能是 [{ type: 'text', text }]。
export function textOf(message) {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

// makeSearch(sessionQuery, { needles, cwd, exclude }) → recall() 认的那个 search 函数。
// sessionQuery 的两种 filter 是旧实现（code\dsh-agent-man\index.mjs）验过的形状；
// 拿不到 sessionQuery、或者没有可搜的串，就返回 null——回顾那一层会报"没接上"，不是这里瞎猜。
export function makeSearch(sessionQuery, opts = {}) {
  if (!sessionQuery || typeof sessionQuery.filterSessions !== 'function') return null
  if (typeof sessionQuery.filterEvents !== 'function') return null
  const needles = Array.isArray(opts.needles)
    ? opts.needles.filter((one) => typeof one === 'string' && one.trim() !== '').slice(0, MAX_NEEDLES)
    : []
  if (needles.length === 0) return null

  const filters = [{ kind: 'parent', values: [null] }]
  if (typeof opts.cwd === 'string' && opts.cwd !== '') {
    filters.unshift({ kind: 'cwd', values: [opts.cwd] })
  }
  filters.push({ kind: 'availability', values: ['live', 'persisted'] })

  return async ({ limit } = {}) => {
    const want = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 3
    const sessions = await sessionQuery.filterSessions(filters)
    const rows = []
    const seen = new Set()
    for (const one of Array.isArray(sessions) ? sessions : []) {
      const header = one && one.header ? one.header : one
      const id = header && typeof header.id === 'string' ? header.id : ''
      if (id === '' || id === opts.exclude) continue
      for (const needle of needles) {
        const events = await sessionQuery.filterEvents(id, [
          { kind: 'type', values: ['user/message', 'assistant/message'] },
          { kind: 'text', text: needle },
        ])
        for (const event of Array.isArray(events) ? events : []) {
          const seq = Number.isFinite(event && event.seq) ? event.seq : null
          const text = typeof event?.text === 'string' ? oneLine(event.text).trim() : ''
          if (seq === null || text === '') continue
          const key = `${id}#${seq}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push({ sessionId: id, seq, text })
          if (rows.length >= MAX_CANDIDATES) return rows.slice(0, want)
        }
      }
    }
    return rows.slice(0, want)
  }
}
