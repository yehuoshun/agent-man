// 零件冷却账本（design §8）：连续失败到上限就冷却到下一次会话，账记在 `state/` 下那份水位文件的
// `parts` 键里（形状见 design §4，doctor 按那个形状体检）。
// 这里只管"账怎么记、怎么读"，sense 只认 get / mark / reset 三个函数——所以冷却逻辑
// 可以拿假账本测，不必每跑一次测试就往真 home 里写文件。
import { PART_FAIL_LIMIT } from '../core/index.mjs'
import { ensure, metaFile, readJson, writeAtomic } from '../store/index.mjs'

// 连续失败计数。攒到上限把 until 设成 Infinity：那是"下一次会话"的哨兵，
// 由调用方在会话开始时把计数清零（reset → {fail:0, until:null}），这里不认识时钟，也不自己解除。
// 注意 JSON 里没有 Infinity（写进水位文件会变成 null），所以别指望它原样持久化——
// blocked 认得出"null + 计数到上限"就是还没解除的哨兵。
export function bump(entry, limit = PART_FAIL_LIMIT) {
  const prev = entry ?? {}
  const cap = Number.isFinite(limit) && limit >= 1 ? limit : PART_FAIL_LIMIT
  const fail = (Number.isFinite(prev.fail) ? prev.fail : 0) + 1
  return { ...prev, fail, until: fail >= cap ? Infinity : (prev.until ?? null) }
}

// 现在还能不能去掉这个能力：冷却到某个时刻（数字）或冷却到下一次会话（Infinity）。
export function blocked(entry, now, limit = PART_FAIL_LIMIT) {
  const cap = Number.isFinite(limit) && limit >= 1 ? limit : PART_FAIL_LIMIT
  const until = entry?.until
  if (until === Infinity) return true
  if (!Number.isFinite(until)) {
    // 数字之外的 until 有两种来路：真的是 null（没在冷却，调用方刚清零），或者哨兵
    // Infinity 写进 JSON 又读回来变成了 null。后者要是当成"没在冷却"，连续三次失败攒下的
    // 冷却就被一次落盘悄悄抹掉了。只认计数：到上限就是还在冷却，清零过的自然回到 0。
    return (Number.isFinite(entry?.fail) ? entry.fail : 0) >= cap
  }
  return until > now
}

// 读整份账。坏水位文件当"还没有账"：读不动的时候装作没冷却比装作全冷却安全
// （否则一次文件损坏就把所有零件永久摘掉，而用户没法从屏上看出是哪个文件坏了）。
function readDoc(homeDir) {
  const doc = readJson(metaFile(homeDir))
  if (doc === null || doc.__bad === true) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) return {}
  return doc
}

function partsOf(doc) {
  const parts = doc?.parts
  if (parts && typeof parts === 'object' && !Array.isArray(parts)) return parts
  return {}
}

// 全部零件记录（只读）。
export function records(homeDir) {
  return partsOf(readDoc(homeDir))
}

// 写一条记录：那份文件里还有水位、债务、峰值，所以只能读-改-写整份，
// 不能只写 parts 那一块（那会把别人刚写的键抹掉）。
async function put(homeDir, name, entry) {
  if (!homeDir) return
  const doc = readDoc(homeDir)
  const parts = { ...partsOf(doc), [name]: entry }
  ensure(homeDir)
  await writeAtomic(metaFile(homeDir), `${JSON.stringify({ ...doc, parts }, null, 2)}\n`)
}

// 文件账本：给 sense / askParts 用的三个函数。
// 健康的零件一次都不写盘（读命令不该因为问了一圈零件就改盘上的东西）；
// 只有"失败计数变了"和"从坏变好、需要清零"这两种情况才落一次。
export function openLedger(homeDir) {
  return {
    get(name) {
      return partsOf(readDoc(homeDir))[name] ?? null
    },
    async mark(name, entry) {
      await put(homeDir, name, entry)
    },
    async reset(name) {
      const prev = partsOf(readDoc(homeDir))[name]
      if (!prev) return null
      if (Number.isFinite(prev.fail) && prev.fail === 0 && prev.until === null) return null
      await put(homeDir, name, { fail: 0, until: null })
      return null
    },
  }
}
