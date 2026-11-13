import { appendJsonl, claim, ensure } from '../store/index.mjs'

import {
  assertRecord,
  checkEvidence,
  checkFact,
  checkImp,
  checkKey,
  closureOf,
  countResolved,
  eventIndex,
  liveForKey,
  makeRecord,
  memoryFile,
  nextAt,
  nowOf,
  readState,
  requireHome,
  timeOf,
} from './shape.mjs'

// 写一条语义记忆（design §4）。key 是唯一槽位：同 key 已有活记录时，新条取代它，
// 新条继承旧的 from（有效性起点是这条记忆的，不是这次改写的）。
// memory.jsonl 只追加，所以"收口旧记录"也是追加一条同 id 的新版本（to/by 填上），
// 原行逐字不动——仓库里没有任何原地改写（AGENTS 五）。
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
