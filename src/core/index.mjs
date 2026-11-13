// core 门面：上层只准 import 这里（AGENTS 四）。time / cost / text 都是纯函数，
// 不碰文件、不碰进程，所以能放心被任何一个模块依赖。
export { now, dayKey, monthKey, clock, rel, parseWhen } from './time.mjs'
export { cost, cut, oneLine } from './cost.mjs'
export { tokens, jaccard } from './text.mjs'

// §10 的常数只从这一处出：哪层需要一个数，就从门面拿，别在本地再写一遍。
export {
  COST_ASCII, COST_WIDE, LINE_OVERHEAD,
  EVENTS_MAX, MEMORY_MAX, RULE_MAX, SELF_MAX,
  S0_EVENT, S0_MEMORY, S0_RULE,
  SCORE_R, SCORE_CUE,
  SHARE_MEMORY, SHARE_EVENTS,
  DIGEST_BUDGET, INJECT_BUDGET,
  DEFAULT_WINDOW_DAYS, NOTE_TTL, CUE_MIN_GAP, DEBT_STALE, QUIET,
  RULE_LIMIT, JUDGE_KEEP, CLUSTER_HITS, CLUSTER_DAYS, DEBT_SUM_IMP, DEBT_UNREFLECTED,
  SECTION_ITEMS_MAX, SECTION_MAX, MIN_KEEP_RATIO, MIN_KEEP_COST,
  PART_TIMEOUT, PART_TIMEOUT_MAX, PART_STDOUT_MAX, PART_FAIL_LIMIT,
  AUDIT_LIMIT, TRACE_KEEP_MONTHS,
} from './const.mjs'
