// 欠账：还没巩固 / 还没反思的量，加上两条水位（上次巩固、上次开口）。
// 这些数住在状态文件的那一格（design §4），程序写、人只读。四条写入口都是先读后写：
// 读不懂就拒写——把别人的键（峰迹、冷却记录）整片覆盖掉，比丢一个数糟得多。
import {
  CLUSTER_DAYS, CLUSTER_HITS, DEBT_STALE, DEBT_SUM_IMP, DEBT_UNREFLECTED,
  config, now,
} from '../core/index.mjs'
import { plans } from '../intent/index.mjs'
import { events } from '../memory/index.mjs'
import { ensure, metaFile, readJson, writeAtomic } from '../store/index.mjs'

// 单位换算，不是 §10 的调参常数。
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// 欠账快照（design §7 的 mind/debt state）。三个门槛里任意一个够了就算"该巩固了"；
// 外加 design §2 那句"线索累计触发，不是定时器"：同一个线索在 CLUSTER_DAYS 天里出现
// CLUSTER_HITS 次，本身就是该停下来想一想的信号。
export function state(homeDir, options = {}) {
  // design §7 的表写作 state(home, now)：数字也认，省得调用方包一层。
  const input = Number.isFinite(options) ? { now: options } : options
  const at = Number.isFinite(input.now) ? input.now : now()
  const warnings = []
  const cfg = input.cfg ?? config.load({ homeDir, now: at, warn: (m) => warnings.push(m) })
  const limits = limitsOf(cfg)
  const meta = readMeta(homeDir)
  const debt = debtOf(meta.doc)
  // 教训只从"上次巩固之后"算起：巩固过的情景不该第二次来讨账。
  const got = events(homeDir, { from: debt.lastAt, to: at })
  const clusters = clustersOf(got.items)
  const open = plans.list(homeDir, { now: at })
  const overdue = open.items
    .filter((one) => one.late)
    .map((one) => ({ id: one.id, due: one.due, text: one.text, lateBy: at - one.due }))
  const oldest = got.items.reduce((min, rec) => {
    const one = atOf(rec)
    return min === null || one < min ? one : min
  }, null)
  // 计时从"上次巩固"起算；还没巩固过就从最早那件没巩固的事算起——
  // 否则刚装好、刚记了一笔就会被当成"该巩固了"。
  const since = debt.lastAt === null ? oldest : debt.lastAt
  const idle = since === null ? null : at - since
  // 有东西没巩固：账上的数，或者上次巩固之后又攒下了情景（别的车道直接写的情景也算）。
  const pending = debt.unconsolidated > 0 || debt.unreflected > 0 || got.items.length > 0
  const stale = idle !== null && idle >= limits.stale && pending

  const why = []
  if (debt.unconsolidated >= limits.impSum) {
    why.push(`压着 ${debt.unconsolidated} imp（门槛 ${limits.impSum}）`)
  }
  if (debt.unreflected >= limits.unreflected) {
    why.push(`${debt.unreflected} 条情景没巩固（门槛 ${limits.unreflected}）`)
  }
  if (clusters.length > 0) {
    why.push(`${clusters.length} 个线索在 ${CLUSTER_DAYS} 天里各出现 ${CLUSTER_HITS} 次以上`)
  }
  if (stale) why.push(`已经 ${hoursOf(idle)} 小时没巩固（门槛 ${limits.staleHours} 小时）`)

  return {
    at,
    unconsolidated: debt.unconsolidated,
    unreflected: debt.unreflected,
    lastAt: debt.lastAt,
    // 计时的起点：有上次巩固就用它，没有就用最早那件没巩固的事（null = 还没得算）。
    since,
    idle,
    due: why.length > 0,
    why: why.join('，'),
    limits,
    clusters,
    overdue,
    bad: { events: got.bad, plans: open.bad, meta: meta.bad ? 1 : 0 },
    warnings,
  }
}

// 记一笔欠账。`event add` 之后调一次：imp 累进 unconsolidated，条数累进 unreflected。
// 这两个名字就是两个门槛的口径——DEBT_SUM_IMP 数的是分量，DEBT_UNREFLECTED 数的是件数。
export async function bump(homeDir, input = {}) {
  const at = Number.isFinite(input.at) ? input.at : now()
  const imp = input.imp === undefined ? 1 : input.imp
  if (!Number.isFinite(imp) || imp < 0) throw new TypeError(`欠账的 imp 要是非负数字：${String(imp)}`)
  const much = input.unreflected === undefined ? 1 : input.unreflected
  if (!Number.isFinite(much) || much < 0) {
    throw new TypeError(`欠账的条数要是非负数字：${String(much)}`)
  }
  const meta = readMeta(homeDir)
  const before = debtOf(meta.doc)
  const debt = {
    unconsolidated: before.unconsolidated + imp,
    unreflected: before.unreflected + much,
  }
  // lastAt 是"上次巩固"，bump 只往下加账，不动它；没有就不写这一格。
  if (before.lastAt !== null) debt.lastAt = before.lastAt
  ensure(homeDir)
  const saved = await save(homeDir, meta, { debt })
  return { at, debt: { ...debt, lastAt: before.lastAt }, ...saved }
}

// 巩固完了：账清零、lastAt 推到此刻。旧流水不动——情景本身还在，只是不再讨账。
export async function settle(homeDir, input = {}) {
  const at = Number.isFinite(input.at) ? input.at : now()
  const meta = readMeta(homeDir)
  ensure(homeDir)
  const debt = { unconsolidated: 0, unreflected: 0, lastAt: at }
  const saved = await save(homeDir, meta, { debt })
  return { at, debt, ...saved }
}

// 上次开口的时刻：处境屏的"上次开口"与开口门的间隔都从这一格读。
export function lastSaid(homeDir) {
  const meta = readMeta(homeDir)
  const raw = meta.doc.lastCueAt
  return { at: Number.isFinite(raw) ? raw : null, bad: meta.bad }
}

// 说过话了：推进水位。数字与 { at } 两种写法都收（CLI 传的是算好了的时刻）。
export async function markSaid(homeDir, input = {}) {
  const at = Number.isFinite(input) ? input : input.at
  if (!Number.isFinite(at)) throw new TypeError('markSaid 要给时刻（epoch ms）：时间只解释一次')
  const meta = readMeta(homeDir)
  ensure(homeDir)
  const saved = await save(homeDir, meta, { lastCueAt: at })
  return { at, ...saved }
}

// 状态文件里我们管的那一格。缺文件、缺键都按"还没记过"算；整个文件读不懂才算坏（拒写）。
function readMeta(homeDir) {
  const doc = readJson(metaFile(homeDir))
  if (doc === null) return { doc: {}, bad: false }
  if (doc.__bad === true || !isPlain(doc)) return { doc: {}, bad: true }
  return { doc, bad: false }
}

// 只覆盖自己那几格：其余键（峰迹、parts 冷却、别人的水位）原样带过去。
async function save(homeDir, meta, patch) {
  if (meta.bad) {
    return { saved: false, why: '状态文件读不懂，这一笔没写（不覆盖别人的键）' }
  }
  await writeAtomic(metaFile(homeDir), `${JSON.stringify({ ...meta.doc, ...patch }, null, 2)}\n`)
  return { saved: true, why: '' }
}

function debtOf(doc) {
  const raw = doc && isPlain(doc.debt) ? doc.debt : {}
  return {
    unconsolidated: numOr(raw.unconsolidated, 0),
    unreflected: numOr(raw.unreflected, 0),
    lastAt: Number.isFinite(raw.lastAt) ? raw.lastAt : null,
  }
}

// 门槛都从配置拿（§15：用户偏好可配），缺键才退回 core 的 §10 常数——默认值只有一个出处。
function limitsOf(cfg) {
  const digest = cfg && isPlain(cfg.digest) ? cfg.digest : {}
  const impSum = numOr(digest.dueImp, DEBT_SUM_IMP)
  const unreflected = numOr(digest.dueUnreflected, DEBT_UNREFLECTED)
  const staleHours = numOr(digest.dueStaleHours, Math.round(DEBT_STALE / HOUR))
  return { impSum, unreflected, staleHours, stale: staleHours * HOUR }
}

// 线索聚团（design §2 / §7 的 clusters）：同一个线索在 CLUSTER_DAYS 天里出现
// CLUSTER_HITS 次以上才算，滑动窗口取最密的那一段，带上是哪几条情景。
function clustersOf(items) {
  const byCue = new Map()
  for (const rec of items) {
    const cues = new Set()
    for (const raw of Array.isArray(rec.cues) ? rec.cues : []) {
      const cue = typeof raw === 'string' ? raw.trim() : ''
      if (cue !== '') cues.add(cue)
    }
    // 同一条情景里重复的线索只算一次：聚团数的是"几件事提到它"，不是几个字。
    for (const cue of cues) {
      const slot = byCue.get(cue) ?? []
      slot.push({ id: typeof rec.id === 'string' ? rec.id : '', at: atOf(rec) })
      byCue.set(cue, slot)
    }
  }
  const span = CLUSTER_DAYS * DAY
  const out = []
  for (const [cue, list] of byCue) {
    if (list.length < CLUSTER_HITS) continue
    list.sort((a, b) => a.at - b.at)
    let best = 0
    let head = 0
    let tail = 0
    // 双指针滑窗：窗口宽度是 CLUSTER_DAYS，取窗口里落得最多的那一段。
    for (let i = 0, j = 0; i < list.length; i += 1) {
      while (j < list.length && list[j].at - list[i].at <= span) j += 1
      if (j - i > best) {
        best = j - i
        head = i
        tail = j - 1
      }
    }
    if (best < CLUSTER_HITS) continue
    const picked = list.slice(head, tail + 1)
    out.push({
      cue,
      hits: picked.length,
      ids: picked.map((one) => one.id),
      from: picked[0].at,
      to: picked[picked.length - 1].at,
    })
  }
  // 先按"提得最多次"排；同次数按线索名，只为让同一份数据每次给同一个次序。
  out.sort((a, b) => b.hits - a.hits || (a.cue < b.cue ? -1 : a.cue > b.cue ? 1 : 0))
  return out
}

function atOf(rec) {
  return Number.isFinite(rec.at) ? rec.at : 0
}

function numOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function hoursOf(ms) {
  return Math.round(ms / HOUR)
}

function isPlain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
