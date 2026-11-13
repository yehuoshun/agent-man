// memory 门面：语义层与情景层只做"哪条结论此刻还算数、哪件事真的发生过"。
// 写：add / revise / markSeen；读：ls（list 同义）/ find / show / conflict / orphan / events。
// 别在别处直接 readJsonl(memory.jsonl)：收口靠追加同 id 的新版本，
// 直接读会把同一条记忆读成多行（design §4：只追加；失效靠 to/by）。
// 情景也一样：events 按日分片跨天合读，别自己 listShards('events')——坏行计数会漏。
// 这些导出名是对外契约（digest/seen 等已在用）：改文件结构可以，改名字不行。
export { add } from './add.mjs'
export { events, find, list, ls, markSeen, orphan, show } from './query.mjs'
export { conflict, revise } from './revise.mjs'
