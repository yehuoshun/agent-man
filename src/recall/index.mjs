// recall 门面：把候选压成一屏。跨目录只准 import 这一层（AGENTS 四）。
// 这一层是纯函数——输入候选、输出选择，不读盘不写盘；坏行与降级由调用方用 "! " 说出来。
export { kindOf, idOf, textOf, atOf, strength, retention } from './strength.mjs'
export { cue, score, rank, sortByScore } from './rank.mjs'
export { guarantee, allocate } from './pick.mjs'
export { costOf, cut, fit } from './budget.mjs'
