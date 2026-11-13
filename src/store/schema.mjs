import fs from 'node:fs'
import path from 'node:path'

// 数据目录的版本号写进 schema.json：升级时"版本对不上就拒绝"，而不是猜旧格式（design §3）。
export const VERSION = 3

const ORIGINS = new Set(['user', 'tool', 'self'])
const OPS = new Set(['add', 'take', 'done'])

// 五类记录的"正文"字段名不一样：结论记的是去情境的 fact，其它都是 text（design §4）。
// 这张表同时充当"认识的类型"白名单——不在表里的 kind 直接算错，不猜。
const BODY = new Map([
  ['events', 'text'],
  ['memory', 'fact'],
  ['rules', 'text'],
  ['notes', 'text'],
  ['plans', 'text'],
])

// 校验的全部职责是说清"哪一条不对、怎么改"，不是修数据（AGENTS 五：不猜、不补、
// 不截断后继续）。所以永远返回 { ok, errors }，永远不抛——抛了调用方就没法把
// 每条错误变成一行 "! "，只能吐一个栈。
export function validate(kind, obj) {
  const field = BODY.get(kind)
  if (!field) {
    return { ok: false, errors: [`未知的记录类型：${String(kind)}（只认 ${[...BODY.keys()].join(' / ')}）`] }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['记录必须是对象'] }
  }

  const errors = []
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    errors.push('id 必须是非空字符串：没有 id 就没法引用、没法去重')
  }
  const body = obj[field]
  if (typeof body !== 'string' || body.trim() === '') {
    errors.push(`${field} 必须是非空字符串`)
  }
  // 时间只认 epoch ms 的数字：字符串时间进库后，排序与保留率会在各处再解释一遍（AGENTS 二·3）。
  if (!Number.isFinite(obj.at)) errors.push('at 必须是有限数字（epoch ms）')

  if (kind === 'memory') {
    // key 是唯一槽位：新条靠它给旧条写 to/by，空 key 等于没有槽位（design §2 干扰）。
    if (typeof obj.key !== 'string' || obj.key.trim() === '') {
      errors.push('key 必须是非空字符串：结论靠它占唯一槽位')
    }
    errors.push(...evidenceErrors(obj.evidence))
  }

  // 情景必带来源；结论与规矩照 design §4 没有 src，带了也照样校验。
  if (kind === 'events' && obj.src === undefined) {
    errors.push('src 必须存在：用户说的、工具返回的、自己推断的要分开记')
  } else if (obj.src !== undefined) {
    errors.push(...srcErrors(obj.src))
  }

  if (kind === 'notes' || kind === 'plans') {
    if (!OPS.has(obj.op)) {
      errors.push(`op 只能是 ${[...OPS].join(' / ')}，拿到的是 ${String(obj.op)}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function srcErrors(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return ['src 必须是 { origin, ref } 形状的对象']
  }
  const errors = []
  if (!ORIGINS.has(src.origin)) {
    errors.push(`src.origin 只能是 ${[...ORIGINS].join(' / ')}，拿到的是 ${String(src.origin)}`)
  }
  if (src.origin === 'tool' && (typeof src.ref !== 'string' || src.ref.trim() === '')) {
    errors.push('src.origin 是 tool 时必须带 ref（插件名），否则分不清是谁看见的')
  }
  return errors
}

// 这里只验形状；"ids 能不能解析到真实事件"是 memory 层的事（它要读盘，读盘不归 store）。
// 但"至少 1 条"照 design §4 写死：一条证据都没有的结论是猜的，不该进库。
function evidenceErrors(ev) {
  if (ev === undefined) return ['evidence 必须存在：结论要么有事件撑着，要么就是猜的']
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return ['evidence 必须是 { ids, from, to } 形状的对象']
  }
  const errors = []
  if (!Array.isArray(ev.ids)) {
    errors.push('evidence.ids 必须是事件 id 数组')
  } else if (ev.ids.length === 0) {
    errors.push('evidence.ids 至少要有 1 条事件：解析不到证据的结论不算结论')
  } else if (!ev.ids.every((id) => typeof id === 'string' && id.trim() !== '')) {
    errors.push('evidence.ids 里每一项都必须是非空字符串')
  }
  for (const key of ['from', 'to']) {
    const v = ev[key]
    if (v !== undefined && v !== null && !Number.isFinite(v)) {
      errors.push(`evidence.${key} 只能是 null 或有限数字（epoch ms）`)
    }
  }
  return errors
}

// doctor 的第一件事：这个目录到底是不是我们的、版本对不对。缺目录不算异常，
// 只把原因写成人话交给上层的 "! " 行；读命令不写盘，所以这里什么都不建。
export function checkHome(home) {
  if (!fs.existsSync(home)) {
    return {
      home,
      exists: false,
      version: null,
      ok: false,
      why: `数据目录不存在：${home}（M1 第一次写入时建）`,
    }
  }

  let raw = ''
  try {
    raw = fs.readFileSync(path.join(home, 'schema.json'), 'utf8')
  } catch (e) {
    const why = e && e.code === 'ENOENT'
      ? '缺少 schema.json：要么不是 agent-man 的数据目录，要么从未初始化过'
      : `schema.json 读不动：${e && e.message ? e.message : String(e)}`
    return { home, exists: true, version: null, ok: false, why }
  }

  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    const why = `schema.json 不是合法 JSON：${e && e.message ? e.message : String(e)}`
    return { home, exists: true, version: null, ok: false, why }
  }

  const version = doc && Number.isInteger(doc.version) ? doc.version : null
  if (version !== VERSION) {
    const seen = version === null ? '未知' : String(version)
    return {
      home,
      exists: true,
      version,
      ok: false,
      why: `schema 版本是 ${seen}，本程序要 ${VERSION}：先备份数据目录，再决定升级还是换 AGENT_MAN_HOME`,
    }
  }
  return { home, exists: true, version, ok: true, why: '' }
}
