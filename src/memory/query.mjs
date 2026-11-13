import { DEFAULT_WINDOW_DAYS } from '../core/index.mjs'
import { listShards, readJsonl, validate } from '../store/index.mjs'

import {
  eventIndex,
  isLive,
  liveForKey,
  nowOf,
  readState,
  requireHome,
  timeOf,
  versionsOf,
} from './shape.mjs'

// 天→毫秒只是单位换算，不是 §10 的常数：30 天窗口的 30 来自 core。
const DAY_MS = 24 * 60 * 60 * 1000

function readOptions(opts, ctx, name) {
  const input = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}
  if (input.home && !(ctx && ctx.home)) return { opts: {}, ctx: input }
  if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts))) {
    throw new Error(`${name} 的选项必须是对象（如 { live: false, all: true }）`)
  }
  return { opts: input, ctx }
}

// 读取一律不改盘（design §5）：窗口、存活、key 都只是筛选。
// 默认只给 30 天内还活着的记录；--all 才连窗口和失效版本一起拿出来。
function select(state, opts, ctx) {
  const base = nowOf(ctx)
  const all = opts.all === true
  const since = timeOf(opts.since, base, 'since')
  const until = timeOf(opts.until, base, 'until')
  const live = all ? opts.live === true : opts.live !== false
  const from = since ?? (all ? null : base - DEFAULT_WINDOW_DAYS * DAY_MS)
  let key = null
  if (opts.key !== undefined) {
    if (typeof opts.key !== 'string' || opts.key.trim() === '') {
      throw new Error('key 过滤要给非空槽位名（空串不是"不筛"）')
    }
    key = opts.key.trim()
  }

  let items = state.records.filter((rec) => {
    if (live && !isLive(rec)) return false
    if (from !== null && rec.at < from) return false
    if (until !== null && rec.at > until) return false
    if (key !== null && rec.key !== key) return false
    return true
  })
  items = items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return { items, from, until, live, all }
}

export function ls(opts = {}, ctx = {}) {
  const parsed = readOptions(opts, ctx, 'ls')
  const state = readState(parsed.ctx)
  const view = select(state, parsed.opts, parsed.ctx)
  return {
    items: view.items,
    skipped: state.skipped,
    since: view.from,
    until: view.until,
    live: view.live,
    all: view.all,
  }
}

// design §7 里这一层叫 list；简报叫 ls。两个名字都给，行为是同一个。
export function list(opts = {}, ctx = {}) {
  return ls(opts, ctx)
}

// 情景层按天分片（design §3）：跨天必须合读，否则"昨天那条"会在今天的窗口里凭空不见。
// events(home, { from, to }) → { items, bad }：窗口是 [from, to] 两端都含，
// 分片名只做粗筛，精确到毫秒的窗口在这里再判一次；坏行（JSON 坏了或过不了 schema）
// 跳过并计数，由调用方用 "! " 报出去——一行坏掉不该让整份情景读不出来。
export function events(home, opts = {}) {
  const dir = requireHome({ home })
  const since = boundOf(opts.from, 'from')
  const until = boundOf(opts.to, 'to')
  const items = []
  let bad = 0

  for (const file of listShards(dir, 'events', { from: since, to: until })) {
    const got = readJsonl(file)
    bad += got.bad
    for (const rec of got.items) {
      if (!validate('events', rec).ok) {
        bad += 1
        continue
      }
      // 窗口外的行不算坏：它只是不在这次问的区间里。
      if (since !== null && rec.at < since) continue
      if (until !== null && rec.at > until) continue
      items.push(rec)
    }
  }
  // 只认 at 的数字差（AGENTS 五）；同一毫秒保留文件内次序，不另编序号。
  items.sort((a, b) => a.at - b.at)
  return { items, bad }
}

function boundOf(value, what) {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value)) {
    throw new Error(`events 的 ${what} 只能是有限数字（epoch ms），拿到的是 ${String(value)}`)
  }
  return value
}

// 字面搜索（简报）：不降维、不做语义相似度，只问 fact 里有没有这个子串。
// 大小写折叠只为 ASCII 好用；中文没有大小写，折叠不改变"逐字"这件事。
export function find(query, opts = {}, ctx = {}) {
  const parsed = readOptions(opts, ctx, 'find')
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('find 需要一个非空查询：空查询会把整库倒出来，那不是搜索')
  }
  const needle = query.trim().toLowerCase()
  const state = readState(parsed.ctx)
  const view = select(state, parsed.opts, parsed.ctx)
  const items = view.items.filter((rec) => rec.fact.toLowerCase().includes(needle))
  return { items, skipped: state.skipped, query: query.trim(), live: view.live, all: view.all }
}

// 一条记录 + 它的证据 + 它所在槽位的版本链（按 at 升序，人读得懂先后）。
// id 查得到就用 id；查不到再当 key 查——key 有多个活记录就是冲突，直接报错不挑一条。
export function show(idOrKey, ctx = {}) {
  requireHome(ctx)
  if (typeof idOrKey !== 'string' || idOrKey.trim() === '') {
    throw new Error('show 需要记录 id 或槽位名')
  }
  const wanted = idOrKey.trim()
  const state = readState(ctx)
  let record = state.records.find((rec) => rec.id === wanted) ?? null
  if (record === null) {
    const live = liveForKey(state.records, wanted)
    if (live.length > 1) {
      throw new Error(`槽位「${wanted}」有 ${live.length} 条活记录（冲突）：先 memory ls --key 看清再指定 id`)
    }
    record = live[0] ?? null
  }
  if (record === null) {
    return { record: null, evidence: [], chain: [], skipped: state.skipped }
  }

  const events = eventIndex(ctx)
  const evidence = record.evidence.ids.map((id) => ({ id, found: events.index.has(id) }))
  const chain = versionsOf(state.records, record.key)
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((rec) => ({
      id: rec.id,
      at: rec.at,
      fact: rec.fact,
      imp: rec.imp,
      from: rec.from,
      to: rec.to,
      by: rec.by,
      live: isLive(rec),
    }))
  return { record, evidence, chain, skipped: state.skipped + events.skipped }
}

// 证据指向不存在的事件（简报）：只报出来给 audit 用，绝不自动删、不自动补。
// 失效记录也查——否则"坏证据"会随着记录失效一起被忘掉。
export function orphan(ctx = {}) {
  requireHome(ctx)
  const state = readState(ctx)
  const events = eventIndex(ctx)
  const items = []
  for (const rec of state.records) {
    const missing = rec.evidence.ids.filter((id) => !events.index.has(id))
    if (missing.length === 0) continue
    items.push({ id: rec.id, key: rec.key, fact: rec.fact, live: isLive(rec), missing })
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { items, skipped: state.skipped + events.skipped }
}
