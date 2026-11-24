// 零件冷却账本（design §8）：连续失败到上限就冷却到下一次会话，账记在 `state/` 下那份水位文件的
// `parts` 键里（形状见 design §4，doctor 按那个形状体检）。
// 这里只管"账怎么记、怎么读"，sense 只认 get / mark / reset 三个函数——所以冷却逻辑
// 可以拿假账本测，不必每跑一次测试就往真 home 里写文件。
import { PART_COOLDOWN, PART_FAIL_LIMIT } from '../core/index.mjs'
import { ensure, metaFile, readJson, writeAtomic } from '../store/index.mjs'

// 连续失败计数。攒到上限就冷却：`until` 写成"最后那次失败 + PART_COOLDOWN"，记 `at` 是为了
// 让这份账过一遍 JSON 还认得出来（JSON 没有 Infinity，写下去就变成 null）。
// 传了 `now` 就是时间冷却；没传（老调用方、或不想认时钟）退回 Infinity 哨兵，
// 那种哨兵只由"会话开始清零"解除——见 §8"冷却到下一次会话"。
export function bump(entry, limit = PART_FAIL_LIMIT, now = null) {
  const prev = entry ?? {}
  const cap = Number.isFinite(limit) && limit >= 1 ? limit : PART_FAIL_LIMIT
  const fail = (Number.isFinite(prev.fail) ? prev.fail : 0) + 1
  const at = Number.isFinite(now) ? now : (Number.isFinite(prev.at) ? prev.at : null)
  let until = prev.until ?? null
  if (fail >= cap) until = Number.isFinite(now) ? now + PART_COOLDOWN : Infinity
  return { ...prev, fail, until, at }
}

// 现在还能不能去掉这个能力。三种冷却：
// ① `until` 是数字——还没到点就摘着，到点自己解除（CLI 一侧唯一的自愈路径）。
// ② `until` 是 Infinity——哨兵，只有会话开始清零能解除。
// ③ `until` 是 null 但计数到上限——那是 Infinity 过了一遍 JSON；靠 `at + PART_COOLDOWN`
// 自愈，没有 `at` 就仍然按哨兵算（旧的落盘记录，宁可多摘一轮也别把坏零件放回来）。
export function blocked(entry, now, limit = PART_FAIL_LIMIT) {
  const cap = Number.isFinite(limit) && limit >= 1 ? limit : PART_FAIL_LIMIT
  const until = entry?.until
  if (Number.isFinite(until)) return until > now
  if (until === Infinity) return true
  const fail = Number.isFinite(entry?.fail) ? entry.fail : 0
  if (fail < cap) return false
  const at = entry?.at
  if (!Number.isFinite(at)) return true
  return now - at < PART_COOLDOWN
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
    // 会话开始清一次账（§8"冷却到下一次会话"）：宿主一次进程就是一次会话，开机时把每个零件
    // 都放回"还没失败过"，坏零件在新会话里重新有一次机会。没有记录就一个字节都不写。
    async clearAll() {
      const parts = partsOf(readDoc(homeDir))
      const names = Object.keys(parts)
      if (names.length === 0) return null
      const clean = names.every((name) => {
        const one = parts[name]
        return Number.isFinite(one?.fail) && one.fail === 0 && one.until === null
      })
      if (clean) return null
      ensure(homeDir)
      const doc = readDoc(homeDir)
      await writeAtomic(metaFile(homeDir), `${JSON.stringify({ ...doc, parts: {} }, null, 2)}\n`)
      return null
    },
  }
}
