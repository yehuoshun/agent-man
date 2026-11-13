// 宿主层门面（design §9）：四件东西——装配、回顾、工具定义、工具调用。
// 碰 DSH 的那一半不在这里：根 dsh/index.mjs 才是适配器。这一层全部是纯函数，可被 node --test 钉住。
export { SLOTS, compose, affectLine } from './inject.mjs'
export { RECALL_HEADER, recall } from './recall.mjs'
export { LOOK_ACTIONS, TOOLS, WRITE_ACTIONS, callTool } from './tools.mjs'
