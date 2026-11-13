import { appendJsonl, claim, ensure } from '../store/index.mjs'

import {
  PATCHABLE,
  assertRecord,
  checkFact,
  checkImp,
  closureOf,
  isLive,
  memoryFile,
  nextAt,
  nowOf,
  readState,
  requireHome,
} from './shape.mjs'

// 再巩固（design §2/§6）：只追加新版本，旧行不改。
// 新版本是一个新 id（claim 发号），by 指向被修订的那条：这是"它从哪来"的出处；
// 旧记录的收口版本再把 to/by 填成新版本。两行都是追加，原行逐字不动。
// patch 只允许改事实与重要度：at/id/key 是历史坐标，改了旧版本就对不上证据链。
export async function revise(id, patch, ctx = {}) {
  const home = requireHome(ctx)
  const base = nowOf(ctx)
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('revise 需要一条记录的 id（记忆 id 或 key 都能查，真正动版本的是 id）')
  }
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  for (const field of Object.keys(input)) {
    if (!PATCHABLE.has(field)) {
      throw new Error(`revise 只能改 fact / imp，不能改 ${field}：历史坐标（at/id/key/from）不许重写`)
    }
  }
  if (!('fact' in input) && !('imp' in input)) {
    throw new Error('revise 没有要改的东西：至少给 fact 或 imp（只更新 seen 那是 digest 的事）')
  }

  const state = readState(ctx)
  const current = state.records.find((rec) => rec.id === id.trim())
  if (!current) {
    throw new Error(`没有这条记忆：${id}（先 memory ls 看 id，别按模糊名字改）`)
  }
  if (!isLive(current)) {
    throw new Error(`记忆 ${id} 已被 ${current.by} 取代（to=${current.to}）：改活的那条，别复活旧版本`)
  }

  const fact = 'fact' in input ? checkFact(input.fact) : current.fact
  const imp = 'imp' in input ? checkImp(input.imp) : current.imp

  const at = nextAt(state.records, current.key, base)
  ensure(home)
  const nextId = await claim(home, 'm')
  const record = assertRecord({
    id: nextId,
    at,
    key: current.key,
    fact,
    imp,
    // 有效性起点是这条记忆的，不是这次改写的：再巩固不该让旧账从今天重新开始。
    from: current.from,
    to: null,
    by: current.id,
    // 证据与复述次数跟着记忆走：再巩固不是重新认识。
    evidence: { ids: [...current.evidence.ids], from: current.evidence.from, to: current.evidence.to },
    seen: current.seen,
  })

  // 先落新版本、再收口旧的：中途崩会留下两条活记录（conflict 报得出），
  // 反过来会留下"旧的失效、新的没写"——那才是真的丢记忆。
  appendJsonl(memoryFile(home), record)
  appendJsonl(memoryFile(home), closureOf(current, record.at, record.id))

  return { status: 'revised', id: nextId, from: current.id, record, skipped: state.skipped }
}

// 冲突只报给人看，不自动消解、不调模型（简报）：同 key 多条活记录说明写入中途崩过，
// 或者有人绕开门面直接追加。按 at 升序报出，最早的在前。
export function conflict(key, ctx = {}) {
  if (key && typeof key === 'object' && !Array.isArray(key) && !ctx.home) {
    ctx = key
    key = undefined
  }
  const state = readState(ctx)
  let items = state.records.filter(isLive)
  if (key !== undefined) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('conflict 的 key 要么不给（查全部），要么给非空槽位名')
    }
    items = items.filter((rec) => rec.key === key.trim())
  }
  const byKey = new Map()
  for (const rec of items) {
    const bucket = byKey.get(rec.key) ?? []
    bucket.push(rec)
    byKey.set(rec.key, bucket)
  }
  const conflicts = []
  for (const [slot, bucket] of byKey) {
    if (bucket.length < 2) continue
    conflicts.push({
      key: slot,
      items: bucket.slice().sort((a, b) => a.at - b.at),
      ids: bucket.map((rec) => rec.id),
    })
  }
  return { items: conflicts, skipped: state.skipped }
}
