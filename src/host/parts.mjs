// 注入侧的零件（design §9）：在期限之内问一遍 PATH，把答话交给处境块的「建议」段。
// 与 CLI 那一条屏的分工：这边有人在等（首步注入要赶在人开口之前到），所以给死期限；
// 那边没人赶时间，sense 不给 deadline 就一个一个问到底（§8 的两种模式因此不串味）。
import { PARTS_INJECT_COST, PART_DEADLINE, config } from '../core/index.mjs'
import { openLedger, sense } from '../parts/index.mjs'

// 一次问遍：把 sense 的账翻成注入能用的三件事——行、警告、以及"为什么没有那一行"。
// 注入这一侧只有 warnings 会上屏（§8 的"注入一行降级"），所以每个没上屏的原因都要在
// 这里翻成一句 `! `：sense 只出账（dropped / failures 各带一句 why），谁上屏谁说话。
// 永远不抛：零件这一路坏掉只该降级成"这次没有建议"，不能把首步注入整体拖没了。
export async function askParts(env, options = {}) {
  const o = options ?? {}
  const budget = Number.isFinite(o.budget) && o.budget >= 0 ? o.budget : PARTS_INJECT_COST
  const deadline = Number.isFinite(o.deadline) && o.deadline >= 0 ? o.deadline : PART_DEADLINE
  // 零件在零件里（design §8）：这次注入是某个零件发起的，就一个零件都不问——问下去只会套娃到期限。
  // 与 CLI 那两个出口同一把护栏，也同一句说明（零件自己看得见这行）。
  if (env?.[config.PART_CALL_ENV] === '1') {
    return degraded(budget, deadline,
      `! 零件在零件里：这次不问零件（${config.PART_CALL_ENV}=1，防无限套娃）`)
  }
  // 冷却账住 状态水位文件（§4）：没有 home 就只在这次进程里记，不写盘——注入不该因为
  // 数据目录还没建就变成"能问但不记账"的假象，所以宁可这一趟不记。
  const ledger = o.home ? openLedger(o.home) : null
  let got
  try {
    got = await sense(env, {
      budget,
      deadline,
      deps: o.deps,
      ledger,
      now: o.now,
      timeout: o.timeout,
      timeoutMax: o.timeoutMax,
      stdoutMax: o.stdoutMax,
      failLimit: o.failLimit,
    })
  } catch (e) {
    return degraded(budget, deadline, `! 零件这次没问成（${messageOf(e)}）：注入里不带建议`)
  }

  const warnings = [...got.warnings]
  for (const one of got.dropped) warnings.push(`! ${one.why}`)
  for (const one of got.failures) warnings.push(`! ${one.why}：这次不带它`)
  return {
    lines: got.lines,
    used: got.used,
    budget,
    deadline,
    warnings,
    dropped: got.dropped,
    failures: got.failures,
  }
}

function degraded(budget, deadline, why) {
  return { lines: [], used: 0, budget, deadline, warnings: [why], dropped: [], failures: [] }
}

function messageOf(e) {
  return e && e.message ? e.message : String(e)
}
