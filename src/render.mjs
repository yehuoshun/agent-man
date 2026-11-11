import { relTime, stamp } from './time.mjs'
import { cost } from './cost.mjs'
import { select } from './budget.mjs'
import { selectMemory, longLine } from './memory.mjs'

/**
 * 把两层记忆渲染成一段能直接贴进上下文的 markdown：
 * 长期层（memory.jsonl，模型整理的结论）+ 日记层（events.jsonl，原文）。
 *
 * 两条约束来自参考实现的事故：
 * - 时间现算（relTime），不写死。写死的 "9 小时前" 三天后还是 "9 小时前"。
 * - 行级取舍，不在句子中间切。只有 "整块只剩一条且它自己就超预算" 时才切，
 *   切在句末，留 "…"，并且统计里记一笔。
 *
 * 第三条是本文件自己的事故：预算只算了条目，没算标题和统计注释。
 * 实测预算 120 时全文 137、预算 30 时全文 53——承诺"永不超支"，实际超了 17~23。
 * 所以现在整段文本的代价都要落进预算，靠 attempt() 夹逼。
 */

// 头部形态由奢到简：放不下就降级，而不是让总代价悄悄超出去。
const FULL = 'full'
const COMPACT = 'compact'
const BARE = 'bare'
const TITLE_ONLY = 'title-only'
const FORMS = [FULL, COMPACT, BARE, TITLE_ONLY]

/**
 * input 可以是 `{ events, memory }`，也可以仍是事件数组（老调用方）。
 * 默认 60% 给长期层、40% 给日记层，谁没用完谁借给对方（docs/decisions.md#13）。
 */
export function renderDigest(input, opts = {}) {
  const { events = [], memory = [] } = Array.isArray(input) ? { events: input } : (input ?? {})
  const { budget = 1200, now = Date.now(), title = '我记得的事', dayStart = 0, longShare = 0.6 } = opts
  if (!(budget > 0)) throw new Error(`预算必须为正: ${budget}`)

  let r = attempt({ events, memory }, { budget, now, title, dayStart, longShare, form: FULL })
  for (const form of FORMS.slice(1)) {
    if (r.total <= budget) break
    r = attempt({ events, memory }, { budget, now, title, dayStart, longShare, form })
  }

  return {
    text: r.text,
    stats: {
      ...r.stats,
      // 实占是整段文本的代价，不是条目的代价——这正是以前漏账的地方。
      used: r.total,
      over: Math.max(0, r.total - budget),
    },
  }
}

/**
 * 先分层分配额度，再把整段文本夹进预算。
 * 超额时先砍日记层（长期是保底），日记砍光再砍长期。
 */
function attempt({ events, memory }, { budget, now, title, dayStart, longShare, form }) {
  // 骨架先扣：标题、注释、小标题、空行都是输出的一部分，不先扣就会"额度分完了却装不下"。
  const empty = { shown: [], drops: [], used: 0 }
  const skeleton = compose({
    events,
    memory,
    day: nothingFits([]),
    long: empty,
    form,
    now,
    title,
    budget,
    dayStart,
  }).total
  const entBudget = Math.max(0, budget - skeleton)

  let allowLong = memory.length ? Math.floor(entBudget * longShare) : 0
  let allowDay = entBudget - allowLong
  let long = pickLong(memory, allowLong, { now, dayStart })
  let day = pickDay(events, allowDay)

  if (form === TITLE_ONLY) {
    allowLong = 0
    allowDay = 0
    long = pickLong(memory, 0, { now, dayStart })
    day = pickDay(events, 0)
  } else {
    // 互借：日记层没用完的额度还给长期层。
    if (memory.length && allowDay - day.used > 0) {
      const borrow = entBudget - day.used
      const longer = pickLong(memory, borrow, { now, dayStart })
      if (longer.used > long.used) {
        long = longer
        allowLong = borrow
      }
    }
    allowDay = entBudget - long.used
    day = pickDay(events, allowDay)
  }

  let r = compose({ events, memory, day, long, form, now, title, budget, dayStart })
  // 整段文本超了：先砍日记，再砍长期。每轮只减不增，不会来回振荡。
  for (let i = 0; i < 6 && r.total > budget; i++) {
    const over = r.total - budget
    if (day.used > 0) {
      allowDay = Math.max(0, allowDay - over)
      day = pickDay(events, allowDay)
    } else if (long.used > 0) {
      allowLong = Math.max(0, allowLong - over)
      long = pickLong(memory, allowLong, { now, dayStart })
    } else {
      break
    }
    r = compose({ events, memory, day, long, form, now, title, budget, dayStart })
  }
  return r
}

const pickLong = (memory, budget, opts) => selectMemory(memory, { budget, ...opts })

function pickDay(events, budget) {
  return budget >= 1 ? select(events, { budget }) : nothingFits(events)
}

/** 一点额度都不剩时：条目全记成 no-room，报账仍然是诚实的。 */
function nothingFits(events) {
  return { pinned: [], recent: [], used: 0, drops: events.map((e) => ({ ...e, why: 'no-room' })) }
}

function compose({ events, memory, day, long, form, now, title, budget, dayStart }) {
  const noRoom = day.drops.filter((d) => d.why === 'no-room').length
  const cutoff = day.drops.filter((d) => d.why === 'truncated').length
  const dayKept = day.pinned.length + day.recent.length
  const longKept = long.shown.length

  const out = [`# ${title}`]
  if (form === FULL) {
    out.push(
      `<!-- agent-man · 日记 ${events.length} 条 / 长期 ${memory.length} 条 · ` +
        `取 ${dayKept}+${longKept} · 预算 ${budget} · 条目 ${day.used + long.used} · ` +
        `丢 ${noRoom + long.drops.length} · 截 ${cutoff} · ${stamp(now)} -->`,
    )
  } else if (form === COMPACT) {
    out.push(`<!-- ${events.length}/${memory.length} · 取 ${dayKept}+${longKept} · 丢 ${noRoom + long.drops.length} · 截 ${cutoff} -->`)
  }

  if (form === TITLE_ONLY) {
    // 只剩标题：不假装装下了任何东西。
  } else if (!events.length && !memory.length) {
    out.push('', '- （还没有任何记录）')
  } else {
    if (long.shown.length) block(out, '记住的事', long.shown.map((it) => longLine(it, { dayStart })))
    block(out, '不会忘的', dayTexts(day.pinned, { now, dayStart }))
    block(out, '最近', dayTexts(day.recent, { now, dayStart }))
  }

  const text = out.join('\n') + '\n'
  return {
    text,
    total: cost(text),
    stats: {
      total: events.length,
      kept: dayKept,
      entries: day.used,
      budget,
      noRoom,
      cutoff,
      drops: day.drops,
      longTotal: memory.length,
      longKept,
      longUsed: long.used,
      longDrops: long.drops,
    },
  }
}

function dayTexts(items, { now, dayStart }) {
  return items.map((e) => {
    const feel = e.feel ? `（${e.feel}）` : ''
    return `- ${relTime(e.at, { now, dayStart })} · ${e.fact}${feel}`
  })
}

function block(out, heading, lines) {
  out.push('', `## ${heading}`)
  if (!lines.length) {
    out.push('- （还没有）')
    return
  }
  out.push(...lines)
}
