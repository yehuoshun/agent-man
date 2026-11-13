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
// §14.5 的调制口子：min-gap × (1 + (AFFECT_BASE.v − v) / 200)。200 是"低多少分算翻倍"，
// 不是随手写的分母——它让 v=0 时门槛正好翻一倍半，v=100 时缩四分之一。
export const CUE_MOOD_DIV = 200
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
// §5 的"最弱三条"是三条，不是段上限（那是 SECTION_ITEMS_MAX 的四条）：两件事撞一起，
// 屏上就会出现"最弱的四条"这种没人下过结论的东西。
export const WEAKEST_MAX = 3 // 条：处境屏里"最弱的三条"

// —— 插件（design §8）——
export const PART_TIMEOUT = 5000 // ms
export const PART_TIMEOUT_MAX = 30000 // ms
export const PART_STDOUT_MAX = 8192 // 字节
export const PART_FAIL_LIMIT = 3 // 次

// —— 审计读多少（design §6：audit trace / timeline 的缺省条数）——
export const AUDIT_LIMIT = 20 // 条：两个读命令共用的缺省上限
export const TRACE_KEEP_MONTHS = 12 // 月：保留上限，读取不裁——审计要看全，清理是将来 prun 的事

// —— 情绪（design §14）——
// 半衰期分正负：坏心情走得慢（AFFECT_MOOD_HALF_NEG），高兴回来得快。人就是这样。
export const AFFECT_MOOD_HALF = 8 * HOUR
export const AFFECT_MOOD_HALF_NEG = 13 * HOUR
export const AFFECT_ENERGY_HALF = 3 * HOUR
export const AFFECT_TRUST_HALF = 60 * DAY // 信任是关系，不是心情：两个月不联系才回到陌生人
export const AFFECT_RESPECT_HALF = 90 * DAY // 尊重更慢：人品判断不该因为一周没说话就变
export const AFFECT_EMOTION_HALF = 45 * MINUTE // 瞬时情绪
export const AFFECT_STIM_PER_HOUR = 3 // 条：同类刺激每小时最多计几次，防刷
export const AFFECT_NEG_WEIGHT = 1.5 // 负向刺激加权（negativity bias）
export const AFFECT_HYST = 3 // 分：标签切换的滞回，防抖动
export const AFFECT_DEADBAND = 5 // 分：与基线差小于它就算"没变"
export const AFFECT_INJECT_COST = 80 // cost：情绪行在注入里的上限
export const AFFECT_KEEP_MONTHS = 24 // 月：刺激日志按月分片保留
export const AFFECT_BIAS_IMP = 0 // 记账权重修正：0=关（design §14.12）

// 四轴基线。r 是 −100..100 的"尊重"，其余 0..100。
export const AFFECT_BASE = Object.freeze({ v: 50, e: 60, t: 40, r: 0 })

// 刺激权重表（design §14.7）。调用方只传 kind，不许传权重。
// 每个 kind：{v, e, t, r} 的增量；负向 kind 由 AFFECT_NEG_WEIGHT 统一加权，不在这里预先乘。
export const AFFECT_WEIGHTS = Object.freeze({
  'task.done': { v: 6, e: -4, t: 1, r: 0 },
  'task.rework': { v: -5, e: -4, t: 0, r: 0 },
  'task.fail': { v: -8, e: -6, t: 0, r: 0 },
  'user.praise': { v: 8, e: 2, t: 3, r: 1 },
  'user.correct': { v: -6, e: 0, t: -3, r: 0 },
  'user.impatient': { v: -7, e: -3, t: -2, r: 0 },
  'promise.kept': { v: 10, e: 0, t: 5, r: 2 },
  'promise.overdue': { v: -10, e: -2, t: -8, r: -4 },
  'return.after-gap': { v: 5, e: 10, t: 0, r: 0 },
  'self.report': { v: 1, e: 1, t: 0, r: 0 }, // ±1：agent 自报最容易表演，权重压到最小
})

// —— 灵魂（design §13）——
export const SOUL_INJECT_COST = 200 // cost：灵魂块在首步注入里的上限
export const SOUL_USER_COST = 100 // cost：用户模型那一块
export const SOUL_IDENTITY_MAX = 120 // cost：注入槽位（不是文件上限）
export const SOUL_SOUL_MAX = 200
export const SOUL_DIALOGUE_MAX = 200
export const SOUL_USER_MAX = 400 // cost：user.md 文件的存储上限
