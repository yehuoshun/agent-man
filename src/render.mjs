import { relTime, stamp } from './time.mjs'
import { cost } from './cost.mjs'
import { select, dedupeExact, pinnedFloor, recentFloor, PINNED_WEIGHT } from './budget.mjs'
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

  // 每种头部都试一遍，再挑：以前是"从最详细的往下试，只要没超预算就收手"，
  // 于是最详细的头部只要装下了一条，就再没机会换成便宜头部多装一条。
  const picks = FORMS.map((form) =>
    attempt({ events, memory }, { budget, now, title, dayStart, longShare, form }),
  )
  const fits = picks.filter((r) => r.total <= budget)
  const nothingYet = !events.length && !memory.length
  // 空库没什么可挑的：要最详细的那种，好把"还没有记录"说清楚。
  const r = !fits.length ? picks[picks.length - 1] : nothingYet ? fits[0] : pickBest(fits)

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
 * 挑头部：装下的条目多的赢；一样多再比谁说得细（FORMS 在前者优先）；
 * 一条都装不下时，别花几十个字的代价买一个空壳。
 *
 * 这条替换了"降到装得下为止"的老规则。老规则的洞在两头：
 * - 实测预算 85：FULL 骨架 69，只剩 16，装得下 w0（12）装不下 w2（26），
 *   于是它按"没超预算"收手，丢掉一条 w2——换成 compact，两条都装得下。
 * - 实测预算 80：FULL 骨架 69，剩 11，两条都装不下，取 0 丢 2，
 *   但它同样"没超预算"，交出去一份只有标题和「（还没有）」的空壳。
 * 两件事都是同一个毛病：头部先挑，内容只能捡剩下的。
 */
function pickBest(fits) {
  return fits.reduce((best, r) => {
    // 0) 保住了最重那条（见 budget.mjs 的 pinnedFloor）就算赢了一半：
    //    条数一样时也不能选"装了一条近况、丢了那条疤"的那个形态。
    //    最近那条只做第二优先——两条保底撞车时，先保重的（不然预算一紧就整个偏向今天）。
    if (r.stats.floorKeep !== best.stats.floorKeep) return r.stats.floorKeep ? r : best
    if (r.stats.recentFloorKeep !== best.stats.recentFloorKeep) {
      return r.stats.recentFloorKeep ? r : best
    }
    const a = best.stats.kept + best.stats.longKept
    const b = r.stats.kept + r.stats.longKept
    if (b !== a) return b > a ? r : best
    if (a === 0) return r.total < best.total ? r : best
    return best
  })
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
  const pFloor = pinnedFloor(events, entBudget)
  // 最近那条也要保底：重的那条先占，近的这条拿剩下的额度（见 budget.mjs 的 recentFloor）。
  const rFloor = recentFloor(events, entBudget - pFloor)
  const floor = pFloor + rFloor
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
  // 但日记额度不许砍到保底那条以下——否则夹逼会把刚保住的 w2 又砍掉，
  // 结果和没做保底一模一样。保不住的时候，宁可让这一形态整体出局，
  // 交给上面去挑更便宜的头部（那才是"先降级头部，再砍最近"的顺序）。
  for (let i = 0; i < 6 && r.total > budget; i++) {
    const over = r.total - budget
    if (day.used > 0 && allowDay > floor) {
      allowDay = Math.max(floor, allowDay - over)
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
  const { events: uniq, merged } = dedupeExact(events)
  return {
    pinned: [],
    recent: [],
    used: 0,
    drops: [...merged, ...uniq.map((e) => ({ ...e, why: 'no-room' }))],
    floorKeep: false,
    recentFloorKeep: false,
    merged: merged.length,
  }
}

function compose({ events, memory, day, long, form, now, title, budget, dayStart }) {
  const noRoom = day.drops.filter((d) => d.why === 'no-room').length
  const cutoff = day.drops.filter((d) => d.why === 'truncated').length
  // 逐字相同的重复被合成了几行：跟「丢」分开说，合并不等于丢了（§28）。
  const merged = day.drops.filter((d) => d.why === 'dup').length
  const mergedNote = merged ? ` · 合 ${merged}` : ''
  const dayKept = day.pinned.length + day.recent.length
  const longKept = long.shown.length

  const out = [`# ${title}`]
  if (form === FULL) {
    out.push(
      `<!-- agent-man · 日记 ${events.length} 条 / 长期 ${memory.length} 条 · ` +
        `取 ${dayKept}+${longKept} · 预算 ${budget} · 条目 ${day.used + long.used} · ` +
        `丢 ${noRoom + long.drops.length}${mergedNote} · 截 ${cutoff} · ${stamp(now)} -->`,
    )
  } else if (form === COMPACT) {
    out.push(
      `<!-- ${events.length}/${memory.length} · 取 ${dayKept}+${longKept} · ` +
        `丢 ${noRoom + long.drops.length}${mergedNote} · 截 ${cutoff} -->`,
    )
  }

  if (form === TITLE_ONLY) {
    // 只剩标题：不假装装下了任何东西。
  } else if (!events.length && !memory.length) {
    out.push('', '- （还没有任何记录）')
  } else {
    // 空着的段要分清"真的没有"和"有但没装下"。保底一条救下 w2 以后，
    // 掉下去的常常是"最近"，这时候写「（还没有）」是在骗人。
    const gone = day.drops.filter((d) => d.why === 'no-room')
    const gonePinned = gone.filter((d) => (d.weight ?? 0) >= PINNED_WEIGHT).length
    if (long.shown.length) block(out, '记住的事', long.shown.map((it) => longLine(it, { dayStart })))
    block(out, '不会忘的', dayTexts(day.pinned, { now, dayStart }), emptyLine(gonePinned))
    block(out, '最近', dayTexts(day.recent, { now, dayStart }), emptyLine(gone.length - gonePinned))
  }

  const text = out.join('\n') + '\n'
  return {
    text,
    total: cost(text),
    stats: {
      total: events.length,
      kept: dayKept,
      entries: day.used,
      floorKeep: day.floorKeep === true,
      recentFloorKeep: day.recentFloorKeep === true,
      budget,
      noRoom,
      cutoff,
      merged,
      drops: day.drops,
      longTotal: memory.length,
      longKept,
      longUsed: long.used,
      longDrops: long.drops,
      // 装进摘要的是哪些条目：账本要能回答"哪几条从来没进过摘要"（见 src/trace.mjs）。
      // 日记用 at 认，长期用 id 认——两者在各自文件里都是唯一的。
      keptAt: [...day.pinned, ...day.recent].map((e) => e.at),
      longKeptIds: long.shown.map((it) => it.id),
    },
  }
}

function dayTexts(items, { now, dayStart }) {
  return items.map((e) => {
    const feel = e.feel ? `（${e.feel}）` : ''
    return `- ${relTime(e.at, { now, dayStart })} · ${e.fact}${feel}`
  })
}

/** 空段的说法：丢了几条就报几条，别把"放不下"说成"还没有"。 */
const emptyLine = (n) => (n > 0 ? `- （放不下，丢了 ${n} 条）` : '- （还没有）')

function block(out, heading, lines, empty = '- （还没有）') {
  out.push('', `## ${heading}`)
  if (!lines.length) {
    out.push(empty)
    return
  }
  out.push(...lines)
}
