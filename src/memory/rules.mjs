import path from 'node:path'

import { RULE_LIMIT, RULE_MAX, cost } from '../core/index.mjs'
import { appendJsonl, claim, ensure, readJsonl, validate } from '../store/index.mjs'

import { nowOf, requireHome, timeOf } from './shape.mjs'

// 规矩（design §4）：{id, at, text, why, supersedes[], seen}。
// 不分片——要说清"这条还作不作数"，得把全量 supersedes 读齐；按日分片就没法回答这个问题。
// 旧条永不改写：被替代时只在**新条**里记 supersedes，旧行逐字不动。
// 所以这里没有 memory 那样的版本链（同 id 多行），一个 id 一辈子只有一行。

export function rulesFile(home) {
  return path.join(home, 'rules.jsonl')
}

// 一条规矩只有这六个字段。少一个的旧行按坏行跳过并计数（AGENTS 五），
// 不拿空串或者 0 替它猜一个值——"没有理由的规矩"正是这份数据不该出现的东西。
const FIELDS = ['id', 'at', 'text', 'why', 'supersedes', 'seen']

// store 只验 id/at/text 那三样（它认的是"五类记录"的公共形状）；
// why、supersedes、seen 是规矩独有的，由这一层补上。
export function inspectRule(rec) {
  const errors = validate('rules', rec).errors.slice()
  for (const field of FIELDS) {
    if (!(field in rec)) errors.push(`缺 ${field}：读不出完整的一条规矩`)
  }
  if (typeof rec.why !== 'string' || rec.why.trim() === '') {
    errors.push('why 必须是非空字符串：没有理由的规矩不许立')
  }
  if (!Array.isArray(rec.supersedes) || !rec.supersedes.every(isId)) {
    errors.push('supersedes 必须是 id 数组（没有取代谁就给空数组）')
  }
  if (!Number.isInteger(rec.seen) || rec.seen < 0) errors.push('seen 必须是非负整数')
  return errors
}

export function assertRule(rec) {
  const errors = inspectRule(rec)
  if (errors.length > 0) {
    throw new Error(`规矩不合法：${errors.join('；')}（不猜、不补，先改输入）`)
  }
  return rec
}

// 读全量：坏行跳过计数，不因为一行坏掉让所有规矩消失。
// 同一 id 出现多行只可能来自"绕过门面重复追加"，取后写的（追加序即时间序）。
export function readRules(home) {
  const dir = requireHome({ home })
  const { items, bad } = readJsonl(rulesFile(dir))
  let skipped = bad
  const latest = new Map()
  for (const rec of items) {
    if (inspectRule(rec).length > 0) {
      skipped += 1
      continue
    }
    latest.set(rec.id, rec)
  }
  return { home: dir, records: [...latest.values()], skipped }
}

// 活条 = 自己的 id 没被任何有效条点名取代。
// 注意不是"只看活条里的 supersedes"：那会让一条已废条目的 supersedes 失效、
// 被它取代的旧规矩原地复活。判"死"这件事只用一次，不递归。
export function replacedIds(records) {
  const dead = new Set()
  for (const rec of records) {
    for (const id of rec.supersedes) dead.add(id)
  }
  return dead
}

// 写一条规矩。
// text：规矩本身；why：立它的理由——两样都必填，没有理由的规矩不许立（design §4）。
// supersedes：这次要替代掉的旧条 id。显式点名，不按"内容像不像"自动取代。
// 活条上限 RULE_LIMIT 是**写入口**的事：超了就拒绝并让人先点名要替代谁，
// 而不是写进去再靠读的时候报"太多了"——规矩不是能让人慢慢挑的东西。
export async function addRule(home, opts = {}) {
  const dir = requireHome({ home })
  const input = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}
  const base = nowOf({ now: input.now })
  const text = checkText(input.text)
  const why = checkWhy(input.why)
  const wanted = checkSupersedes(input.supersedes)
  const at = timeOf(input.at, base, 'at') ?? base

  const { records, skipped } = readRules(dir)
  const dead = replacedIds(records)
  const live = records.filter((rec) => !dead.has(rec.id))

  for (const id of wanted) {
    if (live.some((rec) => rec.id === id)) continue
    const gone = records.find((rec) => rec.id === id)
    if (gone === undefined) {
      throw new Error(`supersedes 里的 ${id} 不存在：先 memory rules 看 id，再点名要替代的那条`)
    }
    throw new Error(`supersedes 里的 ${id} 已被取代，不能再点一次：规矩只记一次取代，旧账不必再翻`)
  }

  const liveAfter = live.length - wanted.length + 1
  if (liveAfter > RULE_LIMIT) {
    throw new Error(
      `同时生效的规矩上限是 ${RULE_LIMIT} 条，这条写下去是 ${liveAfter} 条：`
        + '先在新条的 supersedes 里点名要替代的旧条，别把上限当建议',
    )
  }

  ensure(dir)
  const id = await claim(dir, 'r', at)
  const record = assertRule({ id, at, text, why, supersedes: wanted, seen: 0 })
  // 写入还是那条唯一的路（open → write → fsync → 读回自己那行）：规矩也不能例外。
  appendJsonl(rulesFile(dir), record)

  return { status: 'added', id, record, superseded: wanted, live: liveAfter, limit: RULE_LIMIT, skipped }
}

// 读规矩。
// 默认只给活条：调用方要回答"现在还该照哪些规矩办事"。
// all: true 给全量（每条带 live 布尔），给的是"查历史"的用法。
// 活条超过 RULE_LIMIT 不删也不报错——数据已经在那儿了，删规矩是人的决定；
// 超出多少写在 over 里，由调用方报 "! "（AGENTS 二·2 不静默）。
// now 不参与任何计算：规矩的保留率恒为 1（S0_RULE = Infinity，design §10），
// 时间再久也不衰减、不过期。留着这个参数只为与其它读命令同形。
export function listRules(home, opts = {}) {
  const dir = requireHome({ home })
  const options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}
  const { records, skipped } = readRules(dir)
  const dead = replacedIds(records)
  const live = records.filter((rec) => !dead.has(rec.id))
  const picked = options.all === true ? records : live
  // 按 at 倒序：新的规矩排在前面。只认数字差，不比字符串（AGENTS 五）。
  const items = picked.map((rec) => ({ ...rec, live: !dead.has(rec.id) }))
  items.sort((a, b) => b.at - a.at)
  return {
    items,
    live: live.length,
    total: records.length,
    over: live.length > RULE_LIMIT ? live.length - RULE_LIMIT : 0,
    limit: RULE_LIMIT,
    skipped,
  }
}

// 复述记账（design §5）：规矩被摘要选进「规矩」那一刻 seen +1，别处一律不写。
// 一个 id 只有一行"当前态"，所以 +1 只能是**追加一条完整副本**（同 at，只动 seen）：
// 读方按 id 取后写的那行，旧行一个字节不动（AGENTS 五）。
// at 照抄旧行——规矩不衰减（S0_RULE = Infinity），把 at 往前挪会让"立规矩的时刻"变成"上次复述的时刻"。
export function markRulesSeen(home, opts = {}) {
  const dir = requireHome({ home })
  const options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}
  const at = nowOf({ now: options.at })
  const wanted = Array.isArray(options.ids) ? options.ids : []
  const { records } = readRules(dir)
  const byId = new Map(records.map((rec) => [rec.id, rec]))

  const marked = []
  const skipped = []
  const failed = []
  const once = new Set()
  for (const raw of wanted) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '' || once.has(id)) continue
    once.add(id)
    const rec = byId.get(id)
    if (rec === undefined) {
      skipped.push({ id, why: '这条规矩已经找不到了：不 +1，也不替它补一条记录' })
      continue
    }
    // 字段逐个抄而不是展开：规矩的六个字段是白名单，多一个少一个都会被读成坏行。
    const copy = {
      id: rec.id,
      at: rec.at,
      text: rec.text,
      why: rec.why,
      supersedes: [...rec.supersedes],
      seen: rec.seen + 1,
    }
    try {
      ensure(dir)
      appendJsonl(rulesFile(dir), copy)
      marked.push(id)
    } catch (e) {
      failed.push({ id, why: `seen 没能落盘：${e && e.message ? e.message : String(e)}` })
    }
  }
  return { at, marked, skipped, failed }
}

// 规矩正文的预算是 RULE_MAX cost（design §10）。
function checkText(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('text 必须是非空字符串：一条什么都没说的规矩不该立')
  }
  const text = value.trim()
  const used = cost(text)
  if (used > RULE_MAX) {
    throw new Error(`规矩的预算是 ${RULE_MAX} cost，这条 ${used.toFixed(1)}：拆成两条，或删掉修饰`)
  }
  return text
}

// 理由同样必填。design §10 只给了一条规矩的字数预算，没单列理由的；
// 这里按同一个 RULE_MAX 收着（理由比规矩本身还长的，通常该写进 docs 而不是库里）。
function checkWhy(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('why 必须是非空字符串：没有理由的规矩不许立（被替代时也没人知道该不该留）')
  }
  const why = value.trim()
  const used = cost(why)
  if (used > RULE_MAX) {
    throw new Error(`why 的预算按 RULE_MAX ${RULE_MAX} cost 算，这条 ${used.toFixed(1)}：写下最要紧的那句理由`)
  }
  return why
}

function checkSupersedes(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('supersedes 必须是 id 数组：想替代谁就点名，没想替代谁就给空数组')
  }
  const out = []
  for (const raw of value) {
    if (!isId(raw)) throw new Error('supersedes 里每一项都必须是非空规矩 id')
    const id = raw.trim()
    // 同一个 id 写两遍不是"替代得更彻底"：留一份。
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function isId(value) {
  return typeof value === 'string' && value.trim() !== ''
}
