// 零件门面：在 PATH 上找 `agent-man-<名字>`、调它、记它的连续失败。
// 上游只从这里拿东西（AGENTS §四：跨目录只准 import 门面）。
export { scan, describe } from './discover.mjs'
export { passthrough, capture } from './call.mjs'

// §10 的常数只从 core 门面取（唯一来源），这里不再留副本。
import { PART_FAIL_LIMIT } from '../core/index.mjs'

// 连续失败计数。第 3 次失败把 until 设成 Infinity：那是"下一次会话"的哨兵，由调用方在
// 会话开始时把计数清零（{fail:0, until:null}），这里不认识时钟，也不自己解除。
// 注意 JSON 里没有 Infinity（写进 meta.json 会变成 null），所以别指望它原样持久化——
// blocked 认得出"null + 计数到上限"就是还没解除的哨兵，见那里。
export function bump(entry) {
  const prev = entry ?? {}
  const fail = (Number.isFinite(prev.fail) ? prev.fail : 0) + 1
  return { ...prev, fail, until: fail >= PART_FAIL_LIMIT ? Infinity : (prev.until ?? null) }
}

// 现在还能不能去掉这个能力：冷却到某个时刻（数字）或冷却到下一次会话（Infinity）。
export function blocked(entry, now) {
  const until = entry?.until
  if (until === Infinity) return true
  if (!Number.isFinite(until)) {
    // 数字之外的 until 有两种来路：真的是 null（没在冷却，调用方刚清零），或者哨兵
    // Infinity 写进 JSON 又读回来变成了 null。后者要是当成"没在冷却"，连续三次失败攒下的
    // 冷却就被一次落盘悄悄抹掉了。只认计数：到上限就是还在冷却，清零过的自然回到 0。
    return (Number.isFinite(entry?.fail) ? entry.fail : 0) >= PART_FAIL_LIMIT
  }
  return until > now
}
