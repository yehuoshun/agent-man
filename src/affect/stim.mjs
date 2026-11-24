// stim 管刺激的封闭表与记账（design §14.7 / §14.10 / §14.11）：调用方只传 kind，不许传权重。
// 日志只追加，一条刺激一条行；当前数值不写进来——账本记的是"发生了什么"，不是"现在多少"。
import fs from 'node:fs'
import path from 'node:path'

import {
  AFFECT_BIAS_IMP, AFFECT_NEG_WEIGHT, AFFECT_STIM_PER_HOUR, AFFECT_WEIGHTS, now,
} from '../core/index.mjs'
import { appendJsonl, ensure, readJsonl, stateFile } from '../store/index.mjs'
import { AXIS_NAMES } from './decay.mjs'

const KIND = 'affect'
const HOUR = 60 * 60 * 1000 // 单位换算，不是 §10 的调参常数
const SHARD_RE = /^affect-(\d{4})-(\d{2})\.jsonl$/

// 封闭枚举（design §14.7）：表在 core/const.mjs，这里只给名字。
export const KINDS = Object.freeze(Object.keys(AFFECT_WEIGHTS))

const KIND_SET = new Set(KINDS)
const AXIS_SET = new Set(AXIS_NAMES)

// kind → 四轴增量，负向在这里统一乘 AFFECT_NEG_WEIGHT。
// 乘在读取侧、不乘在 core 表里：权重表只有一份，谁要权重都得走这个函数。
// neg = "同一件事发生在另一边"（decisions.md 已批准口径：只让"零轴"那一侧取负）：
// 表里值为 0 的格翻成 −1（task.done 的 Δr），已有正负号的格原样不动（user.praise 翻不成负向）；
// 表里写明 free 的行（self.report 的 ±1）只翻那几格。翻出来的 −1 不再乘负向系数：
// 它不是"更重的负向刺激"，只是把没方向的格指到负侧。
export function weightOf(kind, { neg = false } = {}) {
  const w = AFFECT_WEIGHTS[kind]
  if (!w) throw new TypeError(`未知的刺激 kind：${String(kind)}（只认 ${KINDS.join(' / ')}）`)
  const free = Array.isArray(w.free) ? w.free : null
  const one = (axis) => {
    const delta = w[axis]
    const flip = free ? free.includes(axis) : delta === 0
    if (neg && flip) return delta === 0 ? -1 : -delta
    return delta < 0 ? delta * AFFECT_NEG_WEIGHT : delta
  }
  return Object.freeze({ v: one('v'), e: one('e'), t: one('t'), r: one('r') })
}

function whyOf(input) {
  const why = typeof input.why === 'string' ? input.why.trim() : ''
  // 没有 why 的刺激拒绝写入（design §14.11 第三条不变量）：一条说不出来由的刺激没有价值。
  if (why === '') throw new TypeError('刺激必须带 why：说不出来由的刺激没有价值（design §14.11）')
  return why
}

// 每小时一桶：同为整点小时里的同 kind 刺激共用一个配额。
// 用 epoch 小时而不是本地钟点——桶边界不该随机器时区漂。
function bucketOf(at) {
  return Math.floor(at / HOUR)
}

// 记账（design §14.11）：kind + why + at 三样缺一不可，写一行 appendJsonl（open/fsync/读回都归 store）。
// 配额超出照样落盘（不静默丢），只是回 ignored=true，由调用方报 "! 同类刺激超额未计 N 条"。
// 行形状照 design §14.13 补齐（tag/v/a/imp/src）：账本要能裸读——op 说明做了什么，tag 是哪一个，
// v/a/imp 是这一次给各轴的量，src 是谁记的。重放仍只认 kind（表是唯一真源），这几个字段是抄本。
export function record(homeDir, input = {}) {
  const kind = input.kind
  if (!KIND_SET.has(kind)) throw new TypeError(`未知的刺激 kind：${String(kind)}（只认 ${KINDS.join(' / ')}）`)
  const why = whyOf(input)
  const at = Number.isFinite(input.at) ? input.at : now()
  const neg = input.neg === true
  const src = typeof input.src === 'string' && input.src.trim() !== '' ? input.src.trim() : 'cli'
  // 先看这一小时里同 kind 已经计入几条，再落盘：超额的照写，只是不进计算。
  const used = countedIn(homeDir, kind, at)
  const w = weightOf(kind, { neg })
  const item = { op: 'stim', at, kind, tag: kind, v: w.v, a: w.e, imp: AFFECT_BIAS_IMP, src, why }
  if (neg) item.neg = true
  appendOp(homeDir, item)
  return { item, counts: Math.min(used + 1, AFFECT_STIM_PER_HOUR), ignored: used >= AFFECT_STIM_PER_HOUR }
}

// 这一小时、这个 kind 里已经"计入"的条数。口径：counts = 计入权重的条数（§14.7 每小时最多 3 条），
// 超额行照样落盘但不再计入——到这里就封顶，否则 ignored 会一直涨、counts 会说"计了 7 条"。
function countedIn(homeDir, kind, at) {
  const bucket = bucketOf(at)
  let used = 0
  for (const file of shards(homeDir, at, at)) {
    const got = readJsonl(file)
    for (const rec of got.items) {
      if (rec.op !== 'stim' || rec.kind !== kind) continue
      if (!Number.isFinite(rec.at) || bucketOf(rec.at) !== bucket) continue
      if (rec.at > at) continue
      used += 1
      if (used >= AFFECT_STIM_PER_HOUR) return used
    }
  }
  return used
}

// 写一条 op：ensure 只在这里调——读命令一行都不该写盘（design §5 末尾）。
export function appendOp(homeDir, rec) {
  ensure(homeDir)
  return appendJsonl(stateFile(homeDir, KIND, rec.at), rec)
}

// 跨月合读（design §3 的分片规则）：按自然边界粗筛分片，再按 at 精确过滤。
// 坏行（JSON 坏了、形状不全）跳过并计 skipped，由调用方用 "! " 报出来（AGENTS 五）。
export function list(homeDir, { from, to } = {}) {
  const lo = Number.isFinite(from) ? from : -Infinity
  const hi = Number.isFinite(to) ? to : now()
  const items = []
  let skipped = 0
  for (const file of shards(homeDir, lo, hi)) {
    const got = readJsonl(file)
    skipped += got.bad
    for (const rec of got.items) {
      const one = asOp(rec)
      if (!one) {
        skipped += 1
        continue
      }
      if (one.at < lo || one.at > hi) continue
      items.push(one)
    }
  }
  // 只认数字差；同毫秒保持文件顺序（Array#sort 稳定），读者看到的仍是"先写先算"。
  items.sort((a, b) => a.at - b.at)
  return { items, skipped }
}

// 一行日志 → 一条认识的 op；认不出就返回 null（读不懂的行算坏行，不猜、不补）。
function asOp(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null
  if (!Number.isFinite(rec.at)) return null
  if (rec.op === 'clear') return { op: 'clear', at: rec.at }
  if (rec.op === 'set') {
    if (!AXIS_SET.has(rec.axis) || !Number.isFinite(rec.value)) return null
    if (typeof rec.why !== 'string' || rec.why.trim() === '') return null
    // until 缺席 = 一直有效到 clear（写进 JSON 时 Infinity 会变 null，读回来还是"没有尽头"）。
    return {
      op: 'set', at: rec.at, axis: rec.axis, value: rec.value,
      until: Number.isFinite(rec.until) ? rec.until : null, why: rec.why,
    }
  }
  if (rec.op === 'stim') {
    if (!KIND_SET.has(rec.kind)) return null
    if (typeof rec.why !== 'string' || rec.why.trim() === '') return null
    // neg 必须带过去：重放要按翻过的符号算，不然"取负"只在写盘那一刻成立、读侧又变回正的。
    const one = { op: 'stim', at: rec.at, kind: rec.kind, why: rec.why }
    if (rec.neg === true) one.neg = true
    return one
  }
  return null
}

// 分片枚举：store 的 listShards 只认它列出的五种（affect 不在里面，store 不许改），
// 所以目录从 store 的 stateFile 推出来，名字按同一条命名规则筛——不自己拼数据目录。
function shards(homeDir, from, to) {
  const probe = Number.isFinite(to) ? to : Number.isFinite(from) ? from : now()
  const dir = path.dirname(stateFile(homeDir, KIND, probe))
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    // 还没写过任何东西：空结果不等于出错，第一次写盘时 ensure 会把目录建出来。
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  const found = []
  for (const name of names) {
    const span = spanOf(name)
    if (!span) continue
    if (Number.isFinite(from) && span.end <= from) continue
    if (Number.isFinite(to) && span.start > to) continue
    found.push(span)
  }
  found.sort((a, b) => a.start - b.start)
  return found.map((one) => path.join(dir, one.name))
}

// 文件名 → 覆盖的半个开区间 [start, end)。本地构造零点，与 core 的 monthKey 同一口径。
function spanOf(name) {
  const m = SHARD_RE.exec(name)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  return { name, start: new Date(y, mo, 1).getTime(), end: new Date(y, mo + 1, 1).getTime() }
}
