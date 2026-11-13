// intent 两条流（便条 / 日程）共用的"形状"：把命令行递进来的人话变成记录里的数字。
// 时间只解释一次（AGENTS 二·3）：字符串在这里过 parseWhen 归一成 epoch ms，
// 从此写盘的记录里只有数字，读的人不必再猜一遍时区。
import { NOTE_TTL, now, parseWhen } from '../core/index.mjs'
import { validate } from '../store/index.mjs'

// 毫秒换算是单位，不是 §10 里的调参常数；§10 的数（NOTE_TTL 之类）一律从 core 取。
const DAY_MS = 24 * 60 * 60 * 1000
// ttl 上限：便条是"过几天该做的事"，一年还没过期多半是把结束时间当成了时长。
const TTL_MAX = 365 * DAY_MS

const WHEN_HINT = '认得的写法：2026-11-20 / 2026-11-20 09:00 / 21:40 / 明天 9:00 / 3d / 12h / 30m'
const DUE_HINT = `日程要一个时间点，${WHEN_HINT}`

// 两种写法都收：add(home, { text, ... })（design §7 里到处是这一形）与
// add(home, '话', { ... })（CLI 的散参数顺手）。拼参数不改语义，落盘的还是同一条。
export function optsOf(a, b) {
  if (typeof a === 'string') return { ...(b ?? {}), text: a }
  if (!a || typeof a !== 'object') throw new Error('没给要记的内容：至少要 { text } 或一个字符串')
  return a
}

// 记录时刻：调用方（CLI / 宿主）给了 now 就用它，只有真没人给才看墙钟。
// at 同时也是解释相对时间的基准——用两个不同的"现在"，'3h' 就可能落到分片边界外。
export function atOf(opts) {
  if (Number.isFinite(opts.at)) return opts.at
  if (Number.isFinite(opts.now)) return opts.now
  return now()
}

// 正文只做一件事：挡掉空白。长度上限归 store/schema 的 cost 规则（design §4），
// 这里不抄第二遍——两处预算迟早会分叉。
export function textOf(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}必须是非空字符串：留不住一句话的便条不值得落盘`)
  }
  return value
}

// 可选的人话时间 → epoch ms。给了就必须能解释：解析失败抛错，由 CLI 变成
// "退出码 2 + 怎么改"。猜一个"大概今天"比没有时间更坏——日程会因此错一天。
export function timeOf(value, base, flag) {
  if (value === undefined || value === null) return undefined
  // 已经是数字就照用：上游解释过的再解释一遍，正是 AGENTS 二·3 要防的事。
  if (Number.isFinite(value)) return value
  const at = parseWhen(value, base)
  if (at === null) {
    const hint = flag === 'due' ? DUE_HINT : WHEN_HINT
    throw new Error(`${flag} 读不出时间：${quote(value)}；${hint}`)
  }
  return at
}

// ttl 缺省 NOTE_TTL（design §10），也收 '7d' 这种跨度写法。
// 但只接受"真的是跨度"的结果：'2026-11-20' 会被解释成五十多年的时长，
// 那是把 --ttl 打成了 --when，静默收下等于让这条便条永远不过期。
export function ttlOf(value) {
  if (value === undefined || value === null) return NOTE_TTL
  const ms = Number.isFinite(value) ? value : parseWhen(value, 0)
  if (ms === null || !Number.isFinite(ms)) {
    throw new Error(`ttl 读不出时长：${quote(value)}；只认 30m / 12h / 7d 或毫秒数`)
  }
  if (!(ms > 0)) throw new Error(`ttl 必须大于 0：拿到 ${ms}`)
  if (ms > TTL_MAX) {
    throw new Error(`ttl 最多一年，拿到约 ${Math.round(ms / DAY_MS)} 天：是不是把结束时间当成了时长？`)
  }
  return ms
}

// 写盘前唯一一次校验，走 store/schema——它是记录校验的真源（design §4）。
// 不合法就抛：调用方把 errors 变成 "! " 行与退出码 2，记录一行也不写。
export function gate(kind, rec) {
  const { ok, errors } = validate(kind, rec)
  if (ok) return rec
  throw new Error(`${kind} 记录不合法：\n  ${errors.join('\n  ')}`)
}

// 读的一侧只判"这一行能不能拿来折叠"：op 是字符串、id 非空、at 是有限数字。
// 刻意不重跑 validate：take / done 这类 op 本来就没有 text，跑 validate 会把它们全判成坏行。
export function isOp(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false
  if (typeof rec.op !== 'string' || rec.op === '') return false
  if (typeof rec.id !== 'string' || rec.id === '') return false
  if (!Number.isFinite(rec.at)) return false
  // add 没有正文等于什么也没记下：这种行折不出便条，按坏行算。
  if (rec.op === 'add' && (typeof rec.text !== 'string' || rec.text.trim() === '')) return false
  return true
}

function quote(value) {
  if (typeof value === 'string') return `「${value}」`
  return String(value)
}
