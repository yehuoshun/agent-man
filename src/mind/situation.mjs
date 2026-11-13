// 处境：此刻她站在哪一段日子里——几点、上次开口之后有没有新事、日程/便条/最弱的记忆。
// 这一层只把数据摆成渲染层要的形状（design §4）：日程的 due → {when, left, late} 只在这里
// 映射一次，view 那头一个 Date 都不碰；预算也只在这里砍，砍掉的都留着为什么。
import {
  INJECT_BUDGET, SECTION_ITEMS_MAX, clock, config, dayKey, now, rel,
} from '../core/index.mjs'
import { notes, plans } from '../intent/index.mjs'
import { events, ls } from '../memory/index.mjs'
import { atOf, costOf, idOf, retention, textOf } from '../recall/index.mjs'
import { lastSaid, state as debtState } from './debt.mjs'
import { quietAt } from './gate.mjs'

// design §5 的"最弱三条"是三条，不是 §10 的段上限（那是第四条）。
const WEAKEST = 3

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

  const planRows = openPlans.items.map((one) => ({
    id: one.id,
    at: one.at,
    due: one.due,
    text: one.text,
    when: one.due === null ? '' : clock(one.due),
    // 过点的日程不再说"还有多久"：view 那头只看 late，别给自相矛盾的两个数。
    left: one.due === null || one.late ? '' : rel(one.due, at),
    late: one.late === true,
  }))
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
  const weakLines = fill('最弱的三条', weakRows, WEAKEST)

  // 插件建议还没接（§14.5 的第二口子等 M6）：递进来也摆不上屏，说出来而不是悄悄扔掉。
  if (Array.isArray(call.parts) && call.parts.length > 0) {
    dropped.push({
      id: null,
      section: '插件',
      reason: 'unsupported',
      why: '丢：插件建议还没接（design §14.5 的第二口子等 M6）',
    })
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
  return [row.text, row.r.toFixed(2), String(row.seen), row.id].filter(Boolean).join(' ')
}

function budgetOf(cfg) {
  const inject = cfg && typeof cfg.inject === 'object' && cfg.inject !== null ? cfg.inject : {}
  if (Number.isFinite(inject.situation)) return inject.situation
  if (Number.isFinite(inject.total)) return inject.total
  return INJECT_BUDGET
}
