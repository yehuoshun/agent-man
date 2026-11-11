import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 存储就是一行一个 JSON。
 *
 * 为什么不上数据库：这个项目全部资产是可读、可改、可单独拿走。
 * `cat events.jsonl | grep` 能用，比什么都重要。
 */

export function resolveHome(env = process.env, fallbackHomedir = os.homedir()) {
  const raw = env.AGENT_MAN_HOME?.trim()
  return path.resolve(raw || path.join(fallbackHomedir, '.agent-man'))
}

export function paths(home) {
  return {
    home,
    events: path.join(home, 'events.jsonl'),
    digest: path.join(home, 'digest.md'),
    state: path.join(home, 'state'),
  }
}

export function ensure(home) {
  const p = paths(home)
  fs.mkdirSync(p.home, { recursive: true })
  fs.mkdirSync(p.state, { recursive: true })
  return p
}

/**
 * 追加一条。
 *
 * BOM 事故：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
 * 下游 JSON.parse 直接抛，插件静默停摆。所以这里显式 utf8、不写 BOM、只写一行。
 */
export function appendEvent(home, ev) {
  const p = ensure(home)
  fs.appendFileSync(p.events, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

/**
 * 读全量，按时间升序返回。
 * 坏行跳过并计数——不因为一行坏掉就丢整份记忆。
 * 这是刻意的取舍：参考实现在 self 块上选择 "宁可这次不更新"，
 * 那是为了保真（原话不能被改写）；这里读的是日志，多读一条比少读一条好，
 * 但坏行必须报出来，不能假装没发生。
 */
export function readEvents(home, { since, until } = {}) {
  const p = paths(home)
  let raw
  try {
    raw = fs.readFileSync(p.events, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { events: [], bad: 0 }
    throw e
  }

  const events = []
  let bad = 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev
    try {
      ev = JSON.parse(s)
    } catch {
      bad++
      continue
    }
    if (!ev || typeof ev.at !== 'number' || !Number.isFinite(ev.at) || !ev.fact) {
      bad++
      continue
    }
    if (since != null && ev.at < since) continue
    if (until != null && ev.at > until) continue
    events.push(ev)
  }
  events.sort((a, b) => a.at - b.at) // 只认数字，不认字符串
  return { events, bad }
}

/** 原子写。tmp + rename，写到一半断电不会留下半个文件。 */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
