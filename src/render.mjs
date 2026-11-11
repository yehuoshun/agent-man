import { relTime, stamp } from './time.mjs'
import { cost } from './cost.mjs'
import { select } from './budget.mjs'

/**
 * 把事件渲染成一段能直接贴进上下文的 markdown。
 *
 * 两条约束来自参考实现的事故：
 * - 时间现算（relTime），不写死。写死的 "9 小时前" 三天后还是 "9 小时前"。
 * - 行级取舍，不在句子中间切。只有 "整块只剩一条且它自己就超预算" 时才切，
 *   切在句末，留 "…"，并且统计里记一笔。
 *
 * 第三条是本文件自己的事故：预算只算了条目，没算标题和统计注释。
 * 实测预算 120 时全文 137、预算 30 时全文 53——承诺"永不超支"，实际超了 17~23。
 * 所以现在整段文本的代价都要落进预算，靠 fit() 两轮夹逼。
 */

// 头部形态由奢到简：放不下就降级，而不是让总代价悄悄超出去。
const FULL = 'full'
const COMPACT = 'compact'
const BARE = 'bare'
const TITLE_ONLY = 'title-only'

export function renderDigest(events, { budget = 1200, now = Date.now(), title = '我记得的事' } = {}) {
  if (!(budget > 0)) throw new Error(`预算必须为正: ${budget}`)

  let r = fit(events, { budget, now, title, form: FULL })
  if (r.total > budget) r = fit(events, { budget, now, title, form: COMPACT })
  if (r.total > budget) r = fit(events, { budget, now, title, form: BARE })
  if (r.total > budget) r = fit(events, { budget, now, title, form: TITLE_ONLY })

  return {
    text: r.text,
    stats: {
      ...r.stats,
      // 实占是整段文本的代价，不是条目的代价——这正是以前漏账的地方。
      used: r.total,
      over: Math.max(0, r.total - budget),
    },
  }
}

/**
 * 固定骨架不参与 select，所以从满额试起：超多少就从条目额度里扣掉再渲一遍。
 * 每轮只减不增，不会来回振荡；实测两轮收敛。
 */
function fit(events, { budget, now, title, form }) {
  let allow = budget
  let r = renderOnce(events, { allow, now, title, form, budget })
  for (let i = 0; i < 4 && r.total > budget; i++) {
    allow = Math.max(0, allow - (r.total - budget))
    r = renderOnce(events, { allow, now, title, form, budget })
  }
  return r
}

function renderOnce(events, { allow, now, title, form, budget }) {
  const sel = allow >= 1 ? select(events, { budget: allow }) : nothingFits(events)
  const noRoom = sel.drops.filter((d) => d.why === 'no-room').length
  const cutoff = sel.drops.filter((d) => d.why === 'truncated').length
  const kept = sel.pinned.length + sel.recent.length

  const out = [`# ${title}`]
  if (form === FULL) {
    out.push(
      `<!-- agent-man · 共 ${events.length} 条，取 ${kept} 条 · 预算 ${budget} · ` +
        `条目 ${sel.used} · 丢 ${noRoom} · 截 ${cutoff} · ${stamp(now)} -->`,
    )
  } else if (form === COMPACT) {
    out.push(`<!-- 共 ${events.length} · 取 ${kept} · 丢 ${noRoom} · 截 ${cutoff} -->`)
  }

  if (form !== TITLE_ONLY) {
    if (!events.length) {
      out.push('', '- （还没有任何记录）')
    } else {
      block(out, '不会忘的', sel.pinned, now)
      block(out, '最近', sel.recent, now)
    }
  }

  const text = out.join('\n') + '\n'
  return {
    text,
    total: cost(text),
    stats: {
      total: events.length,
      kept,
      entries: sel.used,
      budget,
      noRoom,
      cutoff,
      drops: sel.drops,
    },
  }
}

/** 一点额度都不剩时：条目全记成 no-room，报账仍然是诚实的。 */
function nothingFits(events) {
  return { pinned: [], recent: [], used: 0, drops: events.map((e) => ({ ...e, why: 'no-room' })) }
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
