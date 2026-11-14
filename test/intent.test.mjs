// intent 的用例只钉 design §4 的形状与 §2 的"靠触发不靠检索"：
// 流水账只追加、折叠跨分片、过期与坏行都要计数、时间只解释一次。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { NOTE_TTL } from '../src/core/index.mjs'
import { notes, plans } from '../src/intent/index.mjs'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// 时间一律传死（AGENTS 六）：本地 2026-11-13 15:00，分片必然落在 notes-2026-11.jsonl。
// 用本地构造函数而不是 '+08:00' 字符串——CI 有纽约时区腿。
const T = new Date(2026, 10, 13, 15, 0).getTime()

async function inHome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    return await body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 分片名 = state/<kind>-<月>.jsonl（design §3）。月份按本地日历取，和 core/time 同一口径。
function shard(home, kind, ts) {
  const d = new Date(ts)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return path.join(home, 'state', `${kind}-${month}.jsonl`)
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((text) => text !== '')
}

function records(file) {
  return lines(file).map((text) => JSON.parse(text))
}

// 读命令不写盘：把整棵数据目录的文件名与内容一起拍快照，前后逐字比较。
function snapshot(dir) {
  const out = []
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name)
      if (entry.isDirectory()) {
        out.push(`${path.relative(dir, full)}/`)
        walk(full)
      } else {
        out.push(`${path.relative(dir, full)}:${fs.readFileSync(full, 'utf8')}`)
      }
    }
  }
  walk(dir)
  return out.sort()
}

test('note add 写进当月分片，ls 从流水账折出活便条', () => inHome(async (home) => {
  await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: T })
  const file = shard(home, 'notes', T)
  assert.ok(fs.existsSync(file), `便条没落进当月分片：${file}`)
  const [rec] = records(file)
  assert.equal(rec.op, 'add')
  assert.match(rec.id, /^n-\d{8}-\d{2}$/, `便条号形如 n-YYYYMMDD-NN，拿到 ${rec.id}`)
  assert.equal(rec.at, T)
  assert.equal(rec.text, '问她头痛好点没')
  assert.equal(rec.trigger, '她提到加班')
  assert.equal(rec.ttl, NOTE_TTL, 'ttl 缺省必须是 core 的 NOTE_TTL，不许本地再写一个 7 天')
  assert.equal(Object.hasOwn(rec, 'when'), false, '没有 when 就别写一个空格子')

  const got = notes.list(home, { now: T })
  assert.equal(got.bad, 0)
  assert.equal(got.items.length, 1)
  assert.deepEqual(got.items[0], {
    id: rec.id, at: T, text: '问她头痛好点没', trigger: '她提到加班', when: null, ttl: NOTE_TTL,
  })
  assert.equal(notes.ls, notes.list, 'CLI 的 note ls 与 design §7 的 list 必须是同一个函数')
}))

test('add 也收「字符串 + 选项」这一形：CLI 的散参数不必先拼成对象', () => inHome(async (home) => {
  const rec = await notes.add(home, '周末去买电池', { trigger: '她说灯闪', at: T })
  assert.equal(rec.text, '周末去买电池')
  assert.equal(rec.trigger, '她说灯闪')
  assert.equal(notes.list(home, { now: T }).items[0].text, '周末去买电池')
}))

test('take 之后 ls 不再出现；流水账里仍留着 take，旧行一字未改', () => inHome(async (home) => {
  const rec = await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: T })
  const file = shard(home, 'notes', T)
  const before = lines(file)
  const gone = notes.take(home, rec.id, { now: T + MINUTE })
  assert.equal(gone.text, '问她头痛好点没', 'take 要把递出的内容交回来，否则 CLI 只能打印一个号')
  const after = lines(file)
  assert.equal(after.length, before.length + 1, 'take 必须追加一行，不是改旧行')
  assert.equal(after[0], before[0], '旧行被改写了：op 流水账只追加（AGENTS 五）')
  const op = JSON.parse(after[after.length - 1])
  assert.equal(op.op, 'take')
  assert.equal(op.id, rec.id)
  assert.equal(op.at, T + MINUTE)
  assert.equal(notes.list(home, { now: T + MINUTE }).items.length, 0)
}))

test('take 一条不存在或已关闭的便条要报错：递出过就得说清，不能装作又递了一次', () => inHome(async (home) => {
  const rec = await notes.add(home, { text: '问她头痛好点没', at: T })
  assert.throws(() => notes.take(home, 'n-19700101-01', { now: T }), /没有这条便条/, '不存在的 id 必须报错')
  assert.throws(() => notes.take(home, '', { now: T }), /要给便条 id/, '空 id 必须报错')
  notes.take(home, rec.id, { now: T })
  assert.throws(() => notes.take(home, rec.id, { now: T }), /已经关闭过/, '同一条不能递出两次')
}))

test('drop 之后 ls 不再出现，回来的内容却是它：放弃也得说得出放弃了什么', () => inHome(async (home) => {
  const rec = await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: T })
  const dropped = notes.drop(home, rec.id, { now: T + MINUTE })
  assert.equal(dropped.text, '问她头痛好点没', 'drop 要把放弃掉的内容交回来')
  assert.equal(dropped.droppedAt, T + MINUTE)
  const after = notes.list(home, { now: T + MINUTE })
  assert.equal(after.items.length, 0, 'drop 过就不该再折出来')
  assert.equal(after.expired, 0, 'drop 不是过期：不许混进 expired 计数糊弄过去')
  assert.equal(notes.match(home, '她又在加班', { now: T + MINUTE }).items.length, 0, 'drop 过也不再触发')
  assert.throws(() => notes.drop(home, rec.id, { now: T }), /已经关闭过/, '同一条不能放弃两次')
}))

test('流水账里 take 与 drop 都在：谁递出去了、谁不要了，回看时分得清', () => inHome(async (home) => {
  const said = await notes.add(home, { text: '问她头痛好点没', at: T })
  const unused = await notes.add(home, { text: '周末去买电池', at: T })
  notes.take(home, said.id, { now: T + MINUTE })
  notes.drop(home, unused.id, { now: T + MINUTE })
  const ops = records(shard(home, 'notes', T))
  assert.deepEqual(ops.map((one) => one.op), ['add', 'add', 'take', 'drop'], '四条 op 按顺序躺着，一条没改')
  const closes = ops.filter((one) => one.op !== 'add')
  assert.deepEqual(closes[0], { op: 'take', id: said.id, at: T + MINUTE }, '关闭记录只带 op / id / at')
  assert.deepEqual(closes[1], { op: 'drop', id: unused.id, at: T + MINUTE }, 'drop 记的是被放弃的那条')
  assert.equal(notes.list(home, { now: T + MINUTE }).items.length, 0, '两条都关了：递出去的不再提，放弃的也不提')
}))

test('超过 ttl 的便条不再出现在 ls，但 expired 计数说出来（不静默消失）', () => inHome(async (home) => {
  await notes.add(home, { text: '问她头痛好点没', at: T })
  assert.equal(notes.list(home, { now: T + NOTE_TTL - 1 }).items.length, 1, '差一毫秒还不算过期')
  const gone = notes.list(home, { now: T + NOTE_TTL })
  assert.equal(gone.items.length, 0, '满 ttl 就该走')
  assert.equal(gone.expired, 1, '过期便条要计数：安静地少一条就是静默丢弃')
}))

test('ttl 按便条自己算：给了 12h 就用 12h，不能用 NOTE_TTL 一刀切', () => inHome(async (home) => {
  await notes.add(home, { text: '下午提醒她喝水', ttl: '12h', at: T })
  assert.equal(records(shard(home, 'notes', T))[0].ttl, 12 * HOUR, 'ttl 的跨度写法要换成毫秒落盘')
  assert.equal(notes.list(home, { now: T + 11 * HOUR }).items.length, 1)
  assert.equal(notes.list(home, { now: T + 12 * HOUR }).expired, 1)

  await notes.add(home, { text: '按毫秒数给 ttl', ttl: 30 * MINUTE, at: T })
  const mixed = notes.list(home, { now: T + 31 * MINUTE })
  assert.equal(mixed.items.length, 1, '12h 那条还活着')
  assert.equal(mixed.items[0].text, '下午提醒她喝水', '两条 ttl 不同，不能一起过期')
  assert.equal(mixed.expired, 1, '只有 30m 那条过期')
}))

test('when 交给 core/time 解释成数字再落盘：相对写法从写下那一刻算起', () => inHome(async (home) => {
  const rec = await notes.add(home, { text: '过一会问问结果', when: '3h', at: T })
  assert.equal(rec.when, T + 3 * HOUR, '相对时间要从这条便条的 at 起算，不能另取一个"现在"')
  assert.equal(typeof records(shard(home, 'notes', T))[0].when, 'number', '落盘的必须是数字，不是人话')

  const tomorrow = await notes.add(home, { text: '明早再提一次', when: '明天 9:00', at: T })
  assert.equal(tomorrow.when, new Date(2026, 10, 14, 9, 0).getTime())
  const folded = notes.list(home, { now: T }).items.find((one) => one.id === tomorrow.id)
  assert.equal(folded.when, tomorrow.when, '折叠出来的 when 必须原样是那个数字')
}))

test('when 解析不了就报错，不吞也不猜一个时间', () => inHome(async (home) => {
  await assert.rejects(notes.add(home, { text: '看星星', when: '昨晚', at: T }), /when 读不出时间/)
  assert.equal(fs.existsSync(path.join(home, 'state')), false, '参数被拒还留下目录，就是写了一半')
}))

test('ttl 只认跨度：一个日期串不能冒充时长，0 与负数直接拒绝', () => inHome(async (home) => {
  await assert.rejects(notes.add(home, { text: 'x', ttl: '2026-11-20', at: T }), /ttl 最多一年/)
  await assert.rejects(notes.add(home, { text: 'x', ttl: '一周', at: T }), /ttl 读不出时长/)
  await assert.rejects(notes.add(home, { text: 'x', ttl: 0, at: T }), /ttl 必须大于 0/)
  assert.equal(fs.existsSync(path.join(home, 'state')), false)
}))

test('空便条在写盘前就被拒：校验走 store/schema，坏记录一行都不落', () => inHome(async (home) => {
  await assert.rejects(notes.add(home, { text: '   ', at: T }), /便条内容/)
  await assert.rejects(notes.add(home, { at: T }), /便条内容/)
  await assert.rejects(notes.add(home, { text: '有空触发条件', trigger: ' ', at: T }), /触发条件/)
  assert.equal(fs.existsSync(path.join(home, 'state')), false)
}))

test('跨月要拼出连续视图：10 月写下、11 月 take，折叠立刻不认它', () => inHome(async (home) => {
  const oct = new Date(2026, 9, 30, 21, 0).getTime()
  const nov = new Date(2026, 10, 3, 9, 0).getTime()
  const rec = await notes.add(home, { text: '月底答应她的事', at: oct })
  assert.ok(fs.existsSync(shard(home, 'notes', oct)), '便条要落在写它的那个月')
  assert.equal(notes.list(home, { now: nov }).items.length, 1, '下个月还得看得见这条便条')

  notes.take(home, rec.id, { now: nov })
  assert.ok(fs.existsSync(shard(home, 'notes', nov)), 'take 要落在 take 的那个月')
  assert.equal(records(shard(home, 'notes', nov))[0].op, 'take')
  assert.equal(notes.list(home, { now: nov }).items.length, 0, '折叠必须跨分片，否则 take 白记')
}))

test('坏行跳过并计数：一行读不懂不丢整份便条，也不装作没发生', () => inHome(async (home) => {
  await notes.add(home, { text: '问她头痛好点没', at: T })
  const file = shard(home, 'notes', T)
  fs.appendFileSync(file, '这不是 JSON\n')
  fs.appendFileSync(file, `${JSON.stringify({ op: 'add', id: '', at: T, text: '没号' })}\n`)
  fs.appendFileSync(file, `${JSON.stringify({ op: 'add', id: 'n-20261113-09', at: T })}\n`)
  fs.appendFileSync(file, `${JSON.stringify({ op: 'take', id: 'n-20261113-08', at: T })}\n`)
  const got = notes.list(home, { now: T })
  assert.equal(got.items.length, 1, '好行还得读出来')
  assert.equal(got.bad, 4, '非 JSON、空 id、没正文、关一个没见过的 id：四行都读不出可用记录')
}))

test('读命令一行都不写：list / match 前后数据目录完全一样', () => inHome(async (home) => {
  await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: T })
  await plans.add(home, { text: '陪她看牙', due: '明天 9:00', at: T })
  const before = snapshot(home)
  notes.list(home, { now: T })
  plans.list(home, { now: T })
  notes.match(home, '她又在加班', { now: T })
  assert.deepEqual(snapshot(home), before, '读命令写盘了：一次性进程不做 write-on-read（design §5）')
}))

test('便条靠触发不靠检索：说到那个条件才命中，无关的话不命中', () => inHome(async (home) => {
  await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: T })
  assert.equal(notes.match(home, '今天天气不错', { now: T }).items.length, 0, '无关的话不该触发')
  assert.equal(notes.match(home, '', { now: T }).items.length, 0, '没说话就不触发任何便条')
  const hit = notes.match(home, '她又在加班', { now: T })
  assert.equal(hit.items.length, 1)
  assert.equal(hit.items[0].text, '问她头痛好点没')
  assert.ok(hit.items[0].score > 0, '命中要带线索分，好让 gate 决定值不值得开口')
  assert.equal(notes.match(home, '她又在加班', { now: T + NOTE_TTL }).items.length, 0, '过期便条不触发')
}))

test('日程必须给 due：没有时间就不叫日程，报错而不是猜一个明天', () => inHome(async (home) => {
  await assert.rejects(plans.add(home, { text: '陪她看牙', at: T }), /日程要给 due/)
  await assert.rejects(plans.add(home, { text: '陪她看牙', due: '下个月', at: T }), /due 读不出时间/)
  await assert.rejects(plans.add(home, { text: '  ', due: '明天', at: T }), /日程内容/)
  assert.equal(fs.existsSync(path.join(home, 'state')), false, '被拒的日程一行都不该落盘')
}))

test('plan add 落进当月分片，id 形如 p-YYYYMMDD-NN，due 归一成数字', () => inHome(async (home) => {
  const rec = await plans.add(home, { text: '陪她看牙', due: '明天 9:00', at: T })
  const [line] = records(shard(home, 'plans', T))
  assert.equal(line.op, 'add')
  assert.match(line.id, /^p-\d{8}-\d{2}$/, `日程号形如 p-YYYYMMDD-NN，拿到 ${line.id}`)
  assert.equal(line.due, new Date(2026, 10, 14, 9, 0).getTime())
  assert.equal(rec.id, line.id)
}))

test('done 之后 ls 不再出现；流水账里仍留着 done，旧行不动', () => inHome(async (home) => {
  const rec = await plans.add(home, { text: '陪她看牙', due: '明天 9:00', at: T })
  const file = shard(home, 'plans', T)
  const before = lines(file)
  const finished = plans.done(home, rec.id, { now: T + HOUR })
  assert.equal(finished.text, '陪她看牙')
  assert.equal(finished.doneAt, T + HOUR)
  const after = lines(file)
  assert.equal(after.length, before.length + 1)
  assert.equal(after[0], before[0], '旧行被改写了：op 流水账只追加')
  assert.equal(JSON.parse(after[after.length - 1]).op, 'done')
  assert.equal(plans.list(home, { now: T + HOUR }).items.length, 0)
  assert.throws(() => plans.done(home, rec.id, { now: T + 2 * HOUR }), /已经 done 过/)
  assert.throws(() => plans.done(home, 'p-19700101-01', { now: T }), /没有这条日程/)
}))

test('drop 之后 ls 不再出现；流水账里留的 drop 不是 done：做完了和不做了要分得清', () => inHome(async (home) => {
  const rec = await plans.add(home, { text: '陪她看牙', due: '明天 9:00', at: T })
  const file = shard(home, 'plans', T)
  const before = lines(file)
  const dropped = plans.drop(home, rec.id, { now: T + HOUR })
  assert.equal(dropped.text, '陪她看牙', 'drop 要把放弃掉的日程交回来')
  assert.equal(dropped.droppedAt, T + HOUR)
  assert.equal(dropped.doneAt, undefined, 'drop 不是 done：不许顺手冒充做完')
  const after = lines(file)
  assert.equal(after.length, before.length + 1)
  assert.equal(after[0], before[0], '旧行被改写了：op 流水账只追加')
  assert.deepEqual(JSON.parse(after[after.length - 1]), { op: 'drop', id: rec.id, at: T + HOUR },
    '关闭记录只带 op / id / at')
  assert.equal(plans.list(home, { now: T + HOUR }).items.length, 0, '放弃掉的日程不该再折出来')
  assert.equal(plans.list(home, { now: T + HOUR }).late, 0, 'drop 不是逾期：不许混进 late 计数')
  assert.throws(() => plans.drop(home, rec.id, { now: T + 2 * HOUR }), /已经 drop 过/, '同一条不能放弃两次')
  assert.throws(() => plans.done(home, rec.id, { now: T + 2 * HOUR }), /已经 drop 过/,
    'drop 过的日程不能再打勾：报错要说清是谁收的口')
  assert.throws(() => plans.drop(home, '', { now: T }), /plan ls 的第一列/, '没给 id 要说清去哪儿找')
}))

test('due 过了标 late、没过的不标：late 只给数据，催不催是别人判断', () => inHome(async (home) => {
  const yesterday = new Date(2026, 10, 12, 9, 0).getTime()
  const tomorrow = new Date(2026, 10, 14, 9, 0).getTime()
  await plans.add(home, { text: '昨天的复诊', due: yesterday, at: T - DAY })
  await plans.add(home, { text: '明天的复诊', due: tomorrow, at: T })
  const got = plans.list(home, { now: T })
  assert.deepEqual(got.items.map((one) => one.text), ['昨天的复诊', '明天的复诊'], '按 due 升序：先到期先看见')
  assert.equal(got.items[0].late, true)
  assert.equal(got.items[1].late, false)
  assert.equal(got.late, 1)
}))

test('days 窗口外的日程进 later 计数而不消失；逾期的永远在', () => inHome(async (home) => {
  await plans.add(home, { text: '三个月后复诊', due: new Date(2027, 1, 1, 9, 0).getTime(), at: T })
  await plans.add(home, { text: '上周欠下的', due: new Date(2026, 10, 6, 9, 0).getTime(), at: T - 7 * DAY })
  const near = plans.list(home, { now: T, days: 7 })
  assert.deepEqual(near.items.map((one) => one.text), ['上周欠下的'], '逾期的不受窗口影响')
  assert.equal(near.later, 1, '窗口外要计数：藏起来又不说话就是静默丢弃')
  assert.equal(plans.list(home, { now: T }).items.length, 2, '不给窗口就不藏')
}))

test('没有 due 的老日程不丢：due 为 null、late 为 false，排在最后', () => inHome(async (home) => {
  await plans.add(home, { text: '有时间的', due: new Date(2026, 10, 14, 9, 0).getTime(), at: T })
  const file = shard(home, 'plans', T)
  fs.appendFileSync(file, `${JSON.stringify({ op: 'add', id: 'p-20261113-77', at: T, text: '旧格式没记时间' })}\n`)
  const got = plans.list(home, { now: T })
  assert.deepEqual(got.items.map((one) => one.text), ['有时间的', '旧格式没记时间'])
  assert.equal(got.items[1].due, null)
  assert.equal(got.items[1].late, false, '没有时间点就不算逾期，只是排最后')
}))

test('日程的坏行同样跳过并计数；due 落在下个月也照折叠得出来（分片按写入月份）', () => inHome(async (home) => {
  const rec = await plans.add(home, { text: '月底复诊', due: new Date(2026, 11, 2, 9, 0).getTime(), at: T })
  assert.ok(fs.existsSync(shard(home, 'plans', T)), '分片看 at，不看 due')
  fs.appendFileSync(shard(home, 'plans', T), 'garbage\n')
  const got = plans.list(home, { now: T })
  assert.equal(got.items.length, 1)
  assert.equal(got.items[0].id, rec.id)
  assert.equal(got.bad, 1)
}))

test('日程不参与触发：plans 上没有 match，只有便条才靠触发', () => {
  assert.equal(typeof notes.match, 'function')
  assert.equal(Object.hasOwn(plans, 'match'), false, 'plans 一旦能触发，cue 就退化成"每天提醒今天有什么事"')
})
