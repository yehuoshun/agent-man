import fs from 'node:fs'
import path from 'node:path'

import { dayKey, now } from '../core/index.mjs'

// 前缀与记录类型一一对应（design §4）：e 情景、m 结论、r 规矩、n 便条、p 日程。
const PREFIXES = new Set(['e', 'm', 'r', 'n', 'p'])
// 并发抢号时每次撞车只前进一格，所以次数要给够：20 个一起抢，最后一个最坏撞 19 次。
const CLAIM_TRIES = 64

// 号不是"数出来"的，是"抢"出来的：先猜一个空位，再用 wx（O_EXCL）去建文件，
// 建成了才算数。按"现有几条 +1"算号在并发下必然重号，而重号会静默覆盖一条记忆——
// 那是本仓库唯一不能出错的地方（AGENTS 五）。
// 用异步：抢号的价值全在真并发上，await 让同进程的 20 个 claim() 真的会交错。
export async function claim(homeDir, prefix) {
  if (!PREFIXES.has(prefix)) {
    throw new Error(`发号前缀只能是 ${[...PREFIXES].join(' / ')}，拿到的是 ${String(prefix)}`)
  }
  const dir = path.join(homeDir, 'state', 'ids')
  // 只保证自己的目录在，不替整个数据目录做初始化：schema.json 是 ensure 的事。
  fs.mkdirSync(dir, { recursive: true })
  const head = `${prefix}-${dayKey(now()).replace(/-/g, '')}-`
  let seq = (await maxSeq(dir, head)) + 1

  for (let tries = 0; tries < CLAIM_TRIES; tries += 1) {
    const id = `${head}${pad(seq)}`
    try {
      const handle = await fs.promises.open(path.join(dir, id), 'wx')
      await handle.close()
      return id
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e
      seq += 1
    }
  }
  throw new Error(`抢号失败：${head}* 连续 ${CLAIM_TRIES} 次都被人先占了（state/ids/ 是否需要清理？）`)
}

// 只是选个起点，不做权威：起点猜小了大不了多撞几次，猜大了一点不影响正确性。
async function maxSeq(dir, head) {
  let names = []
  try {
    names = await fs.promises.readdir(dir)
  } catch (e) {
    if (e && e.code === 'ENOENT') return 0
    throw e
  }
  let max = 0
  for (const name of names) {
    if (!name.startsWith(head)) continue
    const tail = name.slice(head.length)
    if (!/^\d+$/.test(tail)) continue
    const n = Number(tail)
    if (n > max) max = n
  }
  return max
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}
