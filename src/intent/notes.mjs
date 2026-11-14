// 便条 = 前瞻记忆（design §2）：不靠检索靠触发，写下去之后等着"说到那件事"。
// 记忆体在 state/notes-<月>.jsonl，只追加 add / take / drop，当前有哪些活便条靠折叠现算。
import { NOTE_TTL, jaccard, now, tokens } from '../core/index.mjs'
import { claim } from '../store/index.mjs'
import { appendOp, fold, readOps } from './ledger.mjs'
import { atOf, gate, optsOf, textOf, timeOf, ttlOf } from './shape.mjs'

const KIND = 'notes'
// 关闭一条便条：take 是"递出去了"（递出即焚），drop 是"不要了"。
// 折叠上两者等价——都不再出现在 ls 里；流水账里留着谁、什么时候、为什么。
const CLOSED = new Set(['take', 'drop'])

export async function add(homeDir, input, extra) {
  const opts = optsOf(input, extra)
  const at = atOf(opts)
  const text = textOf(opts.text, '便条内容')
  const trigger = triggerOf(opts.trigger)
  // when 是可选的时间点（"明天 9:00" → 数字）；解释不了就抛，不吞。
  const when = timeOf(opts.when, at, 'when')
  const ttl = ttlOf(opts.ttl)
  // 字段顺序照 design §4：op, id, at, text, trigger, when, ttl；没有 when 就不写这一格。
  // 校验排在抢号之后没关系：真被拒也只是一枚空号，不影响唯一性，而重号才是致命的。
  const rec = { op: 'add', id: await claim(homeDir, 'n', at, { dayStart: opts.dayStart ?? 0 }), at, text, trigger }
  if (when !== undefined) rec.when = when
  rec.ttl = ttl
  return appendOp(homeDir, KIND, gate(KIND, rec))
}

// ls：从流水账折出当前活便条。过期与坏行都要计数交回去——
// 安静地少一条，正是"静默丢弃"要防的事（AGENTS 二·2）。
export function list(homeDir, { now: nowTs } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  const { ops, bad } = readOps(homeDir, KIND)
  const folded = fold(ops, CLOSED)
  const items = []
  let expired = 0
  for (const slot of folded.byId.values()) {
    if (slot.closedAt !== null) continue // take / drop 过：不再出现，但流水账里还留着
    if (isExpired(slot.rec, at)) {
      expired += 1
      continue
    }
    items.push(item(slot.rec))
  }
  // 排序只认数字差（AGENTS 五）：先写下的先看见；同一毫秒靠稳定排序保持折叠顺序。
  items.sort((a, b) => a.at - b.at)
  return { items, expired, bad: bad + folded.bad }
}

// CLI 里叫 note ls、design §7 的导出名是 list：同一个函数两个名字，只为一处顺手。
export const ls = list

// 触发判定（design §2 "靠触发不靠检索"）：拿一段新出现的话去撞便条的线索。
// 线索取 trigger 加正文——光看 trigger 会让"她说头痛"这种写在正文里的线索哑掉。
// score 用 design §5 同一个 Jaccard；门限交给调用方，这里只保证"有交集才可能命中"。
export function match(homeDir, text, { now: nowTs, min = 0 } = {}) {
  const query = tokens(text)
  const found = list(homeDir, { now: nowTs })
  const hits = []
  for (const note of found.items) {
    const score = jaccard(query, tokens(`${note.trigger} ${note.text}`))
    // 空查询的相似度是 0（core/text 的选择）：没说话就不会触发任何便条。
    if (score > min) hits.push({ ...note, score })
  }
  hits.sort((a, b) => b.score - a.score || a.at - b.at)
  return { items: hits, expired: found.expired, bad: found.bad }
}

// 递出即焚：追加一条 take，ls 立刻不再折出它（旧行一字不改）。
export function take(homeDir, id, { now: nowTs } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  const rec = openNote(homeDir, id, 'take')
  appendOp(homeDir, KIND, { op: 'take', id: rec.id, at })
  return { ...item(rec), takenAt: at }
}

// 不要了：与 take 一样只追加一条 op、ls 里立刻消失，区别只在账本上记的词——
// "递出去过"和"压根没用上"将来回看不是一回事，op 流水账留着这两笔就是为了分得清
// （design §4）。所以 drop 不写成 take，也不复用 take 的返回值语义。
export function drop(homeDir, id, { now: nowTs } = {}) {
  const at = Number.isFinite(nowTs) ? nowTs : now()
  const rec = openNote(homeDir, id, 'drop')
  appendOp(homeDir, KIND, { op: 'drop', id: rec.id, at })
  return { ...item(rec), droppedAt: at }
}

// trigger 是给人看的触发条件（"下次说到发布时"）：你只存不判，判"这句话算不算说到"
// 是 match 与 gate 的事。没有触发条件的便条是一条普通待办，折进 ls 照样看得见，
// 所以缺省存空串；但给了一个空白串多半是参数打错，报出来。
function triggerOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`触发条件必须是字符串：拿到 ${typeof value}`)
  if (value.trim() === '') throw new Error('触发条件给了空白串：要么写一句话，要么整条参数都别给')
  return value
}

// 只给形状，不给"该怎么说"：渲染是 view 的事（design §7 依赖方向）。
function item(rec) {
  return {
    id: rec.id,
    at: rec.at,
    text: rec.text,
    trigger: typeof rec.trigger === 'string' ? rec.trigger : '',
    when: Number.isFinite(rec.when) ? rec.when : null,
    ttl: ttlOfRecord(rec),
  }
}

// 老记录 / 手写记录可能没有 ttl：按 NOTE_TTL 算，而不是当成"永不过期"。
function ttlOfRecord(rec) {
  return Number.isFinite(rec.ttl) && rec.ttl > 0 ? rec.ttl : NOTE_TTL
}

// 过期从"写下那一刻"算起，够 ttl 就算过期（正好等于 ttl 也不留：7 天的便条第 7 天该走了）。
function isExpired(rec, at) {
  return at - rec.at >= ttlOfRecord(rec)
}

// 找不到 / 已经关闭都抛：让 CLI 变成退出码 2 说清楚。静默返回 false 会让
// "我说了"与"我什么也没说"在调用方看来一模一样（AGENTS 二·2）。
// 过期但没关闭的便条仍然可以 take / drop：过期管的是"该不该出现在屏幕上"，
// 不是"能不能记账"。
function openNote(homeDir, id, verb) {
  const want = typeof id === 'string' ? id.trim() : ''
  if (want === '') throw new Error(`${verb} 要给便条 id：note ls 的第一列就是`)
  const { ops } = readOps(homeDir, KIND)
  const slot = fold(ops, CLOSED).byId.get(want)
  if (!slot) throw new Error(`没有这条便条：${want}（note ls 看现在有哪些）`)
  if (slot.closedAt !== null) throw new Error(`这条便条已经关闭过：${want}（take 与 drop 都只生效一次）`)
  return slot.rec
}
