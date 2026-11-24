import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import { stripBom } from '../core/index.mjs'

// 写 JSONL 只有这一条路（AGENTS 五）：open → write → fsync → close，然后读回自己那一行。
// 少了 fsync，进程/断电一崩，那一行就只在页缓存里——"写过了"变成一句自我安慰。
export function appendJsonl(file, obj) {
  const line = JSON.stringify(obj)
  if (typeof line !== 'string') {
    throw new Error(`记录序列化失败：JSON.stringify 返回了 ${typeof line}（多半是传了函数或 undefined）`)
  }
  // 追加前先看一眼末字节：末行没换行的文件（手写的、或上次写到一半崩了）直接追加，
  // 新行会粘在旧行尾巴上——一次 append 同时毁掉旧记录和新记录，两条都读不出来。先补个 \n。
  // 并发时两个写者可能各补一个：多出来的空行 readJsonl 当空行跳过，不伤任何一条记录。
  const tail = tailOf(file)
  let bad = null
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, `${tail.nl === false ? '\n' : ''}${line}\n`)
    fs.fsyncSync(fd)
  } catch (e) {
    bad = e
  } finally {
    fs.closeSync(fd)
  }
  if (bad) {
    rollback(file, tail)
    throw bad
  }
  // 只 fsync 不够：盘上说写了、文件里没有的事故真发生过，所以读回来核一遍。
  assertLanded(file, obj, line)
  return obj
}

// 追加前的那一眼：文件在不在、多长、末字节是不是换行。只读一个字节，不把整份读进内存。
// 读到的一半（existed 且 nl === false）说明上一个写者留下了没有收尾的半行。
function tailOf(file) {
  let fd = -1
  try {
    fd = fs.openSync(file, 'r')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { existed: false, size: 0, nl: true }
    throw e
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= 0) return { existed: true, size, nl: true }
    const one = Buffer.alloc(1)
    const got = fs.readSync(fd, one, 0, 1, size - 1)
    return { existed: true, size, nl: got === 1 && one[0] === 0x0a }
  } finally {
    fs.closeSync(fd)
  }
}

// 写失败时把文件切回追加前的大小：留着半行，下次追加就又要靠 tailOf 兜一次，
// 而且一行坏在两个写者之间——等于把一次写失败扩散成两条坏行。
// 按路径切而不对句柄 ftruncate：Windows 上对以 'a'/'a+' 打开的句柄 ftruncate 直接 EPERM（实测）。
// 回滚自己失败不盖住原始错误：那个错更要紧，盘上剩的半行由 doctor 的坏行检查如实报出来。
function rollback(file, tail) {
  try {
    if (!tail.existed) fs.rmSync(file, { force: true })
    else fs.truncateSync(file, tail.size)
  } catch {
    // 见上：原始错误优先。
  }
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

// BOM 是文件头的编码标记，不是这一行的内容。记事本另存过的文件、被 PowerShell 5.1 重定向写过的
// 文件都带它；带着 U+FEFF 去 JSON.parse 一定失败，于是整份记忆的第一行被当成坏行丢掉——
// 修的是解析口径，不是让人手动去删 BOM。判定口径收在 core/text.mjs，配置与 JSON 读同一份。

// 坏行跳过并计数，不抛：一行坏掉不该让整份记忆消失，但也不能装作没发生——
// bad 由调用方用 "! " 报出来（AGENTS 五）。
// lines: true 额外带出坏行的行号与原因（doctor 要报得出"哪个文件第几行"），
// 默认不带：返回值仍是 { items, bad } 两个字段。
export function readJsonl(file, { lines = false } = {}) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    // 没有这个分片是正常状态（那天没发生事）；读不动是故障，必须浮上去。
    if (e && e.code === 'ENOENT') return { items: [], bad: 0 }
    throw e
  }
  const items = []
  const badLines = []
  let bad = 0
  const all = raw.split('\n')
  for (let i = 0; i < all.length; i += 1) {
    const text = stripBom(all[i])
    if (text.trim() === '') continue
    let rec = null
    let why = ''
    try {
      rec = JSON.parse(text)
    } catch (e) {
      why = e && e.message ? e.message : '不是合法 JSON'
    }
    // 合法 JSON 但不是对象（比如一行 "null"）同样读不出记录，算坏行。
    if (why === '' && (!rec || typeof rec !== 'object' || Array.isArray(rec))) why = '不是 JSON 对象'
    if (why !== '') {
      bad += 1
      if (lines) badLines.push({ line: i + 1, why, text })
      continue
    }
    items.push(rec)
  }
  return lines ? { items, bad, badLines } : { items, bad }
}

// 覆盖写走 tmp → fsync → rename：rename 在同一个目录内是原子的，读者永远看不到半个文件。
// Windows 上 rename 撞到杀毒/索引占用会 EPERM/EBUSY，那是"待会就好"，不是数据坏了，所以退避重试。
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_DELAY = 15 // ms，起始
const RETRY_DELAY_MAX = 225 // ms，上限
const RETRY_ATTEMPTS = 6

export async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    // 写到一半就失败：tmp 里是半份内容，谁也不会去读半份，留着它只是数据目录里的垃圾。清掉再抛。
    discard(tmp)
    throw e
  }

  let wait = RETRY_DELAY
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return file
    } catch (e) {
      const code = e && e.code ? e.code : ''
      if (!RETRY_CODES.has(code) || attempt === RETRY_ATTEMPTS) {
        // 走到这里 tmp 里是整份新内容：不删——删掉等于把这次要写的东西静默丢掉。
        // 留着的坏处是没人收，所以 doctor 有一项「残留 .tmp」会把它连路径一起报出来；
        // 下一次对同一个文件 writeAtomic 会用 'w' 覆盖它，重试一次就干净了。
        throw new Error(`原子写失败：${file}（${code || String(e)}），内容在 ${tmp}，等会重试一次就会覆盖它`)
      }
      await sleep(wait)
      wait = Math.min(wait * 2, RETRY_DELAY_MAX)
    }
  }
  return file
}

// 清 tmp 自己失败不盖住原始错误：那个错更要紧，留下的 tmp 由 doctor 的残留检查报出来。
function discard(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // 见上。
  }
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
    return JSON.parse(stripBom(raw))
  } catch {
    return { __bad: true }
  }
}
