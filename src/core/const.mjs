// design §10 的常数只此一份。理由不是"好看"：预算是本项目对用户的硬承诺（AGENTS 二·1），
// 而 0.28、1200、6h 这些数字一旦在各层各抄一遍，改动时总会漏掉一处；
// 漏掉的那处不会报错，只会让"装得下"变成一句谎话。
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// —— 成本（core/cost 的权重；别的层别再写 0.28）——
export const COST_ASCII = 0.28 // 每个半角字符
export const COST_WIDE = 1.0 // 每个全角字符 / emoji
export const LINE_OVERHEAD = 8 // 每条记录的行开销（cost，不是字符）

// —— 单条上限（cost；超了拒绝并让用户拆条，design §4）——
export const EVENTS_MAX = 400
export const MEMORY_MAX = 240
export const RULE_MAX = 120
export const SELF_MAX = 600

// —— 保留率的 S0（ms）——
export const S0_EVENT = 3 * DAY // 情景：3 天
export const S0_MEMORY = 30 * DAY // 语义：30 天
// 规矩几乎不衰减（design §2），"∞" 只能用 Infinity 表达；写在这里而不是 recall 里，
// 免得哪天变成了一个大数字，读起来还以为是 10 年。
export const S0_RULE = Infinity

// —— 检索分权重（design §5：0.6·R + 0.4·cue）——
export const SCORE_R = 0.6
export const SCORE_CUE = 0.4

// —— 一屏里记忆与事件的份额 ——
export const SHARE_MEMORY = 0.6
export const SHARE_EVENTS = 0.4

// —— 预算（cost）——
export const DIGEST_BUDGET = 1200
export const INJECT_BUDGET = 1000

// —— 时间窗（天 / ms）——
export const DEFAULT_WINDOW_DAYS = 30 // 天
export const NOTE_TTL = 7 * DAY // ms：便条默认活 7 天
export const CUE_MIN_GAP = 6 * HOUR // ms：两次开口的最小间隔
export const DEBT_STALE = 24 * HOUR // ms：欠账多久算放旧了
// 静默时段用小时数而不是时间戳：它每天循环，落到 ms 反而要在别处再拆一次年月日。
export const QUIET = Object.freeze({ from: 23, to: 8 }) // 本地小时，23 点到次日 8 点

// —— 条数上限（条）——
export const RULE_LIMIT = 20
export const JUDGE_KEEP = 200
export const CLUSTER_HITS = 3
export const CLUSTER_DAYS = 2 // 天
export const DEBT_SUM_IMP = 12
export const DEBT_UNREFLECTED = 40

// —— 一屏的形状（design §1：工作记忆约 4 个组块、一张屏最多 4 段）——
export const SECTION_ITEMS_MAX = 4 // 条：每段最多几条
export const SECTION_MAX = 4 // 段：一屏最多几段
export const MIN_KEEP_RATIO = 0.4 // 超长条目切完至少留原文的多少
export const MIN_KEEP_COST = 32 // cost：切完不足这个数就不切了，整条丢

// —— 插件（design §8）——
export const PART_TIMEOUT = 5000 // ms
export const PART_TIMEOUT_MAX = 30000 // ms
export const PART_STDOUT_MAX = 8192 // 字节
export const PART_FAIL_LIMIT = 3 // 次
