// digest 门面：巩固 = 把窗口内的事件与结论压成一屏，并把"读完这一屏"记进账。
// 读：build（只算、不写盘）；写：run（渲染 + 输出 + seen +1 + 落账）。
// 账本这一门只留写（record）：读 state/trace-*.jsonl 的唯一入口是 audit.trace（design §6），
// 两边各读一遍，形状改一次就会有一边悄悄读错——"从没巩固过"由 audit 回空 items 表达。
// 复述记账只发生在这里（design §5）：别的层要 seen +1，走 run 或 retell，别自己写 memory.jsonl。
export { build } from './build.mjs'
export { retell } from './seen.mjs'
export { record } from './trace.mjs'
export { run } from './run.mjs'
