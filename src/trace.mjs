/**
 * 账本：每次真的渲染出一份摘要，就落一行"这次装下了什么、丢了什么"。
 *
 * 为什么需要它（docs/decisions.md §9(d)）：以前只有 stdout 和那行统计注释。
 * 预算 60 时 pinned 被 recent 挤掉——这种事只在 stderr 里出现过一次，
 * 终端一关就没了，于是"要不要给保底一条"只能拍脑袋决定。
 * 账本不加任何判断，它只让判断有据可依。
 *
 * 三条自我约束：
 * - 不写原文。trace 是账不是备份；原文还在 events.jsonl，按 at 对一下就有。
 *   把 fact 抄进来，一份库就有两个会不一致的副本。
 * - 只记数字与 id，字段名短。账本会随次数线性变长。
 * - 记的是"渲染过"，不是"模型读了"。中间那一步在模型侧，零件看不见，
 *   所以别把 trace 当成"用户看过"的证据。
 */

/**
 * 从 renderDigest 的 stats 抽出一行账。
 * 纯函数：不看时钟、不碰文件（时间从 now 进来）。
 */
export function buildTrace(stats, { now, cmd = 'digest' } = {}) {
  return {
    at: now,
    cmd,
    budget: stats.budget,
    used: stats.used,
    keptAt: [...(stats.keptAt ?? [])],
    merged: stats.merged ?? 0,
    drops: (stats.drops ?? []).map((d) => ({ at: d.at, why: d.why, weight: d.weight ?? 0 })),
    longKept: [...(stats.longKeptIds ?? [])],
    longDrops: (stats.longDrops ?? []).map((d) => d.id ?? d.topic),
  }
}

/**
 * 从来没进过任何一次摘要的日记。
 *
 * 这是账本唯一能回答、别的零件都答不了的问题。注意它审的是"摘要"，
 * 不是"日记写得好不好"：一条被丢了一百次的事，可能恰恰是最该提的那条。
 */
export function neverShown(events, traces) {
  const seen = new Set()
  for (const t of traces) {
    for (const at of t.keptAt ?? []) seen.add(at)
  }
  return events.filter((e) => !seen.has(e.at))
}

/** 一行账的人话版（数字是给人看的，别在调用方再拼一遍）。 */
export function traceLine(t) {
  const drops = t.drops ?? []
  const gone = drops.filter((d) => d.why === 'no-room').length
  const merged = drops.filter((d) => d.why === 'dup').length
  const cut = drops.length - gone - merged // 合掉的不算"截"，两回事
  const long = t.longKept?.length ? ` · 长期 ${t.longKept.length}` : ''
  const dup = merged ? ` · 合 ${merged}` : ''
  return (
    `预算 ${t.budget} · 用 ${t.used} · 取 ${t.keptAt?.length ?? 0}${long}` +
    ` · 丢 ${gone} · 截 ${cut}${dup}`
  )
}
