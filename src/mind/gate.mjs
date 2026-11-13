// 开口门：此刻要不要说话。只判不说——不调模型、不生成台词；
// 该说什么由宿主决定，这里只回一个判决与一句给人看的理由（design §7 的 gate 只有 judge）。
import { AFFECT_BASE, CUE_MIN_GAP, CUE_MOOD_DIV, QUIET, clock, config, now } from '../core/index.mjs'
import { snapshot } from '../affect/index.mjs'
import { appendJsonl, ensure, stateFile } from '../store/index.mjs'
import { lastSaid, markSaid, state as debtState } from './debt.mjs'

// 单位换算，不是 §10 的调参常数。
const MINUTE = 60 * 1000
const MINUTES_PER_HOUR = 60

// §14.5 的调制口子：低情绪拉开间隔，高情绪收紧间隔。分母是 core 里的 CUE_MOOD_DIV。

// 判决。`now` 是数字，一个解释都不许在这里做第二次。
// 顺序是 force ＞ 静默 ＞ 最小间隔 ＞ 到底有没有事由。
export function judge(homeDir, options = {}) {
  const call = typeof homeDir === 'string' ? { ...options, home: homeDir } : { ...homeDir }
  const home = call.home
  if (typeof home !== 'string' || home === '') {
    throw new TypeError('开口门要知道家在哪：judge(home, { now }) 或 judge({ home, now })')
  }
  const at = Number.isFinite(call.now) ? call.now : now()
  const warnings = []
  const cfg = call.cfg ?? config.load({ homeDir: home, now: at, warn: (m) => warnings.push(m) })
  const debts = call.debts ?? debtState(home, { now: at, cfg })
  const mood = affectOf(home, at)
  // §7 表里 judge 还认 minGap 与 quiet 两个口子（命令行 --min-gap / --peek 落在这儿）：
  // 给了就按给的算，没给才落回配置与钟点。门槛照样乘情绪系数。
  const base = Number.isFinite(call.minGap) && call.minGap >= 0 ? call.minGap : spanOf(cfg)
  const factor = 1 + (AFFECT_BASE.v - mood.v) / CUE_MOOD_DIV
  const minGap = Math.round(base * factor)
  const said = lastSaid(home)
  const idle = said.at === null ? null : at - said.at
  const span = quietAt(at, cfg)
  const quiet = typeof call.quiet === 'boolean' ? call.quiet : span.quiet

  const reasons = []
  if (debts.overdue.length > 0) reasons.push(`${debts.overdue.length} 条日程过点`)
  if (debts.unreflected > 0) reasons.push(`${debts.unreflected} 条新情景没巩固`)
  if (debts.due) reasons.push('该巩固了')

  const verdict = {
    at,
    say: false,
    why: '',
    reasons,
    gap: base,
    minGap,
    factor: Math.round(factor * 100) / 100,
    v: mood.v,
    quiet,
    quietSpan: `${hhmm(span.from)}-${hhmm(span.to)}`,
    lastSaid: said.at,
    idle,
    debts: {
      unconsolidated: debts.unconsolidated,
      unreflected: debts.unreflected,
      overdue: debts.overdue.length,
      due: debts.due,
    },
    bad: {
      meta: said.bad || debts.bad.meta > 0 ? 1 : 0,
      events: debts.bad.events,
      plans: debts.bad.plans,
      affect: mood.bad === true ? 1 : 0,
    },
    warnings: warnings.concat(debts.warnings ?? []),
  }

  if (call.force === true) {
    verdict.say = true
    verdict.why = '人要求此刻就说（静默与间隔都不拦）'
    return verdict
  }
  if (quiet) {
    verdict.why = `静默时段 ${verdict.quietSpan}，这会儿不主动说`
    return verdict
  }
  if (idle !== null && idle < minGap) {
    // 门槛随情绪走：v 越低说话越难（§14.5 的第一口子），理由里把乘数摊开。
    const gapText = `${held(idle)}，还差 ${held(minGap - idle)}`
    verdict.why = `${gapText}（门槛 ${held(base)} × ${verdict.factor}）`
    return verdict
  }
  if (reasons.length === 0) {
    verdict.why = idle === null ? '没什么新事，也还没到开口的时候' : '没什么新事，不打扰'
    return verdict
  }
  verdict.say = true
  verdict.why = `${reasons.join('，')}，${idle === null ? '还没开过口' : `距上次 ${held(idle)}`}`
  return verdict
}

// 静默时段：窗口与开关都从配置来（§15 用户偏好可配），缺项才退回 core 的 QUIET。
// 只认 core 的 clock() 给出的本地 HH:MM，一概不在这里碰 Date。
export function quietAt(at, cfg) {
  const span = windowOf(cfg)
  const off = cfg && cfg.cue && cfg.cue.respectQuiet === false
  if (off || span.from === span.to) return { quiet: false, from: span.from, to: span.to }
  const mins = minuteOf(clock(at))
  if (mins === null) return { quiet: false, from: span.from, to: span.to }
  const quiet = span.from < span.to
    ? mins >= span.from && mins < span.to
    : mins >= span.from || mins < span.to
  return { quiet, from: span.from, to: span.to }
}

// 落账：每一次判决都留一行（说与不说都留，design §14.13 的账本要有情绪快照）。
// 只记数字、标签与 kind，不记自然语言。
export function record(homeDir, verdict) {
  if (!verdict || typeof verdict.say !== 'boolean') {
    throw new TypeError('记账要一份判决：{ at, say, why, affect }')
  }
  const at = Number.isFinite(verdict.at) ? verdict.at : now()
  const mood = verdict.affect ?? affectOf(homeDir, at)
  ensure(homeDir)
  const line = {
    at,
    said: verdict.say,
    why: String(verdict.why ?? ''),
    affect: {
      v: mood.v,
      e: mood.e,
      t: mood.t,
      r: mood.r,
      mood: typeof mood.mood === 'string' ? mood.mood : '',
      why: kindsOf(mood),
    },
  }
  appendJsonl(stateFile(homeDir, 'judge', at), line)
  return line
}

// 说出口了才推进"上次开口"，判决与账本一起落地：少了这一步，下一次会再打断她。
export async function commit(homeDir, verdict) {
  const line = record(homeDir, verdict)
  if (line.said) await markSaid(homeDir, { at: line.at })
  return line
}

// 情绪读不出来不该挡住判决：退回基线，并把这件事记进 bad（上层用 "! " 报出）。
function affectOf(homeDir, at) {
  try {
    return snapshot(homeDir, { now: at })
  } catch (err) {
    return { ...AFFECT_BASE, mood: '', why: [`情绪读不出来：${err.message}`], bad: true }
  }
}

function kindsOf(mood) {
  const out = []
  if (mood.persistent && mood.persistent.kind) out.push(mood.persistent.kind)
  for (const one of Array.isArray(mood.transient) ? mood.transient : []) {
    if (one && one.kind) out.push(one.kind)
  }
  return out
}

function spanOf(cfg) {
  const cue = cfg && typeof cfg.cue === 'object' && cfg.cue !== null ? cfg.cue : {}
  return Number.isFinite(cue.minGap) && cue.minGap >= 0 ? cue.minGap : CUE_MIN_GAP
}

function windowOf(cfg) {
  const quiet = cfg && cfg.clock && Array.isArray(cfg.clock.quiet) ? cfg.clock.quiet : []
  const from = minuteOf(quiet[0])
  const to = minuteOf(quiet[1])
  if (from !== null && to !== null) return { from, to }
  return { from: QUIET.from * MINUTES_PER_HOUR, to: QUIET.to * MINUTES_PER_HOUR }
}

function minuteOf(text) {
  const parts = String(text ?? '').trim().split(':')
  if (parts.length !== 2) return null
  const hours = Number(parts[0])
  const mins = Number(parts[1])
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null
  if (hours < 0 || hours > 24 || mins < 0 || mins > 59) return null
  return (hours % 24) * MINUTES_PER_HOUR + mins
}

function hhmm(mins) {
  const hours = String(Math.floor(mins / MINUTES_PER_HOUR) % 24).padStart(2, '0')
  return `${hours}:${String(mins % MINUTES_PER_HOUR).padStart(2, '0')}`
}

// 断句用的小时数：只给为什么看，一位小数足够，别把 41 分钟说成 0.7 小时以外的怪数。
function held(ms) {
  const mins = Math.max(0, Math.round(ms / MINUTE))
  if (mins < MINUTES_PER_HOUR) return `${mins} 分钟`
  return `${Math.round((mins / MINUTES_PER_HOUR) * 10) / 10} 小时`
}
