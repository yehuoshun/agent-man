import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { set as affectSet } from '../src/affect/index.mjs'
import { DEBT_STALE, SECTION_ITEMS_MAX, clock, config } from '../src/core/index.mjs'
import { notes, plans } from '../src/intent/index.mjs'
import { add as addMemory } from '../src/memory/index.mjs'
import { brief, build, debt, gate, situation } from '../src/mind/index.mjs'
import { costOf } from '../src/recall/index.mjs'
import { appendJsonl, ensure, eventsFile, metaFile, readJsonl, stateFile } from '../src/store/index.mjs'
import { renderScreen } from '../src/view/index.mjs'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// 时间用例一律传死 now（AGENTS 六）：本地时间构造，CI 的纽约时区腿也成立。
const at = (day, hours, mins = 0) => new Date(2026, 10, day, hours, mins, 0).getTime()
const T = at(13, 15, 0)

const HOMES = []

function newHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  return dir
}

function seed(home, id, ts, text = '她关窗', cues = []) {
  ensure(home)
  appendJsonl(eventsFile(home, ts), { id, at: ts, text, cues, src: { origin: 'user' } })
}

function judgeRows(home, ts = T) {
  return readJsonl(stateFile(home, 'judge', ts)).items
}

// 逐字拍目录：读命令一个字都不许写（design §5），写命令也不许顺手多建东西。
function snapshot(dir) {
  const out = []
  const walk = (here) => {
    for (const name of fs.readdirSync(here).sort()) {
      const full = path.join(here, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full)
      else out.push(`${path.relative(dir, full)}:${stat.size}`)
    }
  }
  walk(dir)
  return out
}

// ── 欠账 ────────────────────────────────────────────────────────────────

test('没记过账就不催：欠账为零，也没有上次巩固的时刻', () => {
  const home = newHome()
  const state = debt.state(home, { now: T })
  assert.equal(state.unconsolidated, 0)
  assert.equal(state.unreflected, 0)
  assert.equal(state.lastAt, null)
  assert.equal(state.due, false)
  assert.deepEqual(state.overdue, [])
})

test('分量压到 12 就该巩固了：到了门槛就算，不论压了几天', async () => {
  const home = newHome()
  await debt.bump(home, { at: T, imp: 8 })
  assert.equal(debt.state(home, { now: T }).due, false)
  await debt.bump(home, { at: T, imp: 4 })
  const state = debt.state(home, { now: T })
  assert.equal(state.unconsolidated, 12)
  assert.equal(state.due, true)
  assert.match(state.why, /12 imp/)
})

test('条数堆到 40 也算该巩固了：件数与分量是两本账', async () => {
  const home = newHome()
  await debt.bump(home, { at: T, imp: 0, unreflected: 39 })
  assert.equal(debt.state(home, { now: T }).due, false)
  await debt.bump(home, { at: T, imp: 0, unreflected: 1 })
  const state = debt.state(home, { now: T })
  assert.equal(state.unreflected, 40)
  assert.equal(state.unconsolidated, 0)
  assert.equal(state.due, true)
  assert.match(state.why, /40 条情景没巩固/)
})

test('一天没巩固也算该巩固了：时间本身就是一笔账', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 2 * HOUR)
  await debt.bump(home, { at: T - 2 * HOUR, imp: 1 })
  assert.equal(debt.state(home, { now: T }).due, false)
  const state = debt.state(home, { now: T - 2 * HOUR + DEBT_STALE + HOUR })
  assert.equal(state.due, true)
  assert.match(state.why, /没巩固/)
})

test('巩固完账就清零、水位推到此刻，别人的键一个字都不动', async () => {
  const home = newHome()
  ensure(home)
  fs.writeFileSync(
    metaFile(home),
    `${JSON.stringify({ lastCueAt: T - HOUR, affect: { peaks: { v: 80 } } }, null, 2)}\n`,
  )
  await debt.bump(home, { at: T, imp: 5 })
  const done = await debt.settle(home, { at: T + HOUR })
  assert.equal(done.saved, true)
  const doc = JSON.parse(fs.readFileSync(metaFile(home), 'utf8'))
  assert.deepEqual(doc.debt, { unconsolidated: 0, unreflected: 0, lastAt: T + HOUR })
  assert.equal(doc.lastCueAt, T - HOUR)
  assert.deepEqual(doc.affect, { peaks: { v: 80 } })
})

test('状态文件读不懂就拒写：宁可这一笔不落，也不覆盖别人的键', async () => {
  const home = newHome()
  ensure(home)
  fs.writeFileSync(metaFile(home), 'not json\n')
  const done = await debt.bump(home, { at: T, imp: 3 })
  assert.equal(done.saved, false)
  assert.match(done.why, /读不懂/)
  assert.equal(fs.readFileSync(metaFile(home), 'utf8'), 'not json\n')
})

test('同一个线索两天里出现三次才算聚团：两次不算，同一条里重复也不算', () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 3 * HOUR, '她说周四去医院', ['医院', '医院'])
  seed(home, 'e-20261113-02', T - 2 * HOUR, '她又提起医院', ['医院'])
  assert.deepEqual(debt.state(home, { now: T }).clusters, [])
  seed(home, 'e-20261113-03', T - HOUR, '还是医院', ['医院'])
  const state = debt.state(home, { now: T })
  assert.equal(state.clusters.length, 1)
  assert.equal(state.clusters[0].cue, '医院')
  assert.equal(state.clusters[0].hits, 3)
  assert.equal(state.due, true)
})

test('线索隔得太远就不算聚团：两天以外的第三次不作数', () => {
  const home = newHome()
  seed(home, 'e-20261111-01', T - 3 * 24 * HOUR, '医院', ['医院'])
  seed(home, 'e-20261113-02', T - 2 * HOUR, '医院', ['医院'])
  seed(home, 'e-20261113-03', T - HOUR, '医院', ['医院'])
  assert.deepEqual(debt.state(home, { now: T }).clusters, [])
})

test('过点的日程进欠账的快照：带 due 与晚了多久，不只是一条条数', async () => {
  const home = newHome()
  await plans.add(home, { text: '交房租', due: T - 26 * HOUR }, { now: T })
  const state = debt.state(home, { now: T })
  assert.equal(state.overdue.length, 1)
  assert.equal(state.overdue[0].text, '交房租')
  assert.equal(state.overdue[0].lateBy, 26 * HOUR)
})

test('上次开口：没写过是 null，写过就读回那个数（数字与对象两种写法都收）', async () => {
  const home = newHome()
  assert.equal(debt.lastSaid(home).at, null)
  await debt.markSaid(home, T)
  assert.equal(debt.lastSaid(home).at, T)
  await debt.markSaid(home, { at: T + HOUR })
  assert.equal(debt.lastSaid(home).at, T + HOUR)
})

test('欠账是读命令：算一遍不写盘', () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR)
  const before = snapshot(home)
  debt.state(home, { now: T })
  assert.deepEqual(snapshot(home), before)
})

// ── 开口门 ──────────────────────────────────────────────────────────────

test('静默时段不说话：二十三点半只判"不打扰"，理由里写清是静默', () => {
  const home = newHome()
  const late = at(13, 23, 30)
  const verdict = gate.judge(home, { now: late })
  assert.equal(verdict.quiet, true)
  assert.equal(verdict.say, false)
  assert.match(verdict.why, /静默/)
  assert.equal(verdict.quietSpan, '23:00-08:00')
})

test('静默的边是开着的：七点五十九分还算静默，八点整就出来了', () => {
  const home = newHome()
  assert.equal(gate.judge(home, { now: at(14, 7, 59) }).quiet, true)
  assert.equal(gate.judge(home, { now: at(14, 8, 0) }).quiet, false)
  assert.equal(gate.judge(home, { now: at(14, 22, 59) }).quiet, false)
  assert.equal(gate.judge(home, { now: at(14, 23, 0) }).quiet, true)
})

test('配置里关掉让静默就真的不躲：门只听配置，不听钟点', () => {
  const home = newHome()
  const cfg = { ...config.DEFAULTS, cue: { ...config.DEFAULTS.cue, respectQuiet: false } }
  assert.equal(gate.judge(home, { now: at(13, 23, 30), cfg }).quiet, false)
})

test('静默窗口也能改：配置说二十二点到六点，晚十点半就算夜里', () => {
  const home = newHome()
  const cfg = { ...config.DEFAULTS, clock: { ...config.DEFAULTS.clock, quiet: ['22:00', '06:00'] } }
  const verdict = gate.judge(home, { now: at(13, 22, 30), cfg })
  assert.equal(verdict.quiet, true)
  assert.equal(verdict.quietSpan, '22:00-06:00')
})

test('命令行递来的门槛与静默都认：minGap 压到半小时就说，抬到三小时就不说', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR)
  await debt.bump(home, { at: T - HOUR, imp: 1, unreflected: 3 })
  await debt.markSaid(home, { at: T - HOUR })
  assert.equal(gate.judge(home, { now: T, minGap: 30 * MINUTE }).say, true)
  assert.equal(gate.judge(home, { now: T, minGap: 3 * HOUR }).say, false)
  assert.equal(gate.judge(home, { now: at(13, 23, 30), quiet: false }).quiet, false)
  assert.equal(gate.judge(home, { now: at(13, 15, 0), quiet: true }).say, false)
})

test('距上次开口不到门槛就不打扰：差多少也说出来，够了一小时也不多说', async () => {
  const home = newHome()
  await plans.add(home, { text: '交房租', due: T - HOUR }, { now: T })
  await debt.markSaid(home, T - 5 * HOUR)
  const early = gate.judge(home, { now: T })
  assert.equal(early.say, false)
  assert.match(early.why, /还差 1 小时/)
  await debt.markSaid(home, T - 7 * HOUR)
  const enough = gate.judge(home, { now: T })
  assert.equal(enough.say, true)
  assert.match(enough.why, /1 条日程过点/)
})

test('心情越低门槛越高：同一处境下 v=20 要多等，v=50 那会儿已经能说', async () => {
  const home = newHome()
  await plans.add(home, { text: '交房租', due: T - HOUR }, { now: T })
  await debt.markSaid(home, T - 6 * HOUR - 30 * MINUTE)
  const flat = gate.judge(home, { now: T })
  assert.equal(flat.v, 50)
  assert.equal(flat.minGap, 6 * HOUR)
  assert.equal(flat.say, true)
  await affectSet(home, { axis: 'v', value: 20, why: '用例：低落', at: T - HOUR })
  const low = gate.judge(home, { now: T })
  assert.equal(low.v, 20)
  assert.ok(low.minGap > flat.minGap, '低落时门槛该更宽')
  assert.equal(low.why.includes('还差'), true)
  assert.equal(low.say, false)
})

test('没什么新事就不打扰：静默与间隔都过了也不硬找话说', () => {
  const home = newHome()
  const verdict = gate.judge(home, { now: T })
  assert.equal(verdict.say, false)
  assert.deepEqual(verdict.reasons, [])
})

test('force 就照办：静默与间隔都不拦，理由里说明是人要求的', async () => {
  const home = newHome()
  await debt.markSaid(home, at(13, 23, 20))
  const verdict = gate.judge(home, { now: at(13, 23, 30), force: true })
  assert.equal(verdict.say, true)
  assert.match(verdict.why, /人要求此刻就说/)
})

test('开口判决是只读的：判完一个字都不落盘，写账是另一件事', () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR, '她说周四去医院', ['医院'])
  const before = snapshot(home)
  gate.judge(home, { now: T })
  assert.deepEqual(snapshot(home), before)
})

test('判决不生成台词：只回该不该、为什么，以及摊开的门槛数字', async () => {
  const home = newHome()
  await plans.add(home, { text: '交房租', due: T - HOUR }, { now: T })
  const verdict = gate.judge(home, { now: T })
  assert.deepEqual(Object.keys(verdict).sort(), [
    'at', 'bad', 'debts', 'factor', 'gap', 'idle', 'lastSaid', 'minGap',
    'quiet', 'quietSpan', 'reasons', 'say', 'v', 'warnings', 'why',
  ])
  assert.equal(typeof verdict.say, 'boolean')
  assert.equal(verdict.gap, 6 * HOUR)
  assert.equal(verdict.factor, 1)
})

test('说与不说都留一行账：一次都没说出口的那次也在', () => {
  const home = newHome()
  gate.record(home, { at: T, say: false, why: '静默时段 23:00-08:00，这会儿不主动说' })
  gate.record(home, { at: T + HOUR, say: true, why: '1 条日程过点，还没开过口' })
  const rows = judgeRows(home)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].said, false)
  assert.equal(rows[1].said, true)
  assert.match(rows[0].why, /静默/)
})

test('账本里的情绪只留数字、标签与 kind：不记自然语言', async () => {
  const home = newHome()
  await affectSet(home, { axis: 'v', value: 38, why: '用例：低落', at: T - HOUR })
  const line = gate.record(home, { at: T, say: false, why: '没什么新事，不打扰' })
  assert.deepEqual(Object.keys(line.affect).sort(), ['e', 'mood', 'r', 't', 'v', 'why'])
  assert.equal(line.affect.v, 38)
  assert.equal(Array.isArray(line.affect.why), true)
  for (const kind of line.affect.why) assert.equal(kind.includes('，'), false)
})

test('说过话才推进上次开口：不说就不动水位，免得下一次又被打断', async () => {
  const home = newHome()
  await gate.commit(home, { at: T, say: false, why: '没什么新事，不打扰' })
  assert.equal(debt.lastSaid(home).at, null)
  await gate.commit(home, { at: T + HOUR, say: true, why: '1 条日程过点' })
  assert.equal(debt.lastSaid(home).at, T + HOUR)
})

// ── 处境 ────────────────────────────────────────────────────────────────

test('处境屏要的那几格一个都不少：直接交给渲染层也不崩', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 2 * HOUR, '她说周四去医院复查', ['医院'])
  await plans.add(home, { text: '陪她看牙', due: T + 20 * MINUTE }, { now: T })
  await notes.add(home, { text: '她说想去看海', trigger: '提到周末', when: T }, { now: T })
  await addMemory(
    { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-20261113-01'] }, imp: 2 },
    { home, now: T },
  )
  const scene = situation(home, { now: T })
  assert.equal(scene.clock, '2026-11-13 15:00')
  assert.equal(scene.quiet, false)
  assert.equal(scene.since, null)
  assert.deepEqual(scene.backlog, { unconsolidated: 0, overdue: 0 })
  const screen = renderScreen(scene)
  assert.match(screen, /agent-man · 2026-11-13 15:00/)
  assert.match(screen, /上次开口：还没开过口/)
  assert.match(screen, /日程/)
  assert.match(screen, /便条/)
  assert.match(screen, /最弱的三条/)
})

test('日程的 due 在这里就解释成 when／left／late：渲染层一个 Date 都不用碰', async () => {
  const home = newHome()
  const soon = T + 20 * MINUTE
  await plans.add(home, { text: '陪她看牙', due: soon }, { now: T })
  await plans.add(home, { text: '交房租', due: T - 26 * HOUR }, { now: T })
  const scene = situation(home, { now: T })
  const later = scene.plans.find((one) => one.text === '陪她看牙')
  const past = scene.plans.find((one) => one.text === '交房租')
  assert.equal(later.when, clock(soon))
  assert.equal(typeof later.left, 'string')
  assert.equal(later.late, false)
  assert.equal(past.late, true)
  assert.equal(past.left, '')
  assert.equal(typeof past.when, 'string')
  assert.equal(typeof past.text, 'string')
})

test('上次开口之后的新情景数交给渲染层，连"多久以前"一起给', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 5 * HOUR, '早就关窗了')
  await debt.markSaid(home, T - 3 * HOUR)
  seed(home, 'e-20261113-02', T - 2 * HOUR, '她关了窗')
  seed(home, 'e-20261113-03', T - HOUR, '她又关窗')
  const scene = situation(home, { now: T })
  assert.equal(scene.since.fresh, 2)
  assert.equal(scene.since.text, '3 小时前')
  assert.equal(scene.lastSaid, T - 3 * HOUR)
})

test('积压两格都给数字：什么时候那一行该出现由渲染层定', async () => {
  const home = newHome()
  await debt.bump(home, { at: T, imp: 5 })
  await plans.add(home, { text: '交房租', due: T - HOUR }, { now: T })
  const scene = situation(home, { now: T })
  assert.equal(scene.backlog.unconsolidated, 5)
  assert.equal(scene.backlog.overdue, 1)
  assert.match(renderScreen(scene), /积压：5 条待巩固 · 1 条过期日程/)
})

test('预算装不下就从尾巴丢：丢了几条、为什么、要多少，全留着', async () => {
  const home = newHome()
  for (let i = 1; i <= 4; i += 1) {
    await plans.add(home, { text: `第 ${i} 件事`, due: T + i * HOUR }, { now: T })
  }
  const scene = situation(home, { now: T, budget: 40 })
  assert.ok(scene.plans.length < 4)
  assert.equal(scene.over, false)
  assert.ok(scene.used <= scene.budget)
  assert.ok(scene.dropped.length > 0)
  for (const one of scene.dropped) {
    assert.equal(one.reason, 'budget')
    assert.equal(one.why.startsWith('丢：'), true)
  }
})

test('预算比抬头还小就认账：标出超了，一条也不硬塞', () => {
  const home = newHome()
  const scene = situation(home, { now: T, budget: 5 })
  assert.equal(scene.over, true)
  assert.deepEqual([scene.plans.length, scene.notes.length, scene.weakest.length], [0, 0, 0])
  assert.equal(scene.used, scene.head.cost)
})

test('预算花在哪能复核：抬头加条目按 costOf 一项项加起来等于 used', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 2 * HOUR, '她说周四去医院复查')
  await plans.add(home, { text: '陪她看牙', due: T + 20 * MINUTE }, { now: T })
  await notes.add(home, { text: '她说想去看海', trigger: '提到周末', when: T }, { now: T })
  await addMemory(
    { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-20261113-01'] }, imp: 2 },
    { home, now: T },
  )
  const scene = situation(home, { now: T })
  const plan = scene.plans[0]
  const note = scene.notes[0]
  const weak = scene.weakest[0]
  const sum = scene.head.cost
    + costOf([plan.when, plan.text, plan.left].filter(Boolean).join(' '))
    + costOf([note.text, note.trigger].filter(Boolean).join(' '))
    + costOf([weak.text, weak.r.toFixed(2), String(weak.seen), weak.id].filter(Boolean).join(' '))
  assert.equal(Math.round(sum * 1000), Math.round(scene.used * 1000))
  assert.equal(scene.budget, config.DEFAULTS.inject.situation)
})

test('一屏每段最多四条：多出来的按上限丢，并留一句为什么', async () => {
  const home = newHome()
  const many = SECTION_ITEMS_MAX + 1
  for (let i = 1; i <= many; i += 1) {
    await notes.add(home, { text: `便条 ${i}`, when: T }, { now: T })
  }
  const scene = situation(home, { now: T })
  assert.equal(scene.notes.length, SECTION_ITEMS_MAX)
  const cut = scene.dropped.filter((one) => one.section === '便条')
  assert.equal(cut.length, 1)
  assert.equal(cut[0].reason, 'limit')
})

test('最弱的三条：按留存从低到高排，只给三条', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - 30 * 24 * HOUR, '很久以前的事')
  for (let i = 1; i <= 5; i += 1) {
    await addMemory(
      {
        key: `槽位 ${i}`,
        fact: `第 ${i} 条结论`,
        at: T - i * 3 * 24 * HOUR,
        evidence: { ids: ['e-20261113-01'] },
        imp: 1,
      },
      { home, now: T },
    )
  }
  const scene = situation(home, { now: T })
  assert.equal(scene.weakest.length, 3)
  const rs = scene.weakest.map((one) => one.r)
  assert.deepEqual(rs.slice().sort((a, b) => a - b), rs)
  for (const one of scene.weakest) {
    assert.equal(typeof one.id, 'string')
    assert.equal(typeof one.text, 'string')
    assert.equal(Number.isFinite(one.seen), true)
  }
})

test('读坏行跳过并计数：一行坏掉不让整屏读不出来，也不装作没发生', () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR)
  fs.appendFileSync(eventsFile(home, T), 'not json\n', 'utf8')
  fs.appendFileSync(path.join(home, 'memory.jsonl'), 'not json\n', 'utf8')
  const scene = situation(home, { now: T })
  assert.equal(scene.bad.events, 1)
  assert.equal(scene.bad.memory, 1)
})

test('插件建议在 v 与 e 没到口子时一条都不上屏，但每条都记下为什么', async () => {
  const home = newHome()
  // AFFECT_BASE 是 v=50 e=60：理性线之下，正是"不主动提建议"的那一刻。
  await affectSet(home, { axis: 'v', value: 50, why: '用例：普通', at: T - HOUR })
  await affectSet(home, { axis: 'e', value: 60, why: '用例：普通', at: T - HOUR })
  const scene = situation(home, { now: T, parts: [{ name: '天气', text: '要下雨' }] })
  assert.deepEqual(scene.suggest, [])
  const gone = scene.dropped.filter((one) => one.reason === 'affect')
  assert.equal(gone.length, 1, '被口子挡下的建议要在 dropped 里点名')
  assert.equal(gone[0].section, '建议')
  assert.match(gone[0].why, /v≥65 且 e≥76/)
})

test('同一处境只把 v 抬过口子：唯一的差别就是那一条建议上不上屏', async () => {
  const home = newHome()
  await affectSet(home, { axis: 'v', value: 64, why: '用例：差一分', at: T - HOUR })
  await affectSet(home, { axis: 'e', value: 80, why: '用例：有劲', at: T - HOUR })
  const below = situation(home, { now: T, parts: [{ name: '天气', text: '要下雨' }] })
  await affectSet(home, { axis: 'v', value: 65, why: '用例：正好到线', at: T - HOUR + 1 })
  const above = situation(home, { now: T, parts: [{ name: '天气', text: '要下雨' }] })
  assert.deepEqual(below.suggest, [])
  assert.deepEqual(above.suggest, [{ name: '天气', text: '要下雨' }])
  // 除了这一段与它带来的 dropped，屏上别处一个字都不许变（design §14.5 的"只差一处"）。
  const strip = (one) => {
    const { suggest, dropped, used, ...rest } = one
    return { ...rest, dropped: dropped.filter((two) => two.section !== '建议') }
  }
  assert.deepEqual(strip(above), strip(below))
  assert.ok(above.used > below.used, '上了屏的建议要真占预算')
})

test('建议最多一条：多出来的零件答话记 limit，不并成一段', async () => {
  const home = newHome()
  await affectSet(home, { axis: 'v', value: 90, why: '用例：高兴', at: T - HOUR })
  await affectSet(home, { axis: 'e', value: 90, why: '用例：有劲', at: T - HOUR })
  const scene = situation(home, {
    now: T,
    parts: [{ name: '天气', text: '要下雨' }, { name: '日程助手', text: '该订票了' }],
  })
  assert.deepEqual(scene.suggest, [{ name: '天气', text: '要下雨' }])
  const over = scene.dropped.filter((one) => one.reason === 'limit' && one.section === '建议')
  assert.equal(over.length, 1)
  assert.match(over[0].why, /一屏只放 1 条建议/)
})

test('建议也要跟日程便条抢同一份预算：装不下的记 budget，不悄悄塞进去', async () => {
  const home = newHome()
  await affectSet(home, { axis: 'v', value: 90, why: '用例：高兴', at: T - HOUR })
  await affectSet(home, { axis: 'e', value: 90, why: '用例：有劲', at: T - HOUR })
  const scene = situation(home, {
    now: T,
    budget: 30,
    parts: [{ name: '天气', text: '要'.repeat(120) }],
  })
  assert.deepEqual(scene.suggest, [])
  assert.equal(scene.dropped.some((one) => one.reason === 'budget' && one.section === '建议'), true)
})

test('sense 的整包也认：{lines} 与拆好的行数组是同一件事', async () => {
  const home = newHome()
  await affectSet(home, { axis: 'v', value: 90, why: '用例：高兴', at: T - HOUR })
  await affectSet(home, { axis: 'e', value: 90, why: '用例：有劲', at: T - HOUR })
  const asBox = situation(home, { now: T, parts: { lines: [{ name: '天气', section: '环境', text: '要下雨' }] } })
  const asArray = situation(home, { now: T, parts: [{ name: '天气', text: '要下雨' }] })
  assert.deepEqual(asBox.suggest, asArray.suggest)
})

test('design §7 的那个入口形状也认：单对象传 home 与传位置参数给同一份处境', async () => {
  const home = newHome()
  await plans.add(home, { text: '陪她看牙', due: T + 20 * MINUTE }, { now: T })
  const byPos = situation(home, { now: T })
  const byObj = build({ home, now: T })
  assert.deepEqual(byObj, byPos)
})

test('配置里改了处境预算，这一屏就按新预算装', () => {
  const home = newHome()
  fs.writeFileSync(
    path.join(home, 'config.json'),
    `${JSON.stringify({ version: 1, inject: { situation: 90 } }, null, 2)}\n`,
  )
  const scene = situation(home, { now: T })
  assert.equal(scene.budget, 90)
})

test('处境是读命令：算一遍不写盘', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR)
  await plans.add(home, { text: '陪她看牙', due: T + HOUR }, { now: T })
  const before = snapshot(home)
  situation(home, { now: T })
  assert.deepEqual(snapshot(home), before)
})

// ── 简报 ────────────────────────────────────────────────────────────────

test('简报把三块拼成一页：说与不说、几点的处境、账上压着什么，一次给全', async () => {
  const home = newHome()
  await plans.add(home, { text: '交房租', due: T - HOUR }, { now: T })
  const page = brief(home, { now: T })
  assert.equal(page.at, T)
  assert.equal(page.say, true)
  assert.match(page.why, /日程过点/)
  assert.equal(page.situation.clock, '2026-11-13 15:00')
  assert.equal(page.gate.say, true)
  assert.equal(page.debt.overdue.length, 1)
  assert.deepEqual(page.warnings, [])
})

test('简报是读命令：算一遍不写盘，也不顺手记账', async () => {
  const home = newHome()
  seed(home, 'e-20261113-01', T - HOUR)
  const before = snapshot(home)
  brief(home, { now: T })
  assert.deepEqual(snapshot(home), before)
})

// 用例跑完把临时数据目录删掉：一次全量会开出上百个，留在系统临时目录里就是垃圾（AGENTS 六）。
test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})
