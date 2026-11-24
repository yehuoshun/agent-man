// 零件门面：在 PATH 上找 `agent-man-<名字>`、调它、记它的连续失败。
// 上游只从这里拿东西（AGENTS §四：跨目录只准 import 门面）。
export { scan, describe } from './discover.mjs'
export { sense } from './sense.mjs'
export { passthrough, capture } from './call.mjs'
// 连续失败的账住 meta.json 的 parts 键（design §4/§8）：bump/blocked 是纯函数，
// openLedger 才是碰盘的那一层——sense 只认 get/mark/reset，所以冷却逻辑拿假账本就能测。
export { bump, blocked, records, openLedger } from './ledger.mjs'
