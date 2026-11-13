// 聚合模式（design §8）：一次问遍 PATH 上的零件，把它们的回答拼进那一屏，**不落盘**。
// 与直通模式的分工：直通是 `agent-man <名字> …`，stdio 直接给人；聚合是把结果当材料用，
// 所以要过预算、要截断、要记谁没答上来——但绝不替零件做主，也不把它的输出当成结论。
import { LINE_OVERHEAD, PART_TIMEOUT, cost } from '../core/index.mjs'
import { capture as realCapture } from './call.mjs'
import { describe as realDescribe, scan as realScan } from './discover.mjs'

// 一行零件回答的预算口径与 recall 一致：能写字的地方是 budget - LINE_OVERHEAD。
// 一个零件只出一行：多行要么是它没按契约做（stdout 只放结果），要么该走直通模式。
function oneLine(text) {
  const folded = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return folded.join(' ')
}

// 失败分类交给上游（§8：连续 3 次才冷却），这里只把"这次没答上来"如实带出去。
function failed(r) {
  return r.status === 'crash' || r.status === 'timeout' || r.status === 'missing'
}

export async function sense(env = process.env, opts = {}) {
  const o = opts ?? {}
  const budget = Number.isFinite(o.budget) && o.budget >= 0 ? o.budget : 550
  const deps = {
    scan: o.deps?.scan ?? realScan,
    describe: o.deps?.describe ?? realDescribe,
    capture: o.deps?.capture ?? realCapture,
  }
  const parts = Array.isArray(o.parts) ? o.parts : deps.scan(env)
  const lines = []
  const warnings = []
  const dropped = []
  const failures = []
  let used = 0

  // 顺序 = scan 的顺序（按名字码位排）。并行在这里没有好处：一次屏幕一份钱，
  // 串行还能让"预算用在哪几个零件上"这件事可复现。
  for (const part of parts) {
    const seen = await deps.describe(part, { env })
    if (!seen.ok) {
      warnings.push(`! ${seen.why}`)
      failures.push({ name: part.name, why: seen.why })
      continue
    }
    const r = await deps.capture(part, { args: [], timeout: seen.timeout_ms ?? PART_TIMEOUT, env })
    if (failed(r)) {
      const why = r.status === 'timeout' ? `${part.name} 超时（超过 ${r.timeout ?? PART_TIMEOUT}ms）` : `${part.name} 起不来`
      warnings.push(`! ${why}`)
      failures.push({ name: part.name, why })
      continue
    }
    const text = oneLine(r.out)
    if (!text) {
      if (r.err.trim()) warnings.push(`! ${part.name} 只在 stderr 说了话，没有结果`)
      continue
    }
    const line = { name: part.name, section: seen.section, text }
    const price = cost(text) + LINE_OVERHEAD
    if (used + price > budget) {
      // 装不下就明确丢，并说清是预算的问题——不是零件坏了。
      dropped.push({ name: part.name, reason: 'budget' })
      continue
    }
    used += price
    lines.push(line)
    if (r.truncated) warnings.push(`! ${part.name} 的输出超过 8KB，已截断`)
  }

  return { lines, used, budget, warnings, dropped, failures }
}
