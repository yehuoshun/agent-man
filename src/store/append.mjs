import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// 写 JSONL 只有这一条路（AGENTS 五）：open → write → fsync → close，然后读回自己那一行。
// 少了 fsync，进程/断电一崩，那一行就只在页缓存里——"写过了"变成一句自我安慰。
export function appendJsonl(file, obj) {
  const line = JSON.stringify(obj)
  if (typeof line !== 'string') {
    throw new Error(`记录序列化失败：JSON.stringify 返回了 ${typeof line}（多半是传了函数或 undefined）`)
  }
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, `${line}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // 只 fsync 不够：盘上说写了、文件里没有的事故真发生过，所以读回来核一遍。
  assertLanded(file, obj, line)
  return obj
}

// 按 id 找自己那一行，而不是只看最后一行：并发追加时最后一行可能是别人的，
// 只核末尾会把"我的没落盘"误判成成功。
export function assertLanded(file, obj, line = JSON.stringify(obj)) {
  const want = typeof line === 'string' ? line : ''
  const id = obj && typeof obj.id === 'string' ? obj.id : ''
  const raw = fs.readFileSync(file, 'utf8')
  for (const text of raw.split('\n')) {
    if (text === want) return true
    if (id === '' || !text.includes(id)) continue
    try {
      const rec = JSON.parse(text)
      if (rec && rec.id === id) return true
    } catch {
      // 坏行不算"我的那行落盘了"：继续找，找不到就会抛。
    }
  }
  const who = id === '' ? want : id
  throw new Error(`写入没有落盘：${file} 里找不到 ${who}`)
}

// 坏行跳过并计数，不抛：一行坏掉不该让整份记忆消失，但也不能装作没发生——
// bad 由调用方用 "! " 报出来（AGENTS 五）。
export function readJsonl(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    // 没有这个分片是正常状态（那天没发生事）；读不动是故障，必须浮上去。
    if (e && e.code === 'ENOENT') return { items: [], bad: 0 }
    throw e
  }
  const items = []
  let bad = 0
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue
    let rec
    try {
      rec = JSON.parse(text)
    } catch {
      bad += 1
      continue
    }
    // 合法 JSON 但不是对象（比如一行 "null"）同样读不出记录，算坏行。
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      bad += 1
      continue
    }
    items.push(rec)
  }
  return { items, bad }
}

// 覆盖写走 tmp → fsync → rename：rename 在同一个目录内是原子的，读者永远看不到半个文件。
// Windows 上 rename 撞到杀毒/索引占用会 EPERM/EBUSY，那是"待会就好"，不是数据坏了，所以退避重试。
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_DELAY = 15 // ms，起始
const RETRY_DELAY_MAX = 225 // ms，上限
const RETRY_ATTEMPTS = 6

export async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  let wait = RETRY_DELAY
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return file
    } catch (e) {
      const code = e && e.code ? e.code : ''
      if (!RETRY_CODES.has(code) || attempt === RETRY_ATTEMPTS) {
        // 内容留在 tmp 里：失败时最要紧的是别把要写的东西也丢了。
        throw new Error(`原子写失败：${file}（${code || String(e)}），内容在 ${tmp}`)
      }
      await sleep(wait)
      wait = Math.min(wait * 2, RETRY_DELAY_MAX)
    }
  }
  return file
}

// 不存在返回 null（"还没写过"是正常状态），坏 JSON 返回 {__bad:true}（"写坏了"不是）。
// 两种都返回 null 会让 doctor 把损坏的 meta.json 说成"还没初始化"，那是最难查的一类谎。
export function readJson(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { __bad: true }
  }
}
