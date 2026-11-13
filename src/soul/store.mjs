// 灵魂的目录与当前指针（design §13）：一个灵魂一个目录，`use` 只换 state/soul.current 一个文件。
// 这一层只碰 soul/ 与 state/ —— memory.jsonl、events/、self.md、affect 日志一个字节都不动，
// "记忆共用、人设不共用"就是靠这条边界撑住的（换卡前后 hash 比对用例锁着）。
import fs from 'node:fs'
import path from 'node:path'

import { now as coreNow } from '../core/index.mjs'
import { ensure, readJson, writeAtomic } from '../store/index.mjs'

// 名字上限不是 §10 的常数（那张表里没有这一条），是路径安全与"ls 一行读得下"的下限。
const NAME_MAX = 32
// 指针文件名照 design §13 原样：不带后缀，它只说一件事——现在是谁。
const POINTER = 'soul.current'

// 没设指针时的答案：卡不是必需品，没有卡就报这个名字，注入自然是空的。
// 一个"默认灵魂"目录并不存在，谁也别去建它——空着比编一张假卡诚实。
function builtin() {
  return { name: 'default', at: null, by: 'builtin' }
}

// 灵魂目录的绝对路径。名字校验放在这里：凡是拿到路径的地方，都已经校验过名字了。
export function dir(home, name) {
  const homeDir = homeOf(home)
  return path.join(homeDir, 'soul', nameOf(name))
}

// 按名字码位序（不是 localeCompare）：同一份目录换台机器、换个 locale，次序必须一样。
// size 是目录里所有文件的字节数，给 `soul ls` 报个大小；读不动就记 0，不让一份坏目录卡住整列。
export function list(home) {
  const root = path.join(homeOf(home), 'soul')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    // 一张卡都没有是正常状态（第一次 import 才建目录）；读不动才是故障，浮上去。
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const abs = path.join(root, entry.name)
    items.push({ name: entry.name, path: abs, size: sizeOf(abs) })
  }
  items.sort((a, b) => byCodePoint(a.name, b.name))
  return items
}

// 当前是谁。指针读不懂（手改坏了）时退回 builtin —— 不装作有卡，也不在这里抛：
// 调用方拿到 builtin 就知道"没有卡"，读卡的时候自然会撞上"没有这个灵魂"。
export function current(home) {
  const homeDir = homeOf(home)
  const rec = readJson(path.join(homeDir, 'state', POINTER))
  if (!isPlain(rec) || rec.__bad === true) return builtin()
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  if (name === '') return builtin()
  return {
    name,
    at: Number.isFinite(rec.at) ? rec.at : null,
    by: typeof rec.by === 'string' && rec.by.trim() !== '' ? rec.by.trim() : 'unknown',
  }
}

// 切换：只写一个指针，原子写（tmp → fsync → rename），读者永远看不到半个文件。
// 名字不存在就报错——悄悄换成默认会让"我以为换成了 X"一直错下去。
export async function use(home, name, opts = {}) {
  const homeDir = homeOf(home)
  const wanted = nameOf(name)
  const abs = path.join(homeDir, 'soul', wanted)
  if (!isDir(abs)) throw new Error(`没有这个灵魂：${wanted}（soul ls 看现在有哪些）`)
  const rec = { name: wanted, at: atOf(opts), by: byOf(opts) }
  // ensure 只补 state/ 与 schema.json 这层"写了才初始化"的骨架；
  // 记忆、事件、自我块、情绪日志都不在它管的范围里（design §13 切换语义）。
  ensure(homeDir)
  await writeAtomic(path.join(homeDir, 'state', POINTER), `${JSON.stringify(rec)}\n`)
  return rec
}

// 数据目录只有一个来源：调用方从 AGENT_MAN_HOME 解出来的绝对路径（design §3）。
// 空字符串当没给——Windows 上 `set X=` 会留下空值，不能让它变成当前目录。
function homeOf(home) {
  const text = typeof home === 'string' ? home.trim() : ''
  if (text === '') {
    throw new Error('soul 需要一个数据目录：home 为空（该由调用方从 AGENT_MAN_HOME 解析）')
  }
  return text
}

// 名字同时是目录名，所以四条都得挡：空、带斜杠、`.`/`..`、太长。
// 一律 TypeError：给错了类型是调用方的 bug，不是数据的问题（数据的问题归 check）。
function nameOf(name) {
  if (typeof name !== 'string') throw new TypeError(`灵魂名字必须是字符串：拿到的是 ${show(name)}`)
  const text = name.trim()
  if (text === '') throw new TypeError(`灵魂名字不能为空：拿到的是 ${show(name)}`)
  if (/[/\\]/.test(text)) throw new TypeError(`灵魂名字里不能有斜杠：${text}（它同时是目录名）`)
  if (text === '.' || text === '..') throw new TypeError(`灵魂名字不能是 ${text}：那是目录本身的写法`)
  const size = Array.from(text).length
  if (size > NAME_MAX) {
    throw new TypeError(`灵魂名字最多 ${NAME_MAX} 个字符：${text} 有 ${size} 个`)
  }
  return text
}

function atOf(opts) {
  const at = opts && opts.at
  if (Number.isFinite(at)) return at
  if (at === undefined || at === null) return coreNow()
  throw new Error(`at 必须是 epoch ms 数字，拿到的是 ${show(at)}：时间只在入口解释一次（AGENTS 二·3）`)
}

// by 记的是"谁切的"（cli / dsh / 插件名），只给人看，不参与判断。
function byOf(opts) {
  const by = opts && opts.by
  return typeof by === 'string' && by.trim() !== '' ? by.trim() : 'cli'
}

function sizeOf(abs) {
  let entries = []
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return 0 // 刚被删掉的目录：这条卡本来就要消失，不该让 ls 整份失败
  }
  let total = 0
  for (const entry of entries) {
    const full = path.join(abs, entry.name)
    if (entry.isDirectory()) {
      total += sizeOf(full)
      continue
    }
    try {
      total += fs.statSync(full).size
    } catch {
      continue // 读目录与 stat 之间被删掉的文件：算 0，理由同上
    }
  }
  return total
}

// 码位序：'阿'(0x963F) 要排在 'z'(0x7A) 后面。JS 的 < 比的是 UTF-16 码元，
// 代理对（emoji 名字）会排反，所以逐码点比。
function byCodePoint(a, b) {
  const x = Array.from(a)
  const y = Array.from(b)
  const len = Math.min(x.length, y.length)
  for (let i = 0; i < len; i += 1) {
    const diff = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (diff !== 0) return diff
  }
  return x.length - y.length
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

function show(value) {
  if (typeof value === 'string') return `'${value}'`
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return Object.prototype.toString.call(value)
}
