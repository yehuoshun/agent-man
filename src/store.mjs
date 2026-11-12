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
    cue: path.join(home, 'state', 'cue.json'),
    handoff: path.join(home, 'state', 'handoff.jsonl'),
    plan: path.join(home, 'state', 'plan.jsonl'),
    place: path.join(home, 'state', 'place.json'),
    sky: path.join(home, 'state', 'sky.json'),
    ids: path.join(home, 'state', 'ids'),
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
  assertLanded(p.events, appendLine(p.events, `${JSON.stringify(ev)}\n`))
  return ev
}

/**
 * 追加一行，并且真的落盘。
 *
 * fsync 是"这句话归你了"的唯一证据。`appendFileSync` 返回只代表写进了页缓存：
 * 进程死掉数据还在（内核替你看着），但停电、蓝屏、强制重启会把最后几秒抹掉，
 * 而那时 log 已经打印过"记下了"。一次命令只写一行，多这一次 fsync 换的是
 * "断电最多丢掉正在执行的那一次"。
 */
function appendLine(file, text) {
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return text
}

/** 核对落盘时读多大的尾巴：一行日记远小于这个数，几行邻居也挤不掉它。 */
const TAIL_BYTES = 64 * 1024

/**
 * 写完读回核对：我们这一行到底在不在文件里。
 *
 * 断电可以留下半行：那段 JSON 解析不出来，要等到下次 readEvents 才被算成坏行——
 * 那时候模型早就以为记下了。当场读一遍（只读文件尾），把"下次才发现"变成"现在报错"。
 * 只读尾部：日记攒到几千条以后，每次写都全量读一遍是拿 O(历史) 换一次核对。
 *
 * 为什么核对的是"我这一行"而不是"最后一行"：并发写入时，别人在你 write 完、你
 * 读回之前追加了一行，你读到的就是别人的行，于是对着一条完好的记录喊"没落全"。
 * 实测 30 个进程同时 log，15 个假报错，而文件里 30 条一条不少——假警报比不核对更糟，
 * 那句话（"别当它记下了"）会让模型再记一遍。O_APPEND 的单次 write() 是原子的，
 * 我们要么完整落了一行，要么只剩半截前缀：前缀里搜不到整行（连行尾换行），照样报错。
 */
export function assertLanded(file, text) {
  const size = fs.statSync(file).size
  const len = Math.min(size, TAIL_BYTES)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, len, size - len)
  } finally {
    fs.closeSync(fd)
  }
  if (!buf.toString('utf8').includes(text)) {
    throw new Error(`${file} 这一行没落全：读回来找不到刚写的那行，别当它记下了`)
  }
}

/** 长期层也只追加。合并靠条目的 supersedes 指针，不改旧行（见 docs/decisions.md#11）。 */
export function appendMemory(home, item) {
  const p = ensure(home)
  assertLanded(p.memory, appendLine(p.memory, `${JSON.stringify(item)}\n`))
  return item
}

/**
 * 读长期层。坏行跳过并计数，和 readEvents 同一套容忍度。
 * 这里额外校验 id/topic/fact：条目没有这三个字段，渲染和 supersedes 都会失效。
 */
export function appendHandoff(home, rec) {
  const p = ensure(home)
  assertLanded(p.handoff, appendLine(p.handoff, `${JSON.stringify(rec)}\n`))
  return rec
}

/**
 * 便条是流水账（leave / take / drop 各一行），不覆盖写：
 * 覆盖写会把"这张取走了"变成一个不可回看的现状，出事时说不清是哪一张、谁先没的。
 */
function readLedger(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { records: [], bad: 0 }
    throw e
  }

  const records = []
  let bad = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec
    try {
      rec = JSON.parse(t)
    } catch {
      bad++
      continue
    }
    if (!rec || typeof rec.id !== 'string' || typeof rec.op !== 'string') {
      bad++
      continue
    }
    records.push(rec)
  }
  return { records, bad }
}

export function readHandoff(home) {
  return readLedger(paths(home).handoff)
}

/**
 * 日程也是流水账（add / done 各一行）：划掉是新增一行，不是改上一行。
 * 覆盖写会把"什么时候划掉的"抹掉，而那正是唯一能回答"那天到底去没去"的东西。
 */
export function appendPlan(home, rec) {
  const p = ensure(home)
  assertLanded(p.plan, appendLine(p.plan, `${JSON.stringify(rec)}\n`))
  return rec
}

export function readPlan(home) {
  return readLedger(paths(home).plan)
}
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
 * 抢一个发号名额：同一天的 id 由"现有几条"算出来，两个进程同时读到同一个数，
 * 就会发出同一个号——20 个进程并发 remember，实测只发出 10 个不同的 id（§29）。
 *
 * 名额是 `state/ids/<id>` 这个空文件：`wx` 建文件是原子的，建上算抢到，
 * EEXIST 就是别人先占了。不用锁文件，也就没有"进程崩了留下死锁"这件事。
 */
export function claimId(home, id) {
  const dir = paths(home).ids
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.closeSync(fs.openSync(path.join(dir, id), 'wx'))
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
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
  assertLanded(p.trace, appendLine(p.trace, `${JSON.stringify(rec)}\n`))
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

/**
 * 读"上次开口"的记录（state/cue.json）。没有就返回 null——第一次问和问过很多次
 * 是两件事：前者没有水位（所有日记都算新的），后者要按上次的水位算。
 *
 * 坏掉的记录不猜：水位猜错会让同一条日记要么永远端不上来、要么反复端上来。
 */
export function readCue(home) {
  const p = paths(home)
  let raw
  try {
    raw = fs.readFileSync(p.cue, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let rec
  try {
    rec = JSON.parse(raw.trim())
  } catch {
    throw new Error(`${p.cue} 不是合法 JSON；坏掉的水位不能猜，删掉它重来`)
  }
  if (!rec || typeof rec.lastAt !== 'number' || !Number.isFinite(rec.lastAt)) {
    throw new Error(`${p.cue} 缺 lastAt（epoch ms），没法判断隔了多久`)
  }
  return rec
}

/** 覆盖写：只留最近一次开口。走 writeAtomic（§20）。 */
export function writeCue(home, rec) {
  ensure(home)
  writeAtomic(paths(home).cue, JSON.stringify(rec) + '\n')
  return rec
}

/**
 * 小状态文件（坐标、上次看天的快照）：一整个 JSON 对象，覆盖写。
 *
 * 坏了不猜：坐标猜错会把天气报到别的城市去，快照猜错会让"变了什么"全是假的。
 * 这两种错都不会报错、只会安静地说错话，所以宁可让它当场崩。
 */
function readJson(file, what) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(raw.trim())
  } catch {
    throw new Error(`${file} 不是合法 JSON；${what}坏了不能猜，删掉它重来`)
  }
}

function writeJson(home, file, rec) {
  ensure(home)
  writeAtomic(file, `${JSON.stringify(rec)}\n`)
  return rec
}

/** 记下的地方（state/place.json）：查一次地理编码就存下来，之后只看坐标。 */
export function readPlace(home) {
  return readJson(paths(home).place, '记下的地方')
}

export function writePlace(home, place) {
  return writeJson(home, paths(home).place, place)
}

/**
 * 上次看天的记录（state/sky.json）：`{ at, data, said }`。
 * data 是缓存下来的那份天气（省一次请求），said 是"上次说过的样子"（判断变没变）。
 */
export function readSky(home) {
  return readJson(paths(home).sky, '上次看天的记录')
}

export function writeSky(home, rec) {
  return writeJson(home, paths(home).sky, rec)
}

/**
 * 原子写：tmp + fsync + rename（POSIX 上再 fsync 目录），断电不会留下半个文件。
 *
 * 只 writeFileSync + rename 是不够的：内容还在页缓存里就改名，崩溃后可能拿到
 * "新名字、空内容"。顺序必须是"内容先落盘，再改名，最后让目录项落盘"（§20）。
 */
export function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  renameWithRetry(fs.renameSync, tmp, file)
  syncDir(dir)
}

const RENAME_TRIES = 6
const RENAME_WAIT_MS = 15

/**
 * 换个名字也要挑时候：Windows 上 rename 不是"原子替换"，目标正被别的进程打开着
 * （或者被杀软/索引器扫）会直接 EPERM。实测 30 个 remember 同时跑，5–20 个栽在
 * 这一步——文件其实好好的，坏的是"报错"本身：模型看见 `! ...` 会以为没记下，
 * 于是再记一遍（§29）。
 *
 * 撞手的时间以毫秒计，所以先退避重试；重试还是不行才抛，并且把话说清楚是
 * "别人拿着"而不是"写坏了"。非并发类错误（ENOENT、EISDIR…）不重试，原样抛。
 */
export function renameWithRetry(rename, tmp, file, { tries = RENAME_TRIES, waitMs = RENAME_WAIT_MS } = {}) {
  for (let i = 1; ; i += 1) {
    try {
      rename(tmp, file)
      return
    } catch (e) {
      const busy = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'
      if (!busy || i >= tries) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // 临时文件本来就可能已经被搬走了；清不掉不算新事故，别盖住真正的错。
        }
        if (busy) {
          throw new Error(`${file} 写不进去：另一个进程正拿着它，重试 ${i} 次还是不行（${e.code}）`)
        }
        throw e
      }
      sleepSync(waitMs * i)
    }
  }
}

/** 同步小睡：从 fs 到 rename 都是同步的，插不进 await。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 目录项也要落盘，否则重命名可能还在半路上。
 * Windows 上不能对目录 fsync（开着就 EPERM），退回"靠 NTFS 的元数据日志"——
 * 这点差别写进 §20，不假装两边一样强。
 */
function syncDir(dir) {
  if (process.platform === 'win32') return
  let fd
  try {
    fd = fs.openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
