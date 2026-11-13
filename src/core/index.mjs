// core 门面：上层只准 import 这里（AGENTS 四）。time / cost / text 都是纯函数，
// 不碰文件、不碰进程，所以能放心被任何一个模块依赖。
export { now, dayKey, monthKey, clock, rel, parseWhen } from './time.mjs'
export { cost, cut, oneLine } from './cost.mjs'
export { tokens, jaccard } from './text.mjs'
