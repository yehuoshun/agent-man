// 复述记账（design §5）：被选进摘要的结论 seen +1，"这条我说过几次"才有出处。
// 只记在结论上：情景是发生过的事，没有人在复述它——给它 +1 等于把"我又提了一次"
// 算成"它发生得更多"，那是两件事。
// 盘上不覆盖旧行（AGENTS 五）：追加同 id 同 at 的副本，readState 取 at 最大的那版、
// at 相同时后写赢，于是读出来就是同一条记录换了 seen，原行逐字不动。
import path from 'node:path'

import { show } from '../memory/index.mjs'
import { appendJsonl } from '../store/index.mjs'

import { nowOf, requireHome } from './build.mjs'

// design §3：memory.jsonl 就在数据目录根上，不分片。
function memoryFile(home) {
  return path.join(home, 'memory.jsonl')
}

// retell({home,now,ids}) → 谁记上了、谁没记上、为什么。
// ids 去重：同一个 id 记两次就是 seen +2，而它只在这一屏里被复述了一次。
export function retell(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const retold = []
  const skipped = []
  const failed = []

  for (const id of unique(opts.ids)) {
    const found = show(id, { home: dir, now: at })
    const rec = found.record
    if (rec === null) {
      skipped.push({ id, why: '这条结论已经找不到了：不 +1，也不替它补一条记录' })
      continue
    }
    if (rec.id !== id) {
      skipped.push({ id, why: `这个 id 查到的是槽位「${rec.id}」，不是同一条：只认 id，不猜` })
      continue
    }
    if (rec.to !== null) {
      skipped.push({ id, why: '这条结论已被取代（to 非空）：复述不算在失效版本上' })
      continue
    }
    try {
      appendJsonl(memoryFile(dir), bump(rec))
      retold.push(id)
    } catch (err) {
      // 盘写失败既不能装作记上了，也不该让整个摘要消失：说清哪条没记上，由调用方报出去。
      failed.push({ id, why: `seen 没能落盘：${err && err.message ? err.message : String(err)}` })
    }
  }

  return { retold, skipped, failed }
}

// 副本逐字段抄，不展开成 {...rec}：多一个字段 inspectRecord 会当坏行跳过（FIELDS 是白名单），
// 那这条记录下次读出来就凭空消失了——抄全字段比抄得短要紧。
function bump(rec) {
  return {
    id: rec.id,
    at: rec.at,
    key: rec.key,
    fact: rec.fact,
    imp: rec.imp,
    from: rec.from,
    to: rec.to,
    by: rec.by,
    evidence: { ids: [...rec.evidence.ids], from: rec.evidence.from, to: rec.evidence.to },
    seen: rec.seen + 1,
  }
}

function unique(ids) {
  const list = Array.isArray(ids) ? ids : []
  const seen = new Set()
  const out = []
  for (const id of list) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
