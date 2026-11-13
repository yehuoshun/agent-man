// 零件发现：PATH 就是注册表，npm 就是安装器（docs/decisions.md §32）。主项目不留清单，
// 只按名字去找 `agent-man-<名字>`；装的就有，卸的就没了。
import fs from 'node:fs'
import path from 'node:path'
import { capture } from './call.mjs'
import { PART_TIMEOUT, PART_TIMEOUT_MAX } from '../core/index.mjs'

const WIN = process.platform === 'win32'
const PREFIX = 'agent-man-'

// Windows 上按这个次序试，前面的赢；末尾的空串表示"无扩展名"。
const WIN_PATTERNS = ['.exe', '.cmd', '.bat']

// 一个名字在 PATH 上的优先次序：扩展名靠前 > 扩展名靠后 > 无扩展名。
function rank(ext) {
  const i = WIN_PATTERNS.indexOf(ext)
  return i < 0 ? WIN_PATTERNS.length : i
}

// 文件名 → {name, ext}；不像零件就返回 null。
// POSIX 只认无后缀的名字：`agent-man-x.js` 得改名才装得上，否则 `agent-man x` 和
// `agent-man-x.js` 到底是不是同一个东西，脚本永远猜不准。
function parseName(base) {
  if (!base.startsWith(PREFIX)) return null
  const rest = base.slice(PREFIX.length)
  if (!rest) return null
  if (WIN) {
    const lower = rest.toLowerCase()
    for (const ext of WIN_PATTERNS) {
      if (lower.endsWith(ext) && rest.length > ext.length) return { name: rest.slice(0, -ext.length), ext }
    }
  }
  return rest.includes('.') ? null : { name: rest, ext: '' }
}

// 能不能跑：POSIX 看 x 位（PATH 里躺着一个没 x 位的同名文件——下载来的、被 chmod 掉的——
// 不该当零件，它会 EACCES，还会盖住后面目录里真正的那个）；Windows 没有 x 位，认扩展名。
function runnable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false // 同名目录不算零件
    if (WIN) return true
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// 扫一遍 PATH，回 `[{name, file}]`：同一名字第一个 PATH 目录赢，同一目录里按 rank 赢，
// 最后按 name 排序（按码位比，不用 localeCompare——排序结果不该随机器语言变）。
export function scan(env = process.env) {
  // Windows 上有的进程只给 Path 不给 PATH，是同一个变量的两种拼法。
  const dirs = String(env?.PATH || env?.Path || '').split(path.delimiter)
  const found = new Map()
  for (const dir of dirs) {
    if (!dir) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // PATH 里有不存在的目录是常态，不是错误
    }
    const here = new Map()
    for (const ent of entries) {
      if (ent.isDirectory()) continue
      const hit = parseName(ent.name)
      if (!hit) continue
      const prev = here.get(hit.name)
      if (prev && rank(prev.ext) <= rank(hit.ext)) continue
      here.set(hit.name, { ext: hit.ext, file: path.join(dir, ent.name) })
    }
    for (const [name, hit] of here) {
      if (found.has(name)) continue // 靠前的 PATH 目录已经答过了
      if (!runnable(hit.file)) continue
      found.set(name, { name, file: hit.file })
    }
  }
  const names = [...found.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return names.map((n) => found.get(n))
}

// 契约要求 --describe 五个字段齐全（§8）。少一个就说明这个零件还没按契约实现，
// 拿它去拼处境只会拼出 undefined——现在就说"不可用"比以后在屏上露馅便宜。
function missingField(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '一个对象'
  if (typeof data.name !== 'string' || !data.name) return 'name'
  if (typeof data.desc !== 'string') return 'desc'
  if (typeof data.section !== 'string') return 'section'
  if (typeof data.timeout_ms !== 'number' || !Number.isFinite(data.timeout_ms) || data.timeout_ms <= 0) {
    return 'timeout_ms'
  }
  if (!('side_effects' in data)) return 'side_effects'
  return null
}

function whyNot(r, name, timeout) {
  if (r.status === 'timeout') return `${name} 的 --describe 超时（超过 ${timeout}ms 没有回话）`
  if (r.status === 'missing') return `${name} 的 --describe 起不来（${r.why ?? `退出码 ${r.code}`}）`
  const tail = (r.err || '').split('\n')[0].trim()
  return `${name} 的 --describe 崩了（退出码 ${r.code}）${tail ? `：${tail}` : ''}`
}

// 问零件自己是谁。不可用一律 {ok:false, why}，不抛——一个零件坏了不该把整屏拖死。
// timeout_ms 夹到 30 秒上限（§8）：零件自己报的数不可信，夹在这里比让每个调用方各夹一遍
// 可靠；原值也留在 declared_timeout_ms 里，免得夹了不说。
export async function describe(part, { timeout = PART_TIMEOUT, env = process.env } = {}) {
  const name = part?.name ?? path.basename(String(part?.file ?? ''))
  const r = await capture(part, { args: ['--describe'], timeout, env })
  if (r.status !== 'ok') return { ok: false, why: whyNot(r, name, timeout) }
  let data
  try {
    data = JSON.parse(r.out)
  } catch {
    return { ok: false, why: `${name} 的 --describe 输出不是 JSON` }
  }
  const bad = missingField(data)
  if (bad) return { ok: false, why: `${name} 的 --describe 缺 ${bad}` }
  return {
    ok: true,
    name: data.name,
    desc: data.desc,
    section: data.section,
    timeout_ms: Math.min(data.timeout_ms, PART_TIMEOUT_MAX),
    declared_timeout_ms: data.timeout_ms,
    side_effects: data.side_effects,
  }
}
