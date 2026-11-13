// affect 门面（design §14 / §7）：情绪是可观测状态变量，不是台词；存刺激不存情绪。
// 上层只准 import 这里——decay 管纯函数、label 管话术、stim 管记账、state 管"现在是多少"。
// 当前值一律读时现算：删掉缓存不丢事实，重放同一份日志得同一数值（§14.8）。
export {
  AXES, AXIS_NAMES, EMOTION_HALF, axis, clampAxis, decay, decayOffset,
  merge, mergeOffset, mergeStim,
} from './decay.mjs'
export { MOODS, deadband, moodOf, persistent, respectBand, transient } from './label.mjs'
export { KINDS, list, record, weightOf } from './stim.mjs'
