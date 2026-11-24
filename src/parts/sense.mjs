// 聚合模式（design §8）：一次问遍 PATH 上的零件，把它们的回答拼进那一屏，**不落盘**。
// 与直通模式的分工：直通是 `agent-man <名字> …`，stdio 直接给人；聚合是把结果当材料用，
// 所以要过预算、要截断、要记谁没答上来——但绝不替零件做主，也不把它的输出当成结论。
// 唯一会写盘的是"零件坏了的冷却账"（§8 连续三次失败就摘掉），那份账由调用方给的 ledger 落。
import { performance } from 'node:perf_hooks'

import {
  LINE_OVERHEAD,
  PART_FAIL_LIMIT,
  PART_STDOUT_MAX,
  PART_TIMEOUT,
  PART_TIMEOUT_MAX,
  cost,
} from '../core/index.mjs'
import { capture as realCapture } from './call.mjs'
import { describe as realDescribe, scan as realScan } from './discover.mjs'
import { blocked, bump } from './ledger.mjs'

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

function whyOf(part, r) {
  if (r.status === 'timeout') return `${part.name} 超时（超过 ${r.timeout ?? PART_TIMEOUT}ms）`
  return `${part.name} 起不来`
}

// 期限的倒数：只管"还剩多少毫秒"，用单调时钟——墙钟被对时、被夏令时拽一下，
// 这件事不该跟着变（core/time 解释的是墙钟，这里量的是间隔，所以不走它）。
function countdown(ms) {
  const start = performance.now()
  return () => Math.floor(ms - (performance.now() - start))
}

// 拿去 capture 的时间不许是个位数毫秒：给得太短，进程还没来得及起来就被判超时，
// 那就成了"我们没等"却要靠另一句判断才不至于记成零件坏。留一个地板，
// 代价是最多多等这么久（上界仍是 deadline + 地板，不会滚成 deadline×N）。
const MIN_CAPTURE_MS = 50

// 期限到没到。串行（不限时）时 left() 恒为 null，永远没到。
function outOf(left) {
  const rest = left()
  return rest !== null && rest <= 0
}

function pickMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// 问一个零件：先 --describe 认契约，再 capture 拿答话。
// 这里只记"发生了什么"，钱怎么花、谁上屏留给 assemble——串行与并行因此拿同一份账，不会分叉。
async function askOnce(part, env, deps, left, limits) {
  if (outOf(left)) return { part, out: 'deadline' }
  const forDesc = left()
  const seen = await deps.describe(part, forDesc === null
    ? { env: env ?? {}, ...limits }
    : { env: env ?? {}, ...limits, timeout: Math.min(limits.timeout, forDesc) })
  if (!seen.ok) {
    // 期限把我们截断的，说"到期限"而不是怪零件 --describe 崩了：这两件事的下一步不一样。
    if (outOf(left)) return { part, out: 'deadline' }
    return { part, out: 'failed', why: seen.why }
  }
  if (outOf(left)) return { part, out: 'deadline' }
  // capture 的 timeout 是**剩余时间**（零件自己声明的只用来封顶）：它到点硬杀，
  // 所以"总等待 ≤ deadline"不靠外面再包一层竞速，也不会留下没人收的进程。
  const rest = left()
  const declared = seen.timeout_ms ?? limits.timeout
  const waitMs = rest === null ? declared : Math.min(declared, Math.max(rest, MIN_CAPTURE_MS))
  const r = await deps.capture(part, {
    args: [],
    timeout: waitMs,
    env,
    timeoutMax: limits.timeoutMax,
    limit: limits.stdoutMax,
  })
  if (failed(r)) {
    // capture 超时、期限也用完了：是我们没等，不是零件坏——不许把它算进"零件不行"的账。
    if (r.status === 'timeout' && outOf(left)) return { part, out: 'deadline' }
    return { part, out: 'failed', why: whyOf(part, r) }
  }
  return { part, out: 'ok', seen, r }
}

async function askInTurn(env, parts, deps, left, limits) {
  const asked = []
  for (const part of parts) asked.push(await askOnce(part, env, deps, left, limits))
  return asked
}

// 把钱算在收齐之后：顺序 = scan 的顺序（并行时"谁先答话"不许影响屏上的次序），
// 预算也就可复现——同样的零件集合，同样的那几个上屏。
// 每一种"没上屏"都要留一条带 `why` 的记录，但**只记一次**：谁上屏谁负责说一句话。
// 早先这里把同一句同时塞进 warnings 与 failures，两个出口各打一遍，屏上就出现双份。
function assemble(asked, budget, limit, stdoutMax) {
  const lines = []
  const warnings = []
  const dropped = []
  const failures = []
  let used = 0

  for (const one of asked) {
    const name = one.part.name
    if (one.out === 'deadline') {
      // 到点没答上来：记进 dropped，也不进 failures——"我们没等"与"零件坏了"在 §8 里的
      // 后果不一样（后者才攒冷却）。
      const why = `${name} 到 ${limit}ms 的期限还没答上来：这次不用它的答话`
      dropped.push({ name, reason: 'deadline', why })
      continue
    }
    if (one.out === 'failed') {
      failures.push({ name, why: one.why })
      continue
    }
    const text = oneLine(one.r.out)
    if (!text) {
      const heard = one.r.err.trim()
      dropped.push({
        name,
        reason: 'empty',
        why: heard ? `${name} 只在 stderr 说了话，没有结果` : `${name} 什么也没说（stdout 空）`,
      })
      continue
    }
    const price = cost(text) + LINE_OVERHEAD
    if (used + price > budget) {
      // 装不下就明确丢，并说清是预算的问题——不是零件坏了。
      dropped.push({
        name,
        reason: 'budget',
        why: `${name} 的答话要 ${price.toFixed(1)} cost，装不进零件预算 ${budget}`,
      })
      continue
    }
    used += price
    lines.push({ name, section: one.seen.section, text })
    if (one.r.truncated) warnings.push(`! ${name} 的输出超过 ${stdoutMax} 字节，已截断`)
  }

  return { lines, used, budget, warnings, dropped, failures }
}

// 环境变量对象由调用方给：结构用例只许 core/config.mjs 与 cli/main.mjs 自己去摸它。
// limits 里的四个数都来自配置（`parts.*`），调用方读、这里只认数字——core/config 之外
// 谁都不该去翻配置文件。
export async function sense(env, opts = {}) {
  const o = opts ?? {}
  const budget = Number.isFinite(o.budget) && o.budget >= 0 ? o.budget : 550
  const limits = {
    timeout: pickMs(o.timeout, PART_TIMEOUT),
    timeoutMax: pickMs(o.timeoutMax, PART_TIMEOUT_MAX),
    stdoutMax: pickMs(o.stdoutMax, PART_STDOUT_MAX),
  }
  const failLimit = pickMs(o.failLimit, PART_FAIL_LIMIT)
  const ledger = o.ledger ?? null
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const deps = {
    scan: o.deps?.scan ?? realScan,
    describe: o.deps?.describe ?? realDescribe,
    capture: o.deps?.capture ?? realCapture,
  }

  const wanted = Array.isArray(o.parts) ? o.parts : deps.scan(env ?? {})
  // 冷却中的零件连问都不问（§8：连续三次失败就摘掉这个能力，别每屏再 spawn 两次）。
  // 它照样进账：屏上要知道"这个能力被摘了"，不然看起来就像 PATH 上从来没有它。
  const cooled = []
  const parts = []
  for (const part of wanted) {
    const entry = ledger ? ledger.get(part.name) : null
    if (ledger && blocked(entry, now, failLimit)) cooled.push({ part, entry })
    else parts.push(part)
  }

  // 给了 deadline 就并行问、总等待不超过它（首步注入赶在人开口之前，等不起 PART_TIMEOUT×N）；
  // 不给就一个一个问到底——CLI 那一屏没人赶时间，多等一会儿换来的是"谁答过话"不打折。
  // deadline 0 是"一个都不等"，不是"不设上限"：上限就是 PART_TIMEOUT×N，那正是这里要避开的。
  const limit = Number.isFinite(o.deadline) && o.deadline >= 0 ? o.deadline : null
  const left = limit === null ? () => null : countdown(limit)
  const asked = limit === null
    ? await askInTurn(env, parts, deps, left, limits)
    : await Promise.all(parts.map((part) => askOnce(part, env, deps, left, limits)))

  const scene = assemble(asked, budget, limit, limits.stdoutMax)
  const rows = cooled.map(({ part, entry }) => ({
    name: part.name,
    reason: 'cooldown',
    why: `${part.name} 连续失败 ${Number.isFinite(entry?.fail) ? entry.fail : failLimit} 次，`
      + '这次不问（冷却到下一次会话）',
  }))

  if (ledger) {
    for (const one of asked) {
      // 成功一次就清零：连续失败说的是"连着"，中间答上来一次就该从头数。
      if (one.out === 'ok') await ledger.reset(one.part.name)
      if (one.out === 'failed') await ledger.mark(one.part.name, bump(ledger.get(one.part.name), failLimit))
    }
  }

  return { ...scene, dropped: [...rows, ...scene.dropped] }
}
