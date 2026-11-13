// state 是"此刻是多少"的唯一出口（design §14.6 / §14.11）：不存缓存值，读全量日志现算。
// 存的是刺激与 override，四轴与标签全是派生物——删掉缓存不丢事实，重放同日志得同一数值。
import path from 'node:path'

import { AFFECT_HYST, AFFECT_STIM_PER_HOUR, now } from '../core/index.mjs'
import { readJson, stateFile, writeAtomic } from '../store/index.mjs'
import { AXES, AXIS_NAMES, EMOTION_HALF, clampAxis, decayOffset, mergeOffset } from './decay.mjs'
import { deadband, moodOf, persistent, respectBand, transient } from './label.mjs'
import { appendOp, list, record, weightOf } from './stim.mjs'

const KIND = 'affect'
const HOUR = 60 * 60 * 1000 // 单位换算，不是 §10 的调参常数

// 一根轴的中文名（why 里给人看的措辞，不是判定值；design §14.1 的四轴）。
const AXIS_TEXT = Object.freeze({ v: '愉悦', e: '精力', t: '信任', r: '尊重' })

// 快照（design §14.6）：四轴 + 16 格 + 五段 + 持久情绪 + 瞬时情绪 + 峰值 + 归因。
// 时间只认传进来的 now：调用方不给才用 core 的 now()（唯一允许的默认值）。
export function snapshot(homeDir, { now: nowTs = now(), prev } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  const stored = loadMeta(homeDir, at)
  const got = list(homeDir, { to: at })
  const state = replay(got.items, at)
  const values = state.values
  // 滞回要拿"上一格"比：优先用调用方给的 prev（同一次会话里上一次的标签），
  // 否则用 meta 里存的上一个标签——重启进程也不该在边界上来回跳。
  const before = typeof prev === 'string' ? prev : stored.mood
  const mood = moodOf(values.v, values.e, before)
  return {
    at,
    v: values.v,
    e: values.e,
    t: values.t,
    r: values.r,
    mood,
    band: respectBand(values.r),
    persistent: persistent({ t: values.t, r: values.r }),
    transient: transient(got.items.filter((one) => one.op === 'stim'), at),
    peaks: peaksOf(stored.peaks, values, at),
    by: state.manual.length > 0 ? 'manual' : 'auto',
    until: state.until,
    why: explain({ state, values, mood, stored, ignored: state.ignored, skipped: got.skipped }),
    ignored: state.ignored,
    skipped: got.skipped,
  }
}

// design §7 的表里叫 read(home, now)；简报叫 snapshot。同一个函数，两个名字。
export function read(homeDir, nowTs, opts = {}) {
  return snapshot(homeDir, { ...opts, now: nowTs })
}

// 手动覆盖（design §14.6 / §14.14.3）：写一条 set，之后读侧按它算生效值。
// for = 持续时长，也可以直接给 until；都不给就是"到 clear 为止"。
export async function set(homeDir, input = {}) {
  const axis = input.axis
  if (!AXIS_NAMES.includes(axis)) {
    throw new TypeError(`未知的轴：${String(axis)}（只认 ${AXIS_NAMES.join(' / ')}）`)
  }
  if (!Number.isFinite(input.value)) {
    throw new TypeError(`override 的 value 必须是有限数字：${String(input.value)}`)
  }
  const why = typeof input.why === 'string' ? input.why.trim() : ''
  if (why === '') throw new TypeError('override 必须带 why：改了什么、为什么改（design §14.11）')
  const at = Number.isFinite(input.at) ? input.at : now()
  const span = Number.isFinite(input.for) ? input.for : null
  const until = Number.isFinite(input.until) ? input.until : span === null ? null : at + span
  if (until !== null && until <= at) throw new TypeError(`until 必须晚于 at：${until} <= ${at}`)
  const item = { op: 'set', at, axis, value: clampAxis(axis, input.value), until, why }
  appendOp(homeDir, item)
  const snap = snapshot(homeDir, { now: at })
  const saved = await syncPeaks(homeDir, snap)
  return { item, snapshot: snap, saved }
}

// 清账：之前的刺激与 override 一笔勾销（回基线），峰值不动——"他曾经信任过"不是可撤销的事实。
export async function clear(homeDir, input = {}) {
  const at = Number.isFinite(input.at) ? input.at : now()
  const item = { op: 'clear', at }
  appendOp(homeDir, item)
  const snap = snapshot(homeDir, { now: at })
  // 清账也把"上一个标签"一起忘掉：不然清完还留着旧的滞回起点，标签会赖在前一格。
  const saved = await syncPeaks(homeDir, snap, { forgetMood: true })
  return { item, snapshot: snap, saved }
}

// 记账 + 交回"新快照要用的增量"：只做写盘与算数，不替调用方决定措辞或该不该开口。
// 超额（同类这一小时第 4 次起）照样落盘，只在返回值里标 ignored，计算里不算它。
// 校验在 record 里同步做完再进异步外壳：未知 kind / 缺 why 会在写盘之前抛 TypeError。
export async function stim(homeDir, input = {}) {
  const done = record(homeDir, input)
  const snap = snapshot(homeDir, { now: done.item.at })
  const saved = await syncPeaks(homeDir, snap)
  return {
    item: done.item,
    weight: weightOf(done.item.kind),
    counts: done.counts,
    ignored: done.ignored,
    snapshot: snap,
    saved,
  }
}

// 重放：按 at 升序把日志折叠成四轴偏移。纯计算，不碰文件，重放多少遍都是同一结果。
function replay(ops, nowTs) {
  const agg = { v: 0, e: 0, t: 0, r: 0 }
  const mark = { v: 0, e: 0, t: 0, r: 0 }
  const over = { v: null, e: null, t: null, r: null }
  const best = {}
  for (const a of AXIS_NAMES) best[a] = { pos: null, neg: null }
  const quota = new Map()
  let started = false
  let ignored = 0

  // 推进到 to，顺带处理"override 到期"：到期那刻以 override 值为新起点继续衰减（不弹回自动值）。
  const advance = (to) => {
    if (!started) {
      for (const a of AXIS_NAMES) mark[a] = to
      started = true
      return
    }
    for (const a of AXIS_NAMES) {
      const o = over[a]
      if (o && o.until !== null && o.until > mark[a] && o.until <= to) {
        agg[a] = clampOffset(a, o.value - AXES[a].base)
        over[a] = null
        mark[a] = o.until
      }
      if (agg[a] !== 0) agg[a] = decayOffset(agg[a], to - mark[a], a)
      mark[a] = to
    }
  }

  for (const op of ops) {
    if (!Number.isFinite(op.at) || op.at > nowTs) continue
    advance(op.at)
    if (op.op === 'clear') {
      for (const a of AXIS_NAMES) {
        agg[a] = 0
        over[a] = null
        best[a].pos = null
        best[a].neg = null
      }
      quota.clear()
      continue
    }
    if (op.op === 'set') {
      over[op.axis] = { value: clampAxis(op.axis, op.value), until: op.until, why: op.why, at: op.at }
      continue
    }
    // 同类每小时配额：超额照记（日志里在），但不算进数值，也不更新"主因"。
    const key = `${Math.floor(op.at / HOUR)}|${op.kind}`
    const used = quota.get(key) ?? 0
    if (used >= AFFECT_STIM_PER_HOUR) {
      ignored += 1
      continue
    }
    quota.set(key, used + 1)
    const w = weightOf(op.kind)
    for (const a of AXIS_NAMES) {
      const delta = w[a]
      if (delta === 0) continue
      agg[a] = mergeOffset(agg[a], delta)
      const slot = delta > 0 ? 'pos' : 'neg'
      const cur = best[a][slot]
      if (!cur || Math.abs(delta) >= Math.abs(cur.weight)) {
        best[a][slot] = { weight: delta, kind: op.kind, why: op.why }
      }
    }
  }
  advance(nowTs)

  const values = {}
  for (const a of AXIS_NAMES) {
    const o = over[a]
    values[a] = o ? o.value : clampAxis(a, AXES[a].base + agg[a])
  }
  const manual = AXIS_NAMES.filter((a) => over[a] !== null)
  // 几根轴同时被手动改过时，"到期"取最早的那个：先说最先失效的那条。
  const deadlines = manual.map((a) => over[a].until)
  const until = deadlines.length === 0 || deadlines.includes(null) ? null : Math.min(...deadlines)
  return { values, manual, until, ignored, best, over }
}

// 偏移本身也得待在量程里：不然 override 到期后 agg 会把值顶出 [0,100] 再被 clamp，白丢信息。
function clampOffset(axis, offset) {
  const spec = AXES[axis]
  return clampAxis(axis, spec.base + offset) - spec.base
}

// 归因（design §14.11 第三条：必须可解释）：每条 why 都指向真实的 kind、真实的值。
function explain({ state, values, mood, stored, ignored, skipped }) {
  const out = []
  for (const a of state.manual) {
    const o = state.over[a]
    const tail = o.until === null ? '不会自动恢复' : '到期后从这个值继续衰减'
    out.push(`${AXIS_TEXT[a]} 手动设为 ${fmt(o.value)}（${o.why}）：${tail}`)
  }
  const quiet = deadband(values.v, values.e)
  const manual = new Set(state.manual)
  const axes = quiet ? ['t', 'r'] : ['v', 'e', 't', 'r']
  if (quiet) {
    out.push(`没变：${AXIS_TEXT.v} ${fmt(values.v)} / ${AXIS_TEXT.e} ${fmt(values.e)} 在基线附近（死区）`)
  }
  for (const a of axes) {
    // 手动改过的轴不再点主因：那根轴的数是人给的，赖到某条刺激头上就是说谎。
    if (manual.has(a)) continue
    const line = axisLine(a, values, state)
    if (line) out.push(line)
  }
  if (!quiet && out.length === 0) out.push(`没变：四轴都贴着基线（${mood}）`)
  const high = []
  if (stored.peaks.trust > AXES.t.base && stored.peaks.trust > values.t) {
    high.push(`${AXIS_TEXT.t}最高到过 ${fmt(stored.peaks.trust)}`)
  }
  if (stored.peaks.respect > AXES.r.base && stored.peaks.respect > values.r) {
    high.push(`${AXIS_TEXT.r}最高到过 ${fmt(stored.peaks.respect)}`)
  }
  if (high.length > 0) out.push(`${high.join('、')}：走过的路不随衰减抹掉`)
  if (stored.mood && stored.mood !== mood) {
    out.push(`标签从「${stored.mood}」换到「${mood}」（越界 ${AFFECT_HYST} 分才换）`)
  }
  if (ignored > 0) out.push(`另有 ${ignored} 条同类刺激超额未计（每小时最多 ${AFFECT_STIM_PER_HOUR} 次）`)
  if (skipped > 0) out.push(`跳过 ${skipped} 行读不懂的日志`)
  return out
}

// 单轴一句话：说到数值就点出主因是哪条真实刺激（kind 与它自己的 why），不硬编一个理由。
function axisLine(axis, values, state) {
  const off = values[axis] - AXES[axis].base
  if (Math.abs(off) < 0.05) return null
  const side = off > 0 ? '高' : '低'
  const src = bestOf(axis, off, state)
  const from = src ? `，主因 ${src.kind}（${src.why}）` : ''
  return `${AXIS_TEXT[axis]} ${fmt(values[axis])}，比基线${side} ${fmt(Math.abs(off))}${from}`
}

// 主因 = 与偏移同向、权重最大的那条刺激；同向一条都没有就不硬点（免得说反了）。
function bestOf(axis, off, state) {
  const slot = off > 0 ? 'pos' : 'neg'
  return state.best[axis][slot] ?? state.best[axis][off > 0 ? 'neg' : 'pos']
}

// 数值口径：why 里给人看一位小数，判定用原值——别把显示精度当精度。
function fmt(value) {
  return String(Math.round(value * 10) / 10)
}

// 峰值（design §14.14.2）：只升不降。回落到基线是常态，抹掉曾经到过的高度才是失真。
// 形状照 design §14.14：peaks = { trust, respect, at }——两个数，外加最后一次刷新峰值的时刻。
function raise(prevValue, prevAt, value, at) {
  if (!Number.isFinite(value) || value <= prevValue) return { value: prevValue, at: prevAt }
  return { value, at }
}

function later(a, b) {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null
  if (!Number.isFinite(b)) return a
  return Math.max(a, b)
}

// 峰值的下限是基线：信任从 40 起步，所以"最高到过 40"在没刺激的日子也是实话。
function emptyPeaks() {
  return { trust: AXES.t.base, respect: AXES.r.base, at: null }
}

function peaksOf(stored, values, at) {
  const trust = raise(stored.trust, stored.at, values.t, at)
  const respect = raise(stored.respect, stored.at, values.r, at)
  return { trust: trust.value, respect: respect.value, at: later(trust.at, respect.at) }
}

function pickPeaks(raw) {
  const out = emptyPeaks()
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['trust', 'respect']) {
    if (Number.isFinite(raw[key])) out[key] = raw[key]
    // 老形状（{ value, at }）也认：峰值不该因为改过一次形状就读不懂。
    else if (raw[key] && Number.isFinite(raw[key].value)) out[key] = raw[key].value
  }
  if (Number.isFinite(raw.at)) out.at = raw.at
  return out
}

// meta.json 里 affect 那一段（水位与冷却记录跟别的模块共用一个文件，只改自己这一格）。
function loadMeta(homeDir, at) {
  const doc = readJson(metaFile(homeDir, at))
  if (doc === null) return { doc: null, bad: false, peaks: emptyPeaks(), mood: null }
  if (doc.__bad === true) return { doc: null, bad: true, peaks: emptyPeaks(), mood: null }
  const affect = doc && typeof doc.affect === 'object' && doc.affect !== null ? doc.affect : {}
  return {
    doc,
    bad: false,
    peaks: pickPeaks(affect.peaks),
    mood: typeof affect.mood === 'string' ? affect.mood : null,
  }
}

// 峰值与上一个标签写回 meta.json：writeAtomic 是 async，所以 set/clear/stim 都是 async。
// meta.json 读不懂时不写——覆盖掉别人的水位与冷却记录，比丢一个峰值糟得多。
async function syncPeaks(homeDir, snap, { forgetMood = false } = {}) {
  const meta = loadMeta(homeDir, snap.at)
  if (meta.bad) return { saved: false, why: 'meta.json 读不懂，峰值没写（不覆盖别人的文件）' }
  const peaks = peaksOf(meta.peaks, { t: snap.t, r: snap.r }, snap.at)
  const mood = forgetMood ? null : snap.mood
  const same = peaks.trust === meta.peaks.trust
    && peaks.respect === meta.peaks.respect
    && meta.mood === mood
  if (same) return { saved: false, why: '' }
  const affect = { ...(meta.doc && meta.doc.affect ? meta.doc.affect : {}) }
  affect.peaks = peaks
  if (mood === null) delete affect.mood
  else affect.mood = mood
  affect.at = snap.at
  const text = JSON.stringify({ ...(meta.doc ?? {}), affect }, null, 2)
  await writeAtomic(metaFile(homeDir, snap.at), `${text}\n`)
  return { saved: true, why: '' }
}

// meta.json 的路径从 store 的 stateFile 推出来（同一层目录、同一条分片规则），不自己拼数据目录；
// 字面名与 audit/doctor.mjs:164 的读法一致（store 门面没有 meta 访问器，也改不得）。
function metaFile(homeDir, at) {
  return path.join(path.dirname(stateFile(homeDir, KIND, at)), 'meta.json')
}
