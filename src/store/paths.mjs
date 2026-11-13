import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dayKey, monthKey } from '../core/index.mjs'
import { VERSION } from './schema.mjs'

// 分片只有这五种（design §3）。写成表而不是 if 链，listShards 才有地方判"这个名字不认识"。
const DAY_KINDS = 'events'
const STATE_KINDS = ['notes', 'plans', 'judge', 'trace']
const ALL_KINDS = [DAY_KINDS, ...STATE_KINDS]

// 数据目录只有一个来源：AGENT_MAN_HOME，缺省 ~/.agent-man（design §3）。
// 空字符串当没设——Windows 上 `set X=` 会留下空值，不能让 home 变成当前目录。
export function home(env) {
  const override = env && env.AGENT_MAN_HOME
  if (typeof override === 'string' && override.trim() !== '') return override
  return path.join(os.homedir(), '.agent-man')
}

// 只在会写盘的路径上调（design §3 今天定下的：写入才初始化，doctor 只读）。
// schema.json 用 wx 建：已存在就当初始化过了，绝不覆盖——那里面以后可能要放迁移信息，
// 而且 ensure 会在每次写之前被调用，覆盖写等于每次写都摸一遍元数据。
export function ensure(homeDir) {
  fs.mkdirSync(path.join(homeDir, 'events'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, 'state', 'ids'), { recursive: true })
  const schema = path.join(homeDir, 'schema.json')
  try {
    fs.writeFileSync(schema, `{"version":${VERSION}}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e
  }
  return homeDir
}

// 形参叫 homeDir 不叫 design 表里的 home：同目录还有个 home()，遮住它迟早写错。
// 日界怎么算只让 core/time 回答：这里再写一遍 setHours(4)，两处口径迟早分叉。
export function eventsFile(homeDir, ts, { dayStart = 0 } = {}) {
  return path.join(homeDir, 'events', `${dayKey(ts, { dayStart })}.jsonl`)
}

export function stateFile(homeDir, kind, ts) {
  return path.join(homeDir, 'state', `${kind}-${monthKey(ts)}.jsonl`)
}

// 返回按时间升序的分片绝对路径。这里只做"粗筛"：按分片自然边界与 [from, to] 求交，
// 一行内容都不读——精确到毫秒的过滤是 recall 的事，两侧都做一遍才叫省事，不是越权。
export function listShards(homeDir, kind, { from, to } = {}) {
  if (!ALL_KINDS.includes(kind)) {
    throw new Error(`未知的分片类型：${String(kind)}（只认 ${ALL_KINDS.join(' / ')}）`)
  }
  const dir = kind === DAY_KINDS ? path.join(homeDir, 'events') : path.join(homeDir, 'state')
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
    const span = shardSpan(kind, name)
    if (!span) continue
    if (Number.isFinite(from) && span.end <= from) continue
    if (Number.isFinite(to) && span.start > to) continue
    found.push(span)
  }
  // 只认数字差：字符串比较在跨年时会说 2027-01 排在 2026-12 前面（AGENTS 五）。
  found.sort((a, b) => a.start - b.start)
  return found.map((s) => path.join(dir, s.name))
}

// 文件名 → 覆盖的半个开区间 [start, end)。本地构造零点，和 dayKey/monthKey 同一口径。
function shardSpan(kind, name) {
  if (kind === DAY_KINDS) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2]) - 1
    const d = Number(m[3])
    return { name, start: new Date(y, mo, d).getTime(), end: new Date(y, mo, d + 1).getTime() }
  }
  const m = new RegExp(`^${kind}-(\\d{4})-(\\d{2})\\.jsonl$`).exec(name)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  return { name, start: new Date(y, mo, 1).getTime(), end: new Date(y, mo + 1, 1).getTime() }
}
