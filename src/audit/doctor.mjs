// audit doctor（design §6）：只读自检——把"这份数据还能不能用"的坏消息逐条说出来。
// 动手修是禁忌：这里没有 mkdir、没有写探针、没有 rename、没有一行自动修复
// （AGENTS 二·2：不静默；医生只报病情，改法由 CLI 打印给人看）。
import fs from 'node:fs'
import path from 'node:path'

import { RULE_LIMIT, SELF_MAX } from '../core/index.mjs'
import * as memory from '../memory/index.mjs'
import { VERSION, checkHome, readJson } from '../store/index.mjs'

// 分片只有一个层级（design §3：不许加目录层级）：events/<天>.jsonl 与 state/*.jsonl，
// 外加两个单独的 memory.jsonl / rules.jsonl。id 抢号落在 state/ids/ 且不带 .jsonl 后缀。
const JSONL_DIRS = ['events', 'state']
const JSONL_FILES = ['memory.jsonl', 'rules.jsonl']

export function doctor({ home, ctx } = {}) {
  const dir = dataHome(home, ctx)
  // 每个分片只读完一次，坏行清单与后面的各项检查共用（doctor 不许因为"多查一项"就多读一遍）。
  const files = jsonlFiles(dir)
  const scanned = files.map((file) => ({ file, ...scan(file) }))
  const checks = [
    guard('数据目录', () => checkDir(dir)),
    guard('schema 版本', () => checkSchema(dir)),
    guard('分片坏行', () => checkBadLines(dir, scanned)),
    guard('memory 收口副本', () => checkClosure(dir, scanned)),
    guard('meta.json 冷却记录', () => checkParts(dir)),
    guard('self.md 预算', () => checkSelf(dir)),
    guard('rules 活条数', () => checkRules(dir, scanned)),
  ]
  return { ok: checks.every((one) => one.ok), checks }
}

// 一项检查崩了也还是一条检查结果：把异常吞成"没问题"才是灾难（那会让人以为数据是好的），
// 所以异常一律报成不合格，正文里带上原话。
function guard(name, body) {
  try {
    const { ok, detail } = body()
    return { name, ok, detail }
  } catch (e) {
    return { name, ok: false, detail: `检查时读不动：${messageOf(e)}` }
  }
}

function checkDir(dir) {
  let stat = null
  try {
    stat = fs.statSync(dir)
  } catch {
    stat = null
  }
  if (stat === null) return { ok: false, detail: `数据目录不存在：${dir}（第一次写命令才会建）` }
  if (!stat.isDirectory()) return { ok: false, detail: `不是目录：${dir}` }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch (e) {
    return { ok: false, detail: `存在但不可写：${dir}（${messageOf(e)}）` }
  }
  // 这一条只回答"ACL 上让不让写"：Windows 上 access(W_OK) 不看只读属性，也不看磁盘满不满。
  // 真写一次探针就等于改了数据目录里的东西（doctor 是读命令），所以到此为止——
  // 第一次真写入由 appendJsonl 自己读回验证（design §3），比探针可信。
  return { ok: true, detail: `${dir} 存在且可写` }
}

function checkSchema(dir) {
  const state = checkHome(dir)
  if (state.ok) return { ok: true, detail: `v${state.version}（本程序要 v${VERSION}）` }
  return { ok: false, detail: state.why }
}

function jsonlFiles(dir) {
  const files = []
  for (const sub of JSONL_DIRS) {
    const at = path.join(dir, sub)
    let names = []
    try {
      names = fs.readdirSync(at)
    } catch (e) {
      if (e && e.code === 'ENOENT') continue
      throw e
    }
    for (const name of names.slice().sort()) {
      if (name.endsWith('.jsonl')) files.push(path.join(at, name))
    }
  }
  for (const name of JSONL_FILES) files.push(path.join(dir, name))
  return files
}

// 逐行读一个分片。这里用 fs 直读而不是 store 的 readJsonl：坏行清单要的是"哪个文件第几行"，
// readJsonl 只回一个计数；而且这一路只读、不写，不违反"读命令不写盘"。
function scan(file) {
  const rows = []
  const bad = []
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rows, bad } // 没写过不是坏
    throw e
  }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]
    if (text.trim() === '') continue
    let rec = null
    try {
      rec = JSON.parse(text)
    } catch {
      bad.push({ line: i + 1, why: '不是合法 JSON', text: clip(text) })
      continue
    }
    // 合法 JSON 但不是对象（一行 null 或 3）同样读不出记录：算坏行，别让它变成 undefined.id。
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      bad.push({ line: i + 1, why: '不是一条记录', text: clip(text) })
      continue
    }
    rows.push(rec)
  }
  return { rows, bad }
}

function checkBadLines(dir, scanned) {
  const all = []
  for (const one of scanned) {
    for (const item of one.bad) all.push({ file: relOf(dir, one.file), ...item })
  }
  if (all.length === 0) return { ok: true, detail: `共 ${scanned.length} 个文件逐行可解析` }
  const shown = all.slice(0, 5).map((one) => `${one.file}:${one.line}：${one.why}（${one.text}）`)
  const rest = all.length - shown.length
  return { ok: false, detail: `坏行 ${all.length} 处：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 处` : ''}` }
}

// 同一个 id 写出两行、且 at 一样时，"谁赢"取决于哪一行后写——那就不是收口，是掷骰子。
// 这里只判定"at 最大那行唯一不唯一"，取哪一条仍是 memory 的事（design §4）。
function checkClosure(dir, scanned) {
  const file = scanned.find((one) => one.file === path.join(dir, 'memory.jsonl'))
  const rows = file === undefined ? [] : file.rows
  const top = new Map() // id -> { at, count }
  let partial = 0
  for (const rec of rows) {
    if (typeof rec.id !== 'string' || rec.id.trim() === '' || !Number.isFinite(rec.at)) {
      partial += 1
      continue
    }
    const seen = top.get(rec.id)
    if (seen === undefined) top.set(rec.id, { at: rec.at, rows: [rec] })
    else if (rec.at > seen.at) top.set(rec.id, { at: rec.at, rows: [rec] })
    else if (rec.at === seen.at) seen.rows.push(rec)
  }
  // 同 id 同 at 的多行有两种：一种合法，是 seen 的 +1 副本（只动 seen，按文件顺序严格递增，
  // 读方"同 at 后写赢"取到的就是最后一版）；一种真冲突，内容不一致，谁赢都说不清。
  const clash = [...top].filter(([, one]) => one.rows.length > 1 && !isSeenBump(one.rows))
  if (clash.length > 0) {
    const shown = clash.map(([id, one]) => `${id} 有 ${one.rows.length} 行 at=${one.at}`)
    return { ok: false, detail: `收口副本冲突：${shown.join('；')}（读方按 at 最大取，同 at 时后写赢）` }
  }
  const bumped = [...top].filter(([, one]) => one.rows.length > 1).length
  if (top.size === 0) {
    return { ok: true, detail: partial > 0 ? `没有可读的记忆行（${partial} 行缺 id 或 at）` : '还没写过 memory.jsonl' }
  }
  const rest = partial > 0 ? `；${partial} 行缺 id 或 at 未参与检查` : ''
  const copies = bumped > 0 ? `（其中 ${bumped} 条的 at 最大行是同 at 的 seen 副本）` : ''
  return { ok: true, detail: `${top.size} 条 id 的 at 最大行唯一${copies}${rest}` }
}

// seen 副本的形状：除 seen 外逐字段相同，seen 按文件顺序严格递增（后写的必须是更大的那个）。
function isSeenBump(rows) {
  const first = rows[0]
  let prev = first.seen
  if (!Number.isFinite(prev)) prev = 0
  for (let i = 1; i < rows.length; i += 1) {
    const one = rows[i]
    for (const key of Object.keys(first)) {
      if (key === 'seen') continue
      if (JSON.stringify(one[key]) !== JSON.stringify(first[key])) return false
    }
    if (Object.keys(one).length !== Object.keys(first).length) return false
    const seen = Number.isFinite(one.seen) ? one.seen : 0
    if (!(seen > prev)) return false
    prev = seen
  }
  return true
}

// 冷却记录的形状（design §4）：{ 插件名: { fail: 非负整数, until: 有限数字或 null } }。
// until 缺失也报红：design 写的是显式 null，"没有这个键"到底是没冷却还是没写过，读不清。
function checkParts(dir) {
  const doc = readJson(path.join(dir, 'state', 'meta.json'))
  if (doc === null) return { ok: true, detail: '还没有 meta.json（从未写过），没有冷却记录' }
  if (doc.__bad === true) return { ok: false, detail: 'meta.json 不是合法 JSON：水位与冷却记录都读不出' }
  if (doc.parts === undefined) return { ok: true, detail: '没有 parts 记录（没有插件失败过）' }
  const parts = doc.parts
  if (parts === null || typeof parts !== 'object' || Array.isArray(parts)) {
    return { ok: false, detail: 'parts 必须是 { 插件名: { fail, until } } 形状的对象' }
  }
  const names = Object.keys(parts)
  const wrong = []
  for (const name of names) {
    const one = parts[name]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      wrong.push(`parts.${name} 不是对象`)
      continue
    }
    if (!Number.isInteger(one.fail) || one.fail < 0) {
      wrong.push(`parts.${name}.fail 必须是非负整数（拿到 ${show(one.fail)}）`)
    }
    if (one.until !== null && !Number.isFinite(one.until)) {
      wrong.push(`parts.${name}.until 只能是 null 或有限数字（拿到 ${show(one.until)}）`)
    }
  }
  if (wrong.length > 0) return { ok: false, detail: `冷却记录形状不对：${wrong.join('；')}` }
  return { ok: true, detail: `${names.length} 个插件冷却记录形状正确` }
}

function checkSelf(dir) {
  // 走 memory 门面的读：文件叫什么、预算怎么算，只有那一处说了算（doctor 仍然只读）。
  const read = memory.readSelf(dir)
  if (read.updatedAt === null) return { ok: true, detail: '还没写过 self.md' }
  const used = read.cost
  if (used > SELF_MAX) {
    return { ok: false, detail: `self.md 是 ${used.toFixed(1)} cost，超过上限 ${SELF_MAX}：删掉过时的段落（doctor 只报不改）` }
  }
  return { ok: true, detail: `${used.toFixed(1)} / ${SELF_MAX} cost` }
}

// 活规矩 = 出现过的 id 去掉被任何一条 supersedes 收口掉的（design §4：规矩更新写新条 + supersedes）。
// 超了只报红，一条都不删——删规矩是记忆的语义决定，不是自检该做的事。
function checkRules(dir, scanned) {
  const file = scanned.find((one) => one.file === path.join(dir, 'rules.jsonl'))
  const rows = file === undefined ? [] : file.rows
  const latest = new Map() // id -> at
  const replaced = new Set()
  for (const rec of rows) {
    if (typeof rec.id !== 'string' || rec.id.trim() === '' || !Number.isFinite(rec.at)) continue
    if (Array.isArray(rec.supersedes)) {
      for (const id of rec.supersedes) if (typeof id === 'string') replaced.add(id)
    }
    const seen = latest.get(rec.id)
    if (seen === undefined || rec.at >= seen) latest.set(rec.id, rec.at)
  }
  const live = [...latest.keys()].filter((id) => !replaced.has(id))
  if (live.length > RULE_LIMIT) {
    return {
      ok: false,
      detail: `活规矩 ${live.length} 条，超过 ${RULE_LIMIT}：写新条并 supersedes 旧条（doctor 不替你删任何一条）`,
    }
  }
  return { ok: true, detail: `${live.length} / ${RULE_LIMIT} 条活规矩` }
}

function relOf(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

function clip(text) {
  const one = text.trim()
  return one.length > 60 ? `${one.slice(0, 60)}…` : one
}

function show(value) {
  if (typeof value === 'string') return `「${value}」`
  if (value === undefined) return 'undefined'
  return String(value)
}

function messageOf(e) {
  if (e && typeof e.message === 'string') return e.message
  return String(e)
}

// home 是正的入口；ctx.home 兜底（CLI 手里常常只有一个 ctx），两者都没有就直接拒绝，
// 别让 doctor 去读进程的当前目录——那会让"自检通过"变成一场误会。
function dataHome(home, ctx) {
  const given = typeof home === 'string' ? home.trim() : ''
  const fallback = ctx && typeof ctx.home === 'string' ? ctx.home.trim() : ''
  const dir = given !== '' ? given : fallback
  if (dir === '') throw new Error('doctor 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  return dir
}
