// soul 门面（design §13）：灵魂是一张身份卡，不是一段提示词。
// 上层只准 import 这里：目录与指针在 store、解析与校验在 card、预算注入在 inject。
// 三条边界写在这儿，改代码前先认一遍：
// 1. 切换只写 `state/soul.current` 一个文件——memory.jsonl / events/ / self.md / affect 一个字节不动；
// 2. `card.json` 只存档不注入：creator_notes / tags / creator / character_version 是给人看的；
// 3. 上限是注入槽位，不是文件上限：超槽位只警告，注入装不下才记 dropped（不截半句）。
export { current, dir, list, use } from './store.mjs'
export { check, importCard, read, stripMarks } from './card.mjs'
