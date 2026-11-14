// 处境：此刻她站在哪一段日子里——几点、上次开口之后有没有新事、日程/便条/最弱的记忆。
// 这一层只把数据摆成渲染层要的形状（design §4）：日程的 due → {when, left, late} 只在这里
// 映射一次，view 那头一个 Date 都不碰；预算也只在这里砍，砍掉的都留着为什么。
import {
  AFFECT_ACTIVE_E, AFFECT_ACTIVE_V, INJECT_BUDGET, SECTION_ITEMS_MAX, SUGGEST_MAX, WEAKEST_MAX,
  clock, config, dayKey, now, rel,
} from '../core/index.mjs'
import { snapshot as affectOf } from '../affect/index.mjs'
import { notes, plans } from '../intent/index.mjs'
import { events, ls } from '../memory/index.mjs'
import { atOf, costOf, idOf, retention, textOf } from '../recall/index.mjs'
import { lastSaid, state as debtState } from './debt.mjs'
import { quietAt } from './gate.mjs'

export function situation(homeDir, options = {}) {
  const call = typeof homeDir === 'string' ? { ...options, home: homeDir } : { ...homeDir }
  const home = call.home
  if (typeof home !== 'string' || home === '') {
    throw new TypeError('处境要知道家在哪：situation(home, { now }) 或 situation({ home, now })')
  }
  const at = Number.isFinite(call.now) ? call.now : now()
  const warnings = []
  const cfg = call.cfg ?? config.load({ homeDir: home, now: at, warn: (m) => warnings.push(m) })
  const budget = Number.isFinite(call.budget) ? call.budget : budgetOf(cfg)

  const quiet = quietAt(at, cfg).quiet
  const debts = call.debts ?? debtState(home, { now: at, cfg })
  const said = lastSaid(home)
  const openPlans = plans.list(home, { now: at })
  const openNotes = notes.list(home, { now: at })

  // "上次开口之后有几条新记忆"：没有上次开口就不数了，view 那头自己会说"还没开过口"。
  const got = said.at === null
    ? { items: [], bad: debts.bad.events }
    : events(home, { from: said.at, to: at })
  const since = said.at === null
    ? null
    : { at: said.at, text: rel(said.at, at), fresh: got.items.length }
  const stamp = `${dayKey(at)} ${clock(at)}`
  const backlog = { unconsolidated: debts.unconsolidated, overdue: debts.overdue.length }
  const head = headOf({ stamp, since, backlog, quiet })

  const planRows = openPlans.items.map((one) => {
    // due 的解释只在这里做一次（§4）。分工是：**今天的事由 when 报时分，别的事由 left 报日子**——
    // 两个都报就会印成 `2026-11-14 19:40 陪她看牙（明天 19:40）`，同一个时间说两遍。
    // 过点是例外：那时 left 是空的（见下），日子只能由 when 自己带。
    const sameDay = one.due !== null && dayKey(one.due) === dayKey(at)
    let when = ''
    if (one.due !== null && sameDay) when = clock(one.due)
    // 过点的日程 left 是空的（说"晚了 26 小时"没意义），日期只能落在 when 上。
    else if (one.due !== null && one.late === true) when = `${dayKey(one.due)} ${clock(one.due)}`
    const leftText = one.due === null || one.late ? '' : rel(one.due, at)
    return {
      id: one.id,
      at: one.at,
      due: one.due,
      text: one.text,
      when,
      // 当天还没到点时 rel() 与 clock() 说的是同一件事（都是 "22:00"）：只留一个。
      left: leftText === when ? '' : leftText,
      late: one.late === true,
    }
  })
  const noteRows = openNotes.items.map((one) => ({
    id: one.id,
    at: one.at,
    text: one.text,
    trigger: typeof one.trigger === 'string' ? one.trigger : '',
    when: Number.isFinite(one.when) ? one.when : null,
  }))
  const lib = ls({ all: true, live: true }, { home, now: at })
  const weakRows = lib.items
    .map((rec) => ({
      id: idOf(rec),
      at: atOf(rec),
      text: textOf(rec),
      r: retention(rec, at, 'memory'),
      seen: Number.isFinite(rec.seen) ? rec.seen : 0,
    }))
    .sort((left, right) => left.r - right.r || left.at - right.at)

  const dropped = []
  let used = head.cost
  const fill = (section, rows, cap) => {
    const kept = []
    for (const row of rows) {
      if (kept.length >= cap) {
        dropped.push({ id: row.id, section, reason: 'limit', why: `丢：一屏只放 ${cap} 条` })
        continue
      }
      const cost = costOf(measureOf(section, row))
      if (used + cost > budget) {
        const left = Math.max(0, Math.round(budget - used))
        dropped.push({
          id: row.id,
          section,
          reason: 'budget',
          why: `丢：这一条要 ${Math.round(cost)}，只剩 ${left}`,
        })
        continue
      }
      kept.push(row)
      used += cost
    }
    return kept
  }
  const planLines = fill('日程', planRows, SECTION_ITEMS_MAX)
  const noteLines = fill('便条', noteRows, SECTION_ITEMS_MAX)
  const weakLines = fill('最弱的三条', weakRows, WEAKEST_MAX)

  // 插件建议（design §8 的聚合模式 + §14.5 的第二个口子）：零件答的话最多上屏一条，
  // 而且只有 v 与 e 都够高时才给这个机会。情绪不到就不提——但每条都记进 dropped，
  // 免得"屏上没有建议"被读成"零件都没答话"。
  const partLines = linesOf(call.parts)
  const suggestLines = []
  if (partLines.length > 0) {
    const feel = call.affect ?? affectOf(home, { now: at })
    const eager = feel.v >= AFFECT_ACTIVE_V && feel.e >= AFFECT_ACTIVE_E
    for (const row of partLines) {
      if (!eager) {
        dropped.push({
          id: null,
          section: '建议',
          reason: 'affect',
          why: `丢：此刻 v=${feel.v} e=${feel.e}，不到 v≥${AFFECT_ACTIVE_V} 且 e≥${AFFECT_ACTIVE_E}，不主动提建议`,
        })
        continue
      }
      if (suggestLines.length >= SUGGEST_MAX) {
        dropped.push({
          id: null,
          section: '建议',
          reason: 'limit',
          why: `丢：一屏只放 ${SUGGEST_MAX} 条建议`,
        })
        continue
      }
      const price = costOf(measureOf('建议', row))
      if (used + price > budget) {
        const left = Math.max(0, Math.round(budget - used))
        dropped.push({
          id: null,
          section: '建议',
          reason: 'budget',
          why: `丢：这一条要 ${Math.round(price)}，只剩 ${left}`,
        })
        continue
      }
      suggestLines.push({ name: row.name, text: row.text })
      used += price
    }
  }

  return {
    at,
    clock: stamp,
    quiet,
    since,
    lastSaid: said.at,
    backlog,
    debts,
    plans: planLines,
    notes: noteLines,
    weakest: weakLines,
    suggest: suggestLines,
    budget,
    used,
    // 抬头是屏的框（几点、上次开口、积压），砍不动也换不得；预算比它还小时只能认账。
    over: used > budget,
    head,
    dropped,
    expired: openNotes.expired,
    later: openPlans.later,
    bad: {
      events: got.bad,
      notes: openNotes.bad,
      plans: openPlans.bad,
      memory: lib.skipped,
      meta: said.bad ? 1 : 0,
    },
    warnings: warnings.concat(debts.warnings ?? []),
  }
}

// design §7 的表把这个模块的入口写成 build({ home, now, parts })：同一个东西，认那个形状。
export function build(input = {}) {
  return situation(input)
}

// 抬头要占掉几行、多少成本：先说清楚还剩多少给条目，别让条目把纸撑破。
// 只算 mind 自己那几句话（时刻、上次开口、积压数字），view 的固定标签它看不见——
// 那点差已写进"待我定夺"，要精确得让 view 自己报成本。
function headOf({ stamp, since, backlog, quiet }) {
  const texts = [stamp]
  if (!quiet && since !== null) texts.push(since.text)
  if (backlog.unconsolidated > 0 || backlog.overdue > 0) {
    texts.push(`${backlog.unconsolidated} 条待巩固 ${backlog.overdue} 条过期`)
  }
  return { lines: texts.length, cost: texts.reduce((sum, one) => sum + costOf(one), 0) }
}

// 一条要占多少字：把这一行会带上的字段拼起来量（括号、圆点是 view 的排版，不算进 mind 的账）。
function measureOf(section, row) {
  if (section === '日程') return [row.when, row.text, row.left].filter(Boolean).join(' ')
  if (section === '便条') return [row.text, row.trigger].filter(Boolean).join(' ')
  // 建议行要带零件名字（读者得知道这话是谁说的），量成本时就得把它算进去。
  if (section === '建议') return `${row.text}（${row.name}）`
  return [row.text, row.r.toFixed(2), String(row.seen), row.id].filter(Boolean).join(' ')
}

// 零件递进来的东西有两种形状：sense() 的整包（{lines,…}）或已经拆好的行数组。
// 只认 {name,text} 两个字符串字段——零件说不了屏的结构，屏的结构由这一层定。
function linesOf(parts) {
  const raw = Array.isArray(parts) ? parts : (Array.isArray(parts?.lines) ? parts.lines : [])
  return raw
    .filter((one) => one && typeof one.text === 'string' && one.text.trim() !== '')
    .map((one) => ({ name: typeof one.name === 'string' ? one.name : '', text: one.text.trim() }))
}

function budgetOf(cfg) {
  const inject = cfg && typeof cfg.inject === 'object' && cfg.inject !== null ? cfg.inject : {}
  if (Number.isFinite(inject.situation)) return inject.situation
  if (Number.isFinite(inject.total)) return inject.total
  return INJECT_BUDGET
}
