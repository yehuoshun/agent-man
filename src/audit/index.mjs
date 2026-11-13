// audit 门面（design §6）：这一层只做只读的审计——按什么顺序读、把哪一个坏消息说出来。
// 判定不在这儿长：证据解析归 memory，折叠归 intent，时间与成本归 core。
// 这里没有任何写入口（AGENTS 二·2）。
export { trace } from './trace.mjs'
