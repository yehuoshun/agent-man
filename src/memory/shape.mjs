import path from 'node:path'

import { MEMORY_MAX, cost, now as coreNow, parseWhen } from '../core/index.mjs'
import { listShards, readJsonl, validate } from '../store/index.mjs'

// 一条语义记忆的字段就这十个（design §4）。写入、读取、复制都按这张表走：
// 少一个字段的旧行在读取时算坏行，而不是拿 at 或 0 去替它猜一个值。
const FIELDS = ['id', 'at', 'key', 'fact', 'imp', 'from', 'to', 'by', 'evidence', 'seen']

// revise 只许动这两样（design §2 再巩固）：at/id/key 是历史，改了旧版本就对不上证据。
export const PATCHABLE = new Set(['fact', 'imp'])
// --imp 0..3 是命令面写死的范围（design §6），不在 §10 的常数表里，所以住这里。
export const IMP_MAX = 3

export function memoryFile(home) {
  return path.join(home, 'memory.jsonl')
}

// ctx 是这一层唯一能看到数据目录的地方：home 由 CLI 从 AGENT_MAN_HOME 解析后传进来。
export function requireHome(ctx) {
  const home = ctx && typeof ctx.home === 'string' ? ctx.home.trim() : ''
  if (home === '') {
    throw new Error('memory 需要一个数据目录：ctx.home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  }
  return home
}

// 时间只由 core/time 解释（AGENTS 二·3）：字符串在这里一次性变成 epoch ms，
// 之后全链路只认数字。认不出就抛，不猜"大概几点"。
export function timeOf(value, base, what) {
  if (value === undefined || value === null) return null
  if (Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const at = parseWhen(value, base)
    if (at !== null) return at
  }
  throw new Error(`${what} 认不出时间：${String(value)}（可用 2026-11-13、2026-11-13 21:40、3d）`)
}

// now 只用来算默认窗口与缺省 at；用例一律传死，业务代码不散落 Date.now()。
export function nowOf(ctx) {
  return ctx && Number.isFinite(ctx.now) ? ctx.now : coreNow()
}

export function checkKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('key 必须是非空字符串：它是唯一槽位，没有槽位就不知道新条该取代谁')
  }
  return value.trim()
}

export function checkFact(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('fact 必须是非空字符串：一条什么都没说的结论不该进库')
  }
  const fact = value.trim()
  const used = cost(fact)
  if (used > MEMORY_MAX) {
    throw new Error(`fact 的预算是 ${MEMORY_MAX} cost，这条 ${used.toFixed(1)}：拆成两条，或删掉修饰`)
  }
  return fact
}

export function checkImp(value) {
  if (value === undefined || value === null) return 0
  if (!Number.isInteger(value) || value < 0 || value > IMP_MAX) {
    throw new Error(`imp 只能是 0..${IMP_MAX} 的整数，拿到的是 ${String(value)}`)
  }
  return value
}

// 证据只有一种合法形状：至少 1 条事件 id，外加可选的覆盖区间。
// 这里只验形状；"id 能不能解析到真实事件"要读盘，由 add 做（读盘不归 store）。
export function checkEvidence(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evidence 必须是 { ids, from, to }：结论要么有事件撑着，要么就是猜的')
  }
  if (!Array.isArray(value.ids) || value.ids.length === 0) {
    throw new Error('evidence.ids 至少要有 1 条事件 id：解析不到证据的结论不算结论')
  }
  const ids = []
  for (const raw of value.ids) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('evidence.ids 里每一项都必须是非空事件 id')
    }
    const id = raw.trim()
    // 同一个 id 写两遍不是更强的证据：留一份，免得以后按条数算"证据多充分"。
    if (!ids.includes(id)) ids.push(id)
  }
  return {
    ids,
    from: timeOf(value.from, base, 'evidence.from'),
    to: timeOf(value.to, base, 'evidence.to'),
  }
}

export function copyEvidence(evidence) {
  return { ids: [...evidence.ids], from: evidence.from, to: evidence.to }
}

// 新记录一律 to/by 为空（刚写下的结论还没有被谁取代），seen 由调用方给。
export function makeRecord({ id, at, key, fact, imp, from, evidence, seen }) {
  return {
    id,
    at,
    key,
    fact,
    imp,
    from,
    to: null,
    by: null,
    evidence: copyEvidence(evidence),
    seen,
  }
}

// 读进来的一条记录到底算不算数：store 只验形状，这里补上 to/by/imp/seen 与缺字段。
// 坏行不抛、不静默：调用方把 errors 折成 skipped 计数（AGENTS 五）。
export function inspectRecord(rec) {
  const errors = validate('memory', rec).errors.slice()
  for (const field of FIELDS) {
    if (!(field in rec)) errors.push(`缺 ${field}：读不出完整的一条记忆`)
  }
  if (!Number.isFinite(rec.from)) errors.push('from 必须是有限数字（epoch ms）')
  if (rec.to !== null && !Number.isFinite(rec.to)) errors.push('to 只能是 null 或有限数字（epoch ms）')
  if (rec.by !== null && (typeof rec.by !== 'string' || rec.by.trim() === '')) {
    errors.push('by 只能是 null 或非空 id 字符串')
  }
  if (!Number.isInteger(rec.imp) || rec.imp < 0 || rec.imp > IMP_MAX) {
    errors.push(`imp 只能是 0..${IMP_MAX} 的整数`)
  }
  if (!Number.isInteger(rec.seen) || rec.seen < 0) errors.push('seen 必须是非负整数')
  return errors
}

export function assertRecord(rec) {
  const errors = inspectRecord(rec)
  if (errors.length > 0) {
    throw new Error(`记忆记录不合法：${errors.join('；')}（不猜、不补，先改输入）`)
  }
  return rec
}

// memory.jsonl 只追加（AGENTS 五）：同一 id 可能有多行——收口旧记录时追加的是
// "同一记录的新版本"（to/by 填上），原行逐字不动。所以按 id 取 at 最大的那版；
// at 相同时后写的赢（add 的收口行与原文 at 相同，收口行在后，读出来就是失效）。
// 坏行（解析失败或形状不合法）跳过并计数，绝不因为一行坏掉丢整份记忆。
export function readState(ctx) {
  const home = requireHome(ctx)
  const { items, bad } = readJsonl(memoryFile(home))
  let skipped = bad
  const latest = new Map()
  for (const rec of items) {
    if (inspectRecord(rec).length > 0) {
      skipped += 1
      continue
    }
    const prev = latest.get(rec.id)
    if (prev === undefined || rec.at >= prev.at) latest.set(rec.id, rec)
  }
  return { home, records: [...latest.values()], skipped }
}

export function isLive(rec) {
  return rec.to === null
}

export function liveForKey(records, key) {
  return records.filter((rec) => rec.key === key && isLive(rec))
}

// 条数只按 at 的数字差排（AGENTS 五）；同一 key 的版本链也靠它，不靠字符串。
export function versionsOf(records, key) {
  return records.filter((rec) => rec.key === key).sort((a, b) => a.at - b.at)
}

// 同一 key 的新版本必须晚于所有旧版本：两件事落在同一毫秒时（真会撞上），
// 往后挪 1ms 让 [from, to) 仍是非空区间，不然收口出来的区间是反的。
export function nextAt(records, key, base) {
  let top = null
  for (const rec of records) {
    if (rec.key !== key) continue
    if (top === null || rec.at > top) top = rec.at
  }
  return top !== null && top >= base ? top + 1 : base
}

// 收口 = 同一条记录的下一版：内容原样，只把 to 写成新记录的 at、by 写成新记录的 id。
export function closureOf(rec, at, byId) {
  return { ...rec, to: at, by: byId }
}

// 事件只在这里读：证据要落在真实事件上，"解析不到"才是拒绝的依据（design §4）。
// 形状不合法的行既不算证据、也不丢掉——计数进 skipped，别让一条坏行假装事件存在。
export function eventIndex(ctx) {
  const home = requireHome(ctx)
  const index = new Map()
  let skipped = 0
  for (const file of listShards(home, 'events')) {
    const { items, bad } = readJsonl(file)
    skipped += bad
    for (const rec of items) {
      if (!validate('events', rec).ok) {
        skipped += 1
        continue
      }
      index.set(rec.id, rec)
    }
  }
  return { index, skipped }
}

export function countResolved(evidence, index) {
  let found = 0
  for (const id of evidence.ids) if (index.has(id)) found += 1
  return found
}
