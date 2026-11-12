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
    memory: path.join(home, 'memory.jsonl'),
    digest: path.join(home, 'digest.md'),
    state: path.join(home, 'state'),
    consolidation: path.join(home, 'state', 'consolidation.json'),
    trace: path.join(home, 'state', 'trace.jsonl'),
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

/** 长期层也只追加。合并靠条目的 supersedes 指针，不改旧行（见 docs/decisions.md#11）。 */
export function appendMemory(home, item) {
  const p = ensure(home)
  fs.appendFileSync(p.memory, JSON.stringify(item) + '\n', 'utf8')
  return item
}

/**
 * 读长期层。坏行跳过并计数，和 readEvents 同一套容忍度。
 * 这里额外校验 id/topic/fact：条目没有这三个字段，渲染和 supersedes 都会失效。
 */
export function readMemory(home) {
  const p = paths(home)
  let raw
  try {
    raw = fs.readFileSync(p.memory, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { items: [], bad: 0 }
    throw e
  }

  const items = []
  let bad = 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let it
    try {
      it = JSON.parse(s)
    } catch {
      bad++
      continue
    }
    if (!it || typeof it.id !== 'string' || !it.topic || !it.fact) {
      bad++
      continue
    }
    items.push(it)
  }
  return { items, bad }
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

/**
 * 读结账记录。没有就返回 null——"从来没结过账"和"结到很久以前"是两件事，
 * 都当成 0 的话，攒了一个月没整理的库会被报成"没有欠账"（见 src/consolidate.mjs）。
 *
 * 坏掉的记录不能猜：猜出来的 at 会让欠账数字变成假的，所以这里直接抛。
 */
export function readConsolidation(home) {
  const p = paths(home)
  let raw
  try {
    raw = fs.readFileSync(p.consolidation, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }

  let rec
  try {
    rec = JSON.parse(raw.trim()) // trim 顺手吃掉 BOM，和 readEvents 同一套
  } catch {
    throw new Error(`${p.consolidation} 不是合法 JSON；坏掉的结账记录不能猜，删掉它重来`)
  }
  if (!rec || typeof rec.at !== 'number' || !Number.isFinite(rec.at)) {
    throw new Error(`${p.consolidation} 缺 at（epoch ms），没法判断欠账`)
  }
  return rec
}

/**
 * 覆盖写：只留最近一次结账，不是 JSONL。走 writeAtomic，断电不会留下半个文件。
 *
 * 只存时刻，不存日/周标签——改 AGENT_MAN_DAY_START 会让标签全变，所以分桶只在
 * 判断时现算（§12）。
 */
export function writeConsolidation(home, rec) {
  ensure(home)
  writeAtomic(paths(home).consolidation, JSON.stringify(rec) + '\n')
  return rec
}

/**
 * 追加一行账（state/trace.jsonl）。和 events 一样只追加：账是回溯用的，
 * 不是当前状态，覆盖写等于把历史抹掉（§17）。
 */
export function appendTrace(home, rec) {
  const p = ensure(home)
  fs.appendFileSync(p.trace, `${JSON.stringify(rec)}\n`, 'utf8')
  return rec
}

/**
 * 读全量账本，按时间升序。
 * 坏行跳过并计数——一条账坏了不该让整个账本读不出来，但也不能装作没发生。
 */
export function readTraces(home) {
  const p = paths(home)
  let raw
  try {
    raw = fs.readFileSync(p.trace, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { traces: [], bad: 0 }
    throw e
  }

  const traces = []
  let bad = 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let t
    try {
      t = JSON.parse(s)
    } catch {
      bad++
      continue
    }
    if (!t || typeof t.at !== 'number' || !Number.isFinite(t.at)) {
      bad++
      continue
    }
    traces.push(t)
  }
  traces.sort((a, b) => a.at - b.at)
  return { traces, bad }
}

/** 原子写。tmp + rename，写到一半断电不会留下半个文件。 */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
