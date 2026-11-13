// intent 门面（design §7）：前瞻记忆两条流——便条 notes、日程 plans。
// 上层只准 import 这里，折叠逻辑住在同层的 notes / plans / ledger / shape。
// 两个子模块都有 add / list，所以按 design §7 的名字分成两个命名空间：
// intent.notes.add(...) / intent.plans.add(...)。
// 约定：参数不合法就抛带"怎么改"的 Error（CLI 把它变成退出码 2），一次写不落盘。
export * as notes from './notes.mjs'
