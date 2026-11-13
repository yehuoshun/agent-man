// 零件门面：在 PATH 上找 `agent-man-<名字>`、调它、记它的连续失败。
// 上游只从这里拿东西（AGENTS §四：跨目录只准 import 门面）。
export { scan, describe } from './discover.mjs'
export { passthrough, capture } from './call.mjs'

// §10 PART_FAIL_LIMIT。与 core 落地前的其它常数一样，先在这里声明。
const PART_FAIL_LIMIT = 3

// 连续失败计数。第 3 次失败把 until 设成 Infinity：那是"下一次会话"的哨兵，由调用方在
// 会话开始时把计数清零（{fail:0, until:null}），这里不认识时钟，也不自己解除。
// 注意 JSON 里没有 Infinity（写进 meta.json 会变成 null），所以别指望它持久化——哨兵本来就
// 只活一个会话。
export function bump(entry) {
  const prev = entry ?? {}
  const fail = (Number.isFinite(prev.fail) ? prev.fail : 0) + 1
  return { ...prev, fail, until: fail >= PART_FAIL_LIMIT ? Infinity : (prev.until ?? null) }
}

// 现在还能不能去掉这个能力：冷却到某个时刻（数字）或冷却到下一次会话（Infinity）。
export function blocked(entry, now) {
  const until = entry?.until
  if (until === Infinity) return true
  if (!Number.isFinite(until)) return false // null / undefined / NaN：没在冷却
  return until > now
}
