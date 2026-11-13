// digest 门面：巩固 = 把窗口内的事件与结论压成一屏，并把"读完这一屏"记进账。
// 读：build（只算、不写盘）；写：run（渲染 + 输出 + seen +1 + 落账），外加记账的两个零件。
// 复述记账只发生在这里（design §5）：别的层要 seen +1，走 run 或 retell，别自己写 memory.jsonl。
export { build } from './build.mjs'
export { retell } from './seen.mjs'
export { record, list as trace, never } from './trace.mjs'
export { run } from './run.mjs'
