// memory 门面：语义层只做"哪条结论此刻还算数"。
// 写：add / revise；读：ls（list 同义）/ find / show / conflict / orphan。
// 别在别处直接 readJsonl(memory.jsonl)：收口靠追加同 id 的新版本，
// 直接读会把同一条记忆读成多行（design §4：只追加；失效靠 to/by）。
export { add } from './add.mjs'
export { conflict, revise } from './revise.mjs'
export { find, list, ls, orphan, show } from './query.mjs'
