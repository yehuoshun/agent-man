import { appendJsonl, claim, ensure } from '../store/index.mjs'

import {
  PATCHABLE,
  assertRecord,
  checkEvidence,
  checkFact,
  checkImp,
  checkKey,
  closureOf,
  countResolved,
  eventIndex,
  isLive,
  liveForKey,
  makeRecord,
  memoryFile,
  nextAt,
  nowOf,
  readState,
  requireHome,
  timeOf,
} from './shape.mjs'

// 写结论只有这一条路：add 造一个新版本、revise 在旧版本上再巩固，动作都是
// "追加新行 + 给被取代的那条追加一份收口副本"，原行逐字不动（design §2/§4，AGENTS 五）。
// 两件事写在同一份文件里，是因为它们共用一个不变量：同一槽位的版本链只能靠追加上去，
// 谁先谁后（先新条、后收口）决定崩在半路时剩下"两条活记录"还是"旧的已死、新的没写"。
// 那个顺序只在两处都看得见时才是可读的；分成两个文件，下一个人改一处就会破掉另一处的前提。
// conflict 也留在这里：它报的正是这条写入路径被打断后留下的痕迹。

// 写一条语义记忆（design §4）。key 是唯一槽位：同 key 已有活记录时，新条取代它，
// 新条继承旧的 from（有效性起点是这条记忆的，不是这次改写的）。
export async function add(entry, ctx = {}) {
  const home = requireHome(ctx)
  const base = nowOf(ctx)
  const input = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}

  const key = checkKey(input.key)
  const fact = checkFact(input.fact)
  const imp = checkImp(input.imp)
  const evidence = checkEvidence(input.evidence, base)
  const wantedAt = timeOf(input.at, base, 'at')
  const wantedFrom = timeOf(input.from, base, 'from')

  // 一条证据都解析不到就是猜的：拒绝，不写半条（design §4）。
  const events = eventIndex(ctx)
  if (countResolved(evidence, events.index) === 0) {
    throw new Error(`证据解析不到任何真实事件（${evidence.ids.join('、')}）：先用 event add 记下发生过的事`)
  }

  const state = readState(ctx)
  // 读命令之外的坏行也要说出来：这次写盘顺手读到的，一并计数交回调用方。
  const skipped = state.skipped + events.skipped
  const live = liveForKey(state.records, key)

  // 逐字去重：同 key 的活记录 fact 与 imp 都一样时不算"取代"，也不写新版本。
  // 只说 fact 不看 imp 会把"同内容但更重要了"悄悄吞掉，所以两样都要相同。
  if (live.length === 1 && live[0].fact === fact && live[0].imp === imp) {
    return { status: 'same', id: live[0].id, skipped }
  }

  const at = nextAt(state.records, key, wantedAt ?? base)
  // 多个活记录只可能来自并发写坏（conflict 会报）；收口时都取代，
  // from 取最早的那个：宁可把历史拉长，也不把一条记忆的有效期改短。
  const inherited = live.length > 0 ? Math.min(...live.map((rec) => rec.from)) : null
  const from = inherited ?? wantedFrom ?? evidence.from ?? at

  ensure(home)
  const id = await claim(home, 'm')
  const record = assertRecord(makeRecord({ id, at, key, fact, imp, from, evidence, seen: 0 }))

  // 先落新条再收口：中途崩了会留下两条活记录（conflict 看得见），
  // 反过来则会留下"旧的已失效、新的没写"——那才是真的丢记忆。
  appendJsonl(memoryFile(home), record)
  for (const old of live) appendJsonl(memoryFile(home), closureOf(old, record.at, record.id))

  return { status: 'added', id, record, replaced: live.map((rec) => rec.id), skipped }
}

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
