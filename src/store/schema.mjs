import fs from 'node:fs'
import path from 'node:path'

// 数据目录的版本号写进 schema.json：升级时"版本对不上就拒绝"，而不是猜旧格式（design §3）。
export const VERSION = 3

const ORIGINS = new Set(['user', 'tool', 'self'])

// 一条记录该有哪些字段，随里程碑逐层补齐。现在只锁最容易把下游弄坏的四件事：
// 正文、时间、来源、来源引用。返回错误而不抛，让调用方用 "! " 说出来（AGENTS 五）。
export function validate(kind, obj) {
  if (kind !== 'events' && kind !== 'memory') {
    return { ok: false, errors: [`未知的记录类型：${kind}`] }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['记录必须是对象'] }
  }

  const errors = []
  const field = kind === 'events' ? 'text' : 'fact'
  const body = obj[field]
  if (typeof body !== 'string' || body.trim() === '') errors.push(`${field} 必须是非空字符串`)

  // 时间只认 epoch ms 的数字：字符串时间进库后，排序与保留率会在各处再解释一遍（AGENTS 二·3）。
  if (!Number.isFinite(obj.at)) errors.push('at 必须是有限数字（epoch ms）')

  // 情景必带来源；结论行按 design §4 没有 src，出现了照样校验，缺了不算错。
  const src = obj.src
  if (src === undefined && kind === 'events') {
    errors.push('src 必须存在：用户说的、工具返回的、自己推断的要分开记')
  } else if (src !== undefined) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      errors.push('src 必须是 { origin, ref } 形状的对象')
    } else {
      if (!ORIGINS.has(src.origin)) {
        errors.push(`src.origin 只能是 user / tool / self，拿到的是 ${String(src.origin)}`)
      }
      if (src.origin === 'tool' && (typeof src.ref !== 'string' || src.ref.trim() === '')) {
        errors.push('src.origin 是 tool 时必须带 ref（插件名），否则分不清是谁看见的')
      }
    }
  }

  return { ok: errors.length === 0, errors }
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
