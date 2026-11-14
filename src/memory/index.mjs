// memory 门面：语义层与情景层只做"哪条结论此刻还算数、哪件事真的发生过"。
// 写：add / revise / markSeen；读：ls（list 同义）/ find / show / conflict / orphan / events。
// 规矩与自我块也住这一层（design §7）：
//   规矩 addRule / listRules / markRulesSeen —— rules.jsonl，只追加，替代靠新条的 supersedes，
//   seen +1 也只追加（同 id 同 at 的副本，读方取后写的那行）；
//   自我块 readSelf / setSelf / appendSelf —— self.md 一份纯文本，写就是整份覆盖。
// 别在别处直接 readJsonl(memory.jsonl)：收口靠追加同 id 的新版本，
// 直接读会把同一条记忆读成多行（design §4：只追加；失效靠 to/by）。
// 情景也一样：events 按日分片跨天合读，别自己 listShards('events')——坏行计数会漏。
// 这些导出名是对外契约（digest/seen 等已在用）：改文件结构可以，改名字不行。
export { add, conflict, eventAdd, revise } from './write.mjs'
export { events, find, list, ls, markSeen, orphan, show } from './query.mjs'
export { addRule, listRules, markRulesSeen } from './rules.mjs'
export { appendSelf, readSelf, setSelf } from './self.mjs'
