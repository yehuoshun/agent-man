import { relTime, stamp } from './time.mjs'
import { select } from './budget.mjs'

/**
 * 把事件渲染成一段能直接贴进上下文的 markdown。
 *
 * 两条约束来自参考实现的事故：
 * - 时间现算（relTime），不写死。写死的 "9 小时前" 三天后还是 "9 小时前"。
 * - 行级取舍，不在句子中间切。只有 "整块只剩一条且它自己就超预算" 时才切，
 *   切在句末，留 "…"，并且统计里记一笔。
 */
export function renderDigest(events, { budget = 1200, now = Date.now(), title = '我记得的事' } = {}) {
  const sel = select(events, { budget })
  const noRoom = sel.drops.filter((d) => d.why === 'no-room').length
  const cutoff = sel.drops.filter((d) => d.why === 'truncated').length
  const kept = sel.pinned.length + sel.recent.length

  const out = [
    `# ${title}`,
    `<!-- agent-man · 共 ${events.length} 条，取 ${kept} 条 · 预算 ${sel.budget} · ` +
      `实占 ${sel.used} · 丢 ${noRoom} · 截 ${cutoff} · ${stamp(now)} -->`,
  ]

  if (!events.length) {
    out.push('', '- （还没有任何记录）')
  } else {
    block(out, '不会忘的', sel.pinned, now)
    block(out, '最近', sel.recent, now)
  }

  return {
    text: out.join('\n') + '\n',
    stats: {
      total: events.length,
      kept,
      used: sel.used,
      budget: sel.budget,
      noRoom,
      cutoff,
      drops: sel.drops,
    },
  }
}

function block(out, heading, items, now) {
  out.push('', `## ${heading}`)
  if (!items.length) {
    out.push('- （还没有）')
    return
  }
  for (const e of items) {
    const feel = e.feel ? `（${e.feel}）` : ''
    out.push(`- ${relTime(e.at, { now })} · ${e.fact}${feel}`)
  }
}
