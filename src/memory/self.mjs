import fs from 'node:fs'
import path from 'node:path'

import { SELF_MAX, cost, dayKey } from '../core/index.mjs'
import { ensure, writeAtomic } from '../store/index.mjs'

import { nowOf, requireHome } from './shape.mjs'

// 自我块（design §4）：一份纯文本 self.md，不分片、不带 id、不做版本。
// 它记的不是"发生过什么"，而是"我现在是谁"——那种东西一变，旧版本就没有保留价值，
// 留着只会让下一个人分不清哪句还算数。所以这里唯一允许的写是整份覆盖，
// 以及"往后面接一段今天的话"。
//
// 预算按整份文本算：SELF_MAX cost 是这份文件的天花板（design §10），
// 拆成"每段多少"没有意义——注入时读的永远是整份。

export function selfFile(home) {
  return path.join(home, 'self.md')
}

// 读：没有这个文件是正常状态（还没写过自我块），返回空文本而不是抛。
// cost 用 core 的真算（全角 1.0 / 半角 0.28），不在这里另留一个字面量口径。
// updatedAt 取文件 mtime：要不要显示"上次改是什么时候"是 view 的事，这里只如实交出。
export function readSelf(home) {
  const dir = requireHome({ home })
  const file = selfFile(dir)
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  const text = stat === undefined ? '' : fs.readFileSync(file, 'utf8')
  const used = cost(text)
  return {
    text,
    cost: used,
    updatedAt: stat === undefined ? null : stat.mtimeMs,
    limit: SELF_MAX,
    over: used > SELF_MAX,
  }
}

// 整份覆盖。覆盖走 store 的原子写（tmp → fsync → rename）：
// 自我块只有一份，写坏半份就是"我现在是谁"答不上来。
// 超预算就拒绝，不截断：截掉的正好是人最想留住的那句（AGENTS 五：不猜、不补、不截断后继续）。
// 返回里带 ok/status，是为了让 CLI 能一眼分辨"写进去了"与"抛了"；
// 超预算一律抛出（退出码 2 由 CLI 决定，不由这一层决定）。
export async function setSelf(home, text, opts = {}) {
  const dir = requireHome({ home })
  const body = normalize(text, 'setSelf')
  const used = budgetOf(body, 'setSelf')
  ensure(dir)
  const before = readSelf(dir)
  await writeAtomic(selfFile(dir), body)
  // now 在这里用不上：这份文本没有自己的 at，时间只体现在文件的 mtime 上。
  return { status: 'set', cost: used, limit: SELF_MAX, was: before.cost }
}

// 追加一段。段首自动补 `## YYYY-MM-DD`（日期由传入的 now 算，不摸 clock），
// 同一天接着写就不再重复加标题——一天里写三段自我更新，标三个一样的日期没用。
// 追加后超预算同样拒绝，并把"写下去会是多少"说清楚：让人知道要删的是哪里。
export async function appendSelf(home, text, opts = {}) {
  const dir = requireHome({ home })
  const input = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}
  const body = normalize(text, 'appendSelf')
  if (body.trim() === '') {
    throw new Error('appendSelf 要追加的段落是空的：写不出话的时候别留下一个只有日期的标题')
  }
  // 日界跟着配置走（design §15 的 clock.dayStart）：自己算一份 00:00 就成了第二个解释器，
  // 凌晨写下的那一段会归到前一天，跟事件分片名对不上。
  const header = `## ${dayKey(nowOf({ now: input.now }), { dayStart: input.dayStart ?? 0 })}`
  const before = readSelf(dir)
  // 末尾那个换行会 split 出一个空串，所以只看非空行；判断"今天这段是不是已经开着"要看
  // 最后一个 `## ` 标题，而不是最后一行——最后一行通常是正文，正文永远不等于标题。
  const lines = before.text.split('\n').filter((line) => line.trim() !== '')
  const lastHeader = [...lines].reverse().find((line) => line.trim().startsWith('## ')) ?? ''
  const needsHeader = lastHeader.trim() !== header
  const block = needsHeader ? `${header}\n${body}` : body
  // body 自带末尾换行，所以空文件时直接就是整份；非空时只补一个空行分隔，不再多补一个尾换行。
  const next = before.text.trim() === '' ? block : `${before.text.replace(/\n+$/, '')}\n\n${block}`
  const used = budgetOf(next, 'appendSelf')
  ensure(dir)
  await writeAtomic(selfFile(dir), next)
  return {
    status: needsHeader ? 'appended' : 'appended-same-day',
    cost: used,
    limit: SELF_MAX,
    was: before.cost,
    header: needsHeader ? header : null,
  }
}

// 一律写成 LF：仓库锁了 eol=lf，Windows 上从剪贴板粘进来的 CRLF 会让 cost 与 diff 都多算一份。
// 末尾补一个换行（空文本例外）：文件最后一行没有换行，下一次追加就得猜要不要补。
function normalize(text, what) {
  if (typeof text !== 'string') {
    throw new Error(`${what} 需要字符串文本，拿到的是 ${text === null ? 'null' : typeof text}`)
  }
  const body = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return body === '' ? '' : `${body}\n`
}

// 预算按写下去的整份文本算（含标题与空行）：注入时读的就是这些字节。
function budgetOf(body, what) {
  const used = cost(body)
  if (used > SELF_MAX) {
    throw new Error(
      `${what} 会写到 ${used.toFixed(1)} cost，自我块上限是 ${SELF_MAX}：`
        + '先删掉不该留的那段（整份覆盖，别指望截断）',
    )
  }
  return used
}
