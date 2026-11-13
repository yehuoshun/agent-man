// 卡：解析、校验、导入（design §13）。
// 这一层守四条：
// 1. 上限是注入槽位，不是文件上限——超槽位只警告，不拒绝（蒸馏时别自我审查）；
// 2. `<!-- inferred -->` 是 HTML 注释：读数时就剥掉，所以 cost() 永远量不到它（§13.1）；
// 3. `card.json` 只存档、不注入——creator_notes / tags / creator / character_version
//    是给人看的，进 prompt 就是噪声；
// 4. "能不能用"只看两件硬事：四栏齐全、对话至少两组且每组有来有回。别的都算警告。
import fs from 'node:fs'
import path from 'node:path'

import { SOUL_DIALOGUE_MAX, SOUL_IDENTITY_MAX, SOUL_SOUL_MAX, cost } from '../core/index.mjs'
import { appendJsonl, readJson, readJsonl, writeAtomic } from '../store/index.mjs'
import { dir } from './store.mjs'

const CARD = 'card.json'
const LORE = 'lore.jsonl'

// 四栏（design §13）：缺哪一栏都要在 check 里点名，并且一栏不许拿另一栏顶。
const COLUMNS = [
  { key: 'name', file: 'name.md' },
  { key: 'identity', file: 'identity.md' },
  { key: 'soul', file: 'soul.md' },
  { key: 'dialogue', file: 'dialogue.md' },
]

// 三个旋钮各 −2..+2（design §13）。这条不是 §10 的常数，是卡本身的定义，写在这儿。
const KNOBS = ['warm', 'drive', 'sharp']
const KNOB_MIN = -2
const KNOB_MAX = 2

// 注入槽位只管注入时取多少（docs/soul-card.md §3）：这里只拿来判警告。
const SLOTS = [
  { file: 'identity.md', key: 'identity', cap: SOUL_IDENTITY_MAX },
  { file: 'soul.md', key: 'soul', cap: SOUL_SOUL_MAX },
  { file: 'dialogue.md', key: 'dialogue', cap: SOUL_DIALOGUE_MAX },
]

const MARK = /<!--\s*inferred\s*-->/i
const MARK_ALL = /<!--\s*inferred\s*-->/gi
const START = /^<START>\s*$/i
const ROLE = /^(你|我|\{\{\s*user\s*\}\}|\{\{\s*char\s*\}\}|user|char)\s*[:：]\s*(.*)$/i

// 推断出来的段落以 `<!-- inferred -->` 结尾（design §13.1）。它是注释：注入时整行剥掉、不占预算。
// 所以剥在这儿——cost() 量到的是"剥完之后"的字，标记本身一个 cost 都不算。
export function stripMarks(text) {
  const src = typeof text === 'string' ? text : ''
  const inferred = []
  const lines = []
  for (const line of src.split('\n')) {
    if (!MARK.test(line)) {
      lines.push(line)
      continue
    }
    const clean = line.replace(MARK_ALL, '').replace(/\s+$/, '')
    if (clean.trim() !== '') inferred.push(clean.trim())
    lines.push(clean)
  }
  return { text: lines.join('\n'), inferred }
}

// 对话按 `<START>` 切组。角色前缀认这几种写法：你 / 我、{{user}} / {{char}}、user / char。
// 没前缀的行算旁白（"可带极简动作描写"）——留着，但不算"有来有回"。
export function groups(text) {
  const src = typeof text === 'string' ? text : ''
  const out = []
  let current = null
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (START.test(line)) {
      current = { index: out.length + 1, turns: [] }
      out.push(current)
      continue
    }
    // 第一个 <START> 之前的字不属于任何一组：它不是示范对话，注不进去也不该算进组数。
    if (current === null) continue
    current.turns.push(turnOf(line))
  }
  return out
}

// 一张卡的完整读数：check 与 inject 都走这里，免得"校验看的是 A、注入看的是 B"。
export function load(home, name) {
  const abs = dir(home, name)
  if (!isDir(abs)) throw new Error(`没有这个灵魂：${path.basename(abs)}（soul ls 看现在有哪些）`)
  const cardRead = readJson(path.join(abs, CARD))
  const cardBroken = cardRead !== null && (!isPlain(cardRead) || cardRead.__bad === true)
  const raw = isPlain(cardRead) && cardRead.__bad !== true ? cardRead : {}

  const cols = {}
  for (const col of COLUMNS) cols[col.key] = columnOf(readText(path.join(abs, col.file)))
  const lore = readLore(abs)

  const inferred = []
  for (const col of COLUMNS) {
    for (const mark of cols[col.key].inferred) {
      inferred.push({ field: `${col.key}.${mark.section}`, section: mark.section, text: mark.text })
    }
  }

  return {
    dir: abs,
    name: nameOfCard(raw, path.basename(abs)),
    cols,
    nameText: cols.name.text,
    identity: cols.identity.text,
    soul: cols.soul.text,
    dialogue: cols.dialogue.text,
    lore: lore.items,
    loreBad: lore.bad,
    knobs: knobsOf(raw),
    knobsRaw: isPlain(raw.knobs) ? raw.knobs : null,
    provenance: provenanceOf(raw, cols),
    source: sourceOf(raw),
    inferred,
    cardBroken,
    raw,
  }
}

// 对外只给形状（design §7 的 soul/card）：每一栏都是剥掉标记之后的正文，knobs 已归一。
export function read(home, name) {
  const card = load(home, name)
  return {
    name: card.name,
    identity: card.identity,
    soul: card.soul,
    dialogue: card.dialogue,
    lore: card.lore,
    knobs: card.knobs,
    provenance: card.provenance,
    source: card.source,
  }
}

// check 的契约是"报告"，不是"崩给你看"，所以一律不抛：读不到卡也只是一条 error。
export function check(home, name) {
  let card
  try {
    card = load(home, name)
  } catch (e) {
    return { ok: false, errors: [messageOf(e)], warnings: [], inferred: [] }
  }

  const errors = []
  const warnings = []

  // 一、四栏齐全
  for (const col of COLUMNS) {
    if (card.cols[col.key].paragraphs.length > 0) continue
    errors.push(`缺 ${col.file}：四栏（name / identity / soul / dialogue）缺一栏，这张卡就不成立`)
  }

  // 二、对话至少两组，且每组有来有回
  const dialogueGroups = groups(card.dialogue)
  if (card.cols.dialogue.paragraphs.length > 0 && dialogueGroups.length < 2) {
    errors.push(`dialogue.md 只有 ${dialogueGroups.length} 组 <START>：至少要两组`
      + '（一组顺利、一组不高兴，否则这张卡只会一种声音）')
  }
  for (const group of dialogueGroups) {
    if (hasBoth(group)) continue
    errors.push(`dialogue.md 第 ${group.index} 组没有来有回：只有一方在说话，示范不成立`)
  }

  // 三、旋钮：三个键都在 −2..+2 的整数里，缺省 0
  if (card.knobsRaw !== null) {
    for (const key of Object.keys(card.knobsRaw)) {
      if (KNOBS.includes(key)) continue
      warnings.push(`! knobs 里有不认识的键：${key}（只认 ${KNOBS.join(' / ')}）`)
    }
    for (const key of KNOBS) {
      const value = card.knobsRaw[key]
      if (value === undefined || value === null) continue
      if (Number.isInteger(value) && value >= KNOB_MIN && value <= KNOB_MAX) continue
      errors.push(`knobs.${key} 必须是 ${KNOB_MIN}..${KNOB_MAX} 的整数，拿到的是 ${show(value)}`)
    }
  }

  // 四、超槽位只警告：上限是注入槽位，不是文件上限（design §13）
  for (const slot of SLOTS) {
    const used = cost(card[slot.key])
    if (used <= slot.cap) continue
    warnings.push(`! ${slot.file} 用了 ${used} cost，超槽位 ${slot.cap}：`
      + '不拒绝（文件可以比槽位长），注入时按段落装到装不下为止')
  }

  // 五、推断要留痕（§13.1）：条目本身进 inferred，由调用方渲染成 "~ N 处推断待确认"；
  // 一条来源都没有时才给强警告——推断不是罪，装作原文才是。
  if (card.cardBroken) warnings.push(`! ${CARD} 读不懂：当成没有 card.json 处理（knobs 全 0、source 为空）`)
  if (card.loreBad > 0) warnings.push(`! ${LORE} 里有 ${card.loreBad} 行读不懂：已跳过，修好之前这几条不在注入里`)
  if (card.source === null) warnings.push('! 整张卡都是推断的，行为可能不像原文')

  return { ok: errors.length === 0, errors, warnings, inferred: card.inferred }
}

// CCv2 的 JSON → 同一个目录形状（design §13"卡从哪来"）。
// 原样的 CC 字段全部进 card.json（给人看、也为了将来能按原文重蒸），
// 四栏只放该进 prompt 的那部分：description → identity、personality → soul、
// mes_example → dialogue、character_book + scenario → lore。
export async function importCard(home, file) {
  const from = typeof file === 'string' ? file.trim() : ''
  if (from === '') throw new TypeError(`importCard 要给一个卡文件：拿到的是 ${show(file)}`)
  const card = JSON.parse(readCardFile(from))
  const cc = ccOf(card)
  const name = textOf(cc.name).trim()
  const abs = dir(home, name) // 名字在这一步校验：带斜杠的卡当场 TypeError
  if (isDir(abs)) throw new Error(`已经有这个灵魂了：${name}（${abs}）；要覆盖就先把它删掉`)

  const identity = textOf(cc.description).trim()
  const soul = [textOf(cc.personality), textOf(cc.system_prompt), textOf(cc.post_history_instructions)]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n')
  const dialogue = normalizeDialogue(textOf(cc.mes_example))
  const lore = loreOf(cc)
  const source = sourceOf(cc) ?? from

  fs.mkdirSync(abs, { recursive: true })
  const files = [
    ['name.md', `${name}\n`],
    ['identity.md', asFile(identity)],
    ['soul.md', asFile(soul)],
    ['dialogue.md', asFile(dialogue)],
  ]
  for (const [fileName, body] of files) await writeAtomic(path.join(abs, fileName), body)
  for (const entry of lore) appendJsonl(path.join(abs, LORE), entry)

  const stored = {
    ...cc,
    knobs: knobsOf(cc),
    source,
    provenance: importedProvenance({ identity, soul, dialogue, knobs: cc.knobs }),
  }
  await writeAtomic(path.join(abs, CARD), `${JSON.stringify(stored, null, 2)}\n`)
  return { name, dir: abs, files: files.map(([fileName]) => fileName), lore: lore.length, source }
}

// 一栏的正文：段落一行一条，末尾留一个换行（POSIX 文本文件的样子，diff 也好看）。
function asFile(text) {
  return text === '' ? '' : `${text}\n`
}

// 一行 = 一段。段落是注入的单位（design §13"按段落顺序装到装不下为止"），
// 所以注释行、空行在这里就被折掉，注入与 cost() 数的是同一份东西。
function columnOf(text) {
  const src = typeof text === 'string' ? text : ''
  const paragraphs = []
  const inferred = []
  for (const raw of src.split('\n')) {
    if (raw.trim() === '') continue
    const marked = MARK.test(raw)
    const body = raw.replace(MARK_ALL, '').trim()
    if (body === '') continue
    paragraphs.push(body)
    // 段落级的锚点只能是序号：卡里没有小标题，序号是唯一稳定的写法（§13.1 的 "soul.被夸" 同理）。
    if (marked) inferred.push({ section: `第 ${paragraphs.length} 段`, text: body })
  }
  return { text: stripMarks(src).text.trim(), paragraphs, inferred }
}

// lore 一条一行（design §4 的形状）：{id, keys[], constant, order, share, text}。
// 读不懂的行跳过并计数——一条坏行不该让整份 lore 读不出来，但也不能装作没发生。
function readLore(abs) {
  const got = readJsonl(path.join(abs, LORE))
  const items = []
  let bad = got.bad
  for (const rec of got.items) {
    const item = loreItem(rec)
    if (item === null) {
      bad += 1
      continue
    }
    items.push(item)
  }
  return { items, bad }
}

function loreItem(rec) {
  const id = textOf(rec.id).trim()
  const text = textOf(rec.text)
  if (id === '' || text.trim() === '') return null
  return {
    id,
    keys: Array.isArray(rec.keys) ? rec.keys.filter((key) => typeof key === 'string') : [],
    constant: rec.constant === true,
    order: Number.isFinite(rec.order) ? rec.order : 0,
    // share 是这条往事在预算里的话语权，原样留着；本轮注入只按 constant 与 order 排。
    share: Number.isFinite(rec.share) ? rec.share : 1,
    text,
  }
}

// 旋钮：缺省 0，越界或非整数也归 0——read() 永远给上层三个能用的数，
// "这个值不合法"由 check 说，不靠 read 返回 NaN 让上游自己发现。
function knobsOf(raw) {
  const src = isPlain(raw.knobs) ? raw.knobs : {}
  const out = {}
  for (const key of KNOBS) out[key] = knobOf(src[key])
  return out
}

function knobOf(value) {
  if (!Number.isInteger(value)) return 0
  if (value < KNOB_MIN || value > KNOB_MAX) return 0
  return value
}

// 三级 provenance（design §13.1）：source / inferred / manual。
// card.json 里写明的说了算；没写的按标记推：整栏都带标记才算 inferred，否则算 source。
function provenanceOf(raw, cols) {
  const given = isPlain(raw.provenance) ? raw.provenance : {}
  const sections = {}
  for (const col of COLUMNS) {
    for (const mark of cols[col.key].inferred) sections[`${col.key}.${mark.section}`] = 'inferred'
  }
  Object.assign(sections, isPlain(given.sections) ? given.sections : {})

  const out = {}
  for (const col of COLUMNS) {
    const column = cols[col.key]
    const whole = column.paragraphs.length > 0 && column.inferred.length === column.paragraphs.length
    out[col.key] = given[col.key] ?? (whole ? 'inferred' : 'source')
  }
  out.knobs = given.knobs ?? (isPlain(raw.knobs) ? 'source' : 'inferred')
  out.sections = sections
  return out
}

// 来源：一串字（URL / 语料名）或一串字组成的数组。一条都没有就是 null——
// check 靠这个 null 说"整张卡都是推断的"。
function sourceOf(raw) {
  const value = raw.source
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (!Array.isArray(value)) return null
  const items = value.filter((one) => typeof one === 'string' && one.trim() !== '')
  return items.length === 0 ? null : items.map((one) => one.trim()).join(' / ')
}

function importedProvenance(parts) {
  const out = {}
  for (const key of ['identity', 'soul', 'dialogue']) {
    if (parts[key] !== '') out[key] = 'source'
  }
  // CCv2 不带旋钮；补的 0 是推的，不是原文（§13.1：推出来的必须标明）。
  out.knobs = isPlain(parts.knobs) ? 'source' : 'inferred'
  out.sections = {}
  return out
}

function nameOfCard(raw, fallback) {
  const name = textOf(raw.name).trim()
  return name === '' ? fallback : name
}

// CCv2 把字段包在 data 里，v1 是平铺的；两个都认，外层 spec 字段留着。
function ccOf(card) {
  if (!isPlain(card)) throw new TypeError(`卡文件不是一个 JSON 对象：拿到的是 ${show(card)}`)
  return isPlain(card.data) ? { ...card, ...card.data } : card
}

// 对话：把 {{char}} / {{user}} 的前缀折成 我 / 你，缺 <START> 就补一个——
// 存下来的 dialogue.md 必须是自家格式，导入之后不该还要求人再手改一遍。
function normalizeDialogue(text) {
  const src = text.trim()
  if (src === '') return ''
  const lines = []
  let started = false
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (START.test(line)) {
      lines.push('<START>')
      started = true
      continue
    }
    lines.push(normalizeTurn(line))
  }
  if (lines.length === 0) return ''
  if (!started) lines.unshift('<START>')
  return lines.join('\n')
}

function normalizeTurn(line) {
  const m = ROLE.exec(line)
  if (!m) return line
  return `${roleOf(m[1]) === 'user' ? '你' : '我'}: ${m[2].trim()}`
}

// 场景与往事：character_book 的 entries 原样搬过来，scenario 单独补一条常驻。
// CC 的 insertion_order 就是这里的 order（降序排），constant 直接对应"每次都在"。
function loreOf(cc) {
  const book = cc.character_book
  const entries = isPlain(book) && Array.isArray(book.entries) ? book.entries : []
  const out = []
  for (const entry of entries) {
    const text = textOf(isPlain(entry) ? entry.content : '').trim()
    if (text === '') continue
    const keys = Array.isArray(entry.keys)
      ? entry.keys.filter((key) => typeof key === 'string' && key.trim() !== '')
      : []
    out.push({
      id: `l-${pad(out.length + 1)}`,
      keys,
      constant: entry.constant === true,
      order: Number.isFinite(entry.insertion_order) ? entry.insertion_order : 0,
      share: 1,
      text,
    })
  }
  const scenario = textOf(cc.scenario).trim()
  if (scenario !== '') {
    // 场景是"这一次在哪儿说话"，永远成立，所以固定成常驻条目（constant）。
    const text = `场景：${scenario}`
    out.push({ id: `l-${pad(out.length + 1)}`, keys: [], constant: true, order: 0, share: 1, text })
  }
  return out
}

function hasBoth(group) {
  if (!group || !Array.isArray(group.turns)) return false
  const roles = new Set(group.turns.map((turn) => turn.role))
  return roles.has('user') && roles.has('char')
}

function turnOf(line) {
  const m = ROLE.exec(line)
  if (!m) return { role: 'note', text: line }
  return { role: roleOf(m[1]), text: m[2].trim() }
}

function roleOf(tag) {
  const key = tag.trim().toLowerCase()
  if (key === '你' || key === 'user' || key === '{{user}}') return 'user'
  return 'char'
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    // 缺栏是 check 该报的事，不是这里该抛的事：缺文件返回空串，读不动才浮上去。
    if (e && e.code === 'ENOENT') return ''
    throw e
  }
}

function readCardFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`没有这个卡文件：${file}`)
    throw e
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function messageOf(e) {
  return e && typeof e.message === 'string' && e.message !== '' ? e.message : String(e)
}

function show(value) {
  if (typeof value === 'string') return `'${value}'`
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return Object.prototype.toString.call(value)
}
