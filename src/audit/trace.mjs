// audit trace（design §6）：把 digest 落的摘要账倒着读一遍，最近那次在最前。
// 只读：账本由 digest 写（design §5 末尾"读命令一律不写盘"），这一层没有 appendJsonl 的入口。
import { AUDIT_LIMIT } from '../core/index.mjs'
import { listShards, readJsonl } from '../store/index.mjs'

// --limit 的缺省收在 core（§10 的 AUDIT_LIMIT）：trace 与 timeline 用同一个数，
// 不然两个读命令会慢慢长出两套口径。

// now 收下不用：这本账按 at 倒序读，没有窗口、没有衰减，解释时间只会多出一个口径
// （AGENTS 二·3 只让 core/time 解释时间，这里连解释都不需要）。签名与 timeline/orphan 对齐。
export function trace({ home, now, limit } = {}) {
  const dir = dataHome(home)
  const cap = capOf(limit)
  const rows = []
  let skipped = 0

  // 分片按月（design §3）：跨月必须一起读，否则上次月的账会"凭空消失"。
  for (const file of listShards(dir, 'trace')) {
    const { items, bad } = readJsonl(file)
    skipped += bad
    for (const rec of items) {
      const one = shapeOf(rec)
      if (one === null) {
        skipped += 1
        continue
      }
      rows.push(one)
    }
  }

  // 只认 a.at - b.at 的数字差（AGENTS 五）：字符串比较在跨年时会把 2026-12 排到 2027-01 后面。
  rows.sort((a, b) => b.at - a.at)
  return { items: rows.slice(0, cap), total: rows.length, limit: cap, skipped }
}

// 一条账要么六格齐全，要么不算一条：缺 budget 的账读不出"预算用掉多少"，留着只会被当成 0。
// 只交出这六个字段，账本里多写的东西不往上层流（渲染是 view 的事）。
function shapeOf(rec) {
  if (!Number.isFinite(rec.at)) return null
  if (!Number.isFinite(rec.budget) || !Number.isFinite(rec.used)) return null
  if (typeof rec.header !== 'string') return null
  if (!Array.isArray(rec.kept) || !rec.kept.every(isId)) return null
  if (!Array.isArray(rec.dropped)) return null
  const dropped = []
  for (const one of rec.dropped) {
    if (!one || typeof one !== 'object' || Array.isArray(one)) return null
    if (!isId(one.id) || typeof one.reason !== 'string') return null
    dropped.push({ id: one.id, reason: one.reason })
  }
  return { at: rec.at, budget: rec.budget, used: rec.used, header: rec.header, kept: [...rec.kept], dropped }
}

function isId(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// limit 只认非负整数：--limit 0 是"给我看看总数但不列条目"，-1 和 1.5 是打错了，直接说清楚。
function capOf(value) {
  if (value === undefined || value === null) return AUDIT_LIMIT
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`trace 的 limit 只能是非负整数，拿到 ${String(value)}（缺省 ${AUDIT_LIMIT}）`)
  }
  return value
}

function dataHome(home) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('trace 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  }
  return home.trim()
}
