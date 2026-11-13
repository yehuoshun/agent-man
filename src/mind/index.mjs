// mind 的门面：处境（situation）、欠账（debt）、开口门（gate），
// 外加一页给宿主用的简报。简报只拼数据、不渲染——排版是 view 的事（design §7）。
import { config, now } from '../core/index.mjs'
import { state as debtState } from './debt.mjs'
import { judge } from './gate.mjs'
import { situation } from './situation.mjs'

export { build, situation } from './situation.mjs'
export * as debt from './debt.mjs'
export * as gate from './gate.mjs'

// 一次把事情看全：现在几点、该不该说话、为什么、摆得上屏的处境是哪些、账上压着什么。
// 配置只解析一次往下递（§15），坏行与坏配置的提醒都收在 warnings 里，等上层打 "! "。
export function brief(homeDir, options = {}) {
  const input = typeof homeDir === 'string' ? { ...options, home: homeDir } : { ...homeDir }
  const home = input.home
  if (typeof home !== 'string' || home === '') {
    throw new TypeError('简报要知道家在哪：brief(home, { now }) 或 brief({ home, now })')
  }
  const at = Number.isFinite(input.now) ? input.now : now()
  const warnings = []
  const cfg = input.cfg ?? config.load({ homeDir: home, now: at, warn: (m) => warnings.push(m) })
  const debts = input.debts ?? debtState(home, { now: at, cfg })
  const scene = situation(home, { now: at, budget: input.budget, cfg, debts, parts: input.parts })
  const verdict = judge(home, {
    now: at,
    cfg,
    debts,
    minGap: input.minGap,
    quiet: input.quiet,
    force: input.force,
  })
  return {
    at,
    say: verdict.say,
    why: verdict.why,
    situation: scene,
    debt: debts,
    gate: verdict,
    warnings: [...new Set([...warnings, ...scene.warnings, ...verdict.warnings])],
  }
}
