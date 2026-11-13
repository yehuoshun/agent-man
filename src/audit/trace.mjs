// audit trace（design §6）：把 digest 落的摘要账倒着读一遍，最近那次在最前。
// 只读：账本由 digest 写（design §5 末尾"读命令一律不写盘"），这一层没有 appendJsonl 的入口。
import { AUDIT_LIMIT } from '../core/index.mjs'
import { listShards, readJsonl, validate } from '../store/index.mjs'

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

// 一条账合不合法只问 schema：store 是唯一知道"一条记录长什么样"的地方，
// 同一份形状在两处各写一遍，早晚会有一处漏改（第 1 项就是来收这个口的）。
// 判过形状之后这一层只做投影：交出 design §4 那六格，账本里多写的字段不往上层流
// ——渲染是 view 的事，audit 夹带私货只会让上面多一个口径。
function shapeOf(rec) {
  if (!validate('trace', rec).ok) return null
  const one = {
    at: rec.at,
    budget: rec.budget,
    used: rec.used,
    header: rec.header,
    kept: rec.kept,
    dropped: rec.dropped,
  }
  // 缺格的账读不出"预算用掉多少"，留着只会被当成 0：宁可不读，也不替它补一个数。
  for (const value of Object.values(one)) {
    if (value === undefined) return null
  }
  return {
    at: one.at,
    budget: one.budget,
    used: one.used,
    header: one.header,
    kept: [...one.kept],
    dropped: one.dropped.map(({ id, reason }) => ({ id, reason })),
  }
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
