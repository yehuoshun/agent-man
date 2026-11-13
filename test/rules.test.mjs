import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { RULE_LIMIT, RULE_MAX, cost } from '../src/core/index.mjs'
import { addRule, listRules } from '../src/memory/index.mjs'

const DAY = 24 * 60 * 60 * 1000
// 时间用例一律传死 now（AGENTS 六）：规矩不衰减，但排序与标题日期都得可复现。
const NOW = new Date(2026, 10, 13, 21, 40, 0).getTime()

const HOMES = []

function newHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  return dir
}

function rulesPath(home) {
  return path.join(home, 'rules.jsonl')
}

function rawRules(home) {
  const file = rulesPath(home)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

async function seed(home, { text = '走之前先关窗', why = '上次下雨淋湿了地板', at, now = NOW } = {}) {
  return addRule(home, { text, why, at, now })
}

test('addRule 落一行，形状是 design §4 的六个字段', async () => {
  const home = newHome()
  const added = await seed(home)
  const rows = rawRules(home)
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'id', 'seen', 'supersedes', 'text', 'why'])
  assert.equal(rows[0].id, added.id)
  assert.equal(rows[0].text, '走之前先关窗')
  assert.equal(rows[0].why, '上次下雨淋湿了地板')
  assert.deepEqual(rows[0].supersedes, [])
  assert.equal(rows[0].seen, 0)
  assert.equal(rows[0].at, NOW)
})

test('规矩 id 走 claim 发号：r- 开头，两次写入拿到不同的号', async () => {
  const home = newHome()
  const first = await seed(home, { text: '第一条' })
  const second = await seed(home, { text: '第二条' })
  assert.match(first.id, /^r-\d{8}-\d+$/)
  assert.notEqual(first.id, second.id)
})

test('text 缺省或空白：拒绝，盘上不多一行', async () => {
  const home = newHome()
  await assert.rejects(() => addRule(home, { why: '有理由也算没立成' }), /text 必须是非空字符串/)
  await assert.rejects(() => addRule(home, { text: '   ', why: '空白不是规矩' }), /text 必须是非空字符串/)
  assert.deepEqual(rawRules(home), [])
})

test('why 必填：没有理由的规矩不许立', async () => {
  const home = newHome()
  await assert.rejects(() => addRule(home, { text: '别在深夜 commit' }), /why 必须是非空字符串/)
  await assert.rejects(() => addRule(home, { text: '别在深夜 commit', why: '  ' }), /why 必须是非空字符串/)
  assert.deepEqual(rawRules(home), [])
})

test('text 超 RULE_MAX：拒绝，并用 cost 真算说出超了多少', async () => {
  const home = newHome()
  const long = '规'.repeat(Math.ceil(RULE_MAX) + 5)
  const used = cost(long)
  assert.ok(used > RULE_MAX)
  await assert.rejects(
    () => addRule(home, { text: long, why: '太长' }),
    new RegExp(`规矩的预算是 ${RULE_MAX} cost`),
  )
  assert.deepEqual(rawRules(home), [])
})

test('supersedes 点名旧条：活条只剩新条，旧行仍在盘上', async () => {
  const home = newHome()
  const old = await seed(home, { text: '走之前先关窗' })
  const added = await seed(home, { text: '走之前先关窗并拔插头', at: NOW + DAY })
  const replaced = await addRule(home, {
    text: '走之前关窗',
    why: '拔插头那条太麻烦，改成只要关窗',
    supersedes: [old.id, added.id],
    at: NOW + 2 * DAY,
    now: NOW,
  })
  const listed = listRules(home, { now: NOW })
  assert.equal(listed.live, 1)
  assert.deepEqual(listed.items.map((rec) => rec.id), [replaced.id])
  // 旧条永不改写：三行都在，一行都没被改。
  assert.equal(rawRules(home).length, 3)
})

test('supersede 之后旧行逐字不变：只在新条里记 supersedes', async () => {
  const home = newHome()
  const old = await seed(home)
  const lineBefore = fs.readFileSync(rulesPath(home), 'utf8')
  await addRule(home, { text: '改成走之前关窗并锁门', why: '锁门更重要', supersedes: [old.id], now: NOW })
  const lineAfter = fs.readFileSync(rulesPath(home), 'utf8')
  assert.ok(lineAfter.startsWith(lineBefore), '旧行必须原封不动地留在前面')
  const rows = rawRules(home)
  assert.deepEqual(rows[0].supersedes, [], '旧条的 supersedes 不该被补写')
})

test('活条按 at 倒序：只比数字差，不比字符串', async () => {
  const home = newHome()
  const first = await seed(home, { text: '早上先喝水', at: NOW - 2 * DAY })
  const second = await seed(home, { text: '中午先吃饭', at: NOW - DAY })
  const third = await seed(home, { text: '晚上先关窗', at: NOW })
  const listed = listRules(home, { now: NOW })
  assert.deepEqual(listed.items.map((rec) => rec.id), [third.id, second.id, first.id])
})

test(`活条上限 RULE_LIMIT=${RULE_LIMIT} 是写入口的事：第 ${RULE_LIMIT + 1} 条不带 supersedes 就拒绝`, async () => {
  const home = newHome()
  for (let i = 0; i < RULE_LIMIT; i += 1) await seed(home, { text: `第 ${i + 1} 条`, at: NOW + i })
  assert.equal(listRules(home, { now: NOW }).live, RULE_LIMIT)
  await assert.rejects(
    () => seed(home, { text: '挤不上来的第 21 条', at: NOW + RULE_LIMIT }),
    new RegExp(`上限是 ${RULE_LIMIT} 条`),
  )
  assert.equal(rawRules(home).length, RULE_LIMIT, '被拒的规矩不许落盘')
})

test('满额时点名替代一条：写进去了，活条仍是 RULE_LIMIT', async () => {
  const home = newHome()
  const ids = []
  for (let i = 0; i < RULE_LIMIT; i += 1) {
    const added = await seed(home, { text: `第 ${i + 1} 条`, at: NOW + i })
    ids.push(added.id)
  }
  const added = await addRule(home, {
    text: '取代第一条的新规矩',
    why: '第一条不再成立',
    supersedes: [ids[0]],
    at: NOW + RULE_LIMIT,
    now: NOW,
  })
  const listed = listRules(home, { now: NOW })
  assert.equal(listed.live, RULE_LIMIT)
  assert.equal(listed.over, 0)
  assert.ok(listed.items.some((rec) => rec.id === added.id))
  assert.ok(!listed.items.some((rec) => rec.id === ids[0]))
})

test('supersedes 里的未知 id：拒绝，不替人猜一条', async () => {
  const home = newHome()
  await assert.rejects(
    () => addRule(home, { text: '新规矩', why: '替代一条不存在的', supersedes: ['r-20260101-99'], now: NOW }),
    /不存在/,
  )
  assert.deepEqual(rawRules(home), [])
})

test('supersedes 点一条已经被取代的旧条：拒绝，不二次取代', async () => {
  const home = newHome()
  const old = await seed(home)
  await addRule(home, { text: '新条', why: '替代旧的', supersedes: [old.id], now: NOW })
  await assert.rejects(
    () => addRule(home, { text: '再替一次', why: '旧的已经死过一次', supersedes: [old.id], now: NOW }),
    /已被取代/,
  )
})

test('supersedes 重复给同一个 id：只记一次', async () => {
  const home = newHome()
  const old = await seed(home)
  const added = await addRule(home, {
    text: '新条',
    why: '替代旧的',
    supersedes: [old.id, old.id],
    now: NOW,
  })
  assert.deepEqual(rawRules(home)[1].supersedes, [old.id])
  assert.deepEqual(added.superseded, [old.id])
})

test('supersedes 不是数组：拒绝，明说该给什么形状', async () => {
  const home = newHome()
  await assert.rejects(
    () => addRule(home, { text: '新条', why: '理由', supersedes: 'r-20260101-01', now: NOW }),
    /supersedes 必须是 id 数组/,
  )
})

test('坏行跳过并计数：一行坏掉不丢整份规矩，也不装没发生', async () => {
  const home = newHome()
  const added = await seed(home)
  fs.appendFileSync(rulesPath(home), '这不是 JSON\n')
  const listed = listRules(home, { now: NOW })
  assert.equal(listed.skipped, 1)
  assert.deepEqual(listed.items.map((rec) => rec.id), [added.id])
})

test('缺 why 的行算坏行：不当活条，只计进 skipped', async () => {
  const home = newHome()
  const added = await seed(home)
  const broken = { id: 'r-20260101-01', at: NOW, text: '没有理由的规矩', supersedes: [], seen: 0 }
  fs.appendFileSync(rulesPath(home), `${JSON.stringify(broken)}\n`)
  const listed = listRules(home, { now: NOW })
  assert.equal(listed.skipped, 1)
  assert.deepEqual(listed.items.map((rec) => rec.id), [added.id])
})

test('规矩不衰减：一年前立的仍在活条里（S0_RULE 是 Infinity，不看窗口）', async () => {
  const home = newHome()
  const longAgo = NOW - 365 * DAY
  const added = await seed(home, { text: '陈年规矩', at: longAgo })
  const listed = listRules(home, { now: NOW })
  assert.deepEqual(listed.items.map((rec) => rec.id), [added.id])
})

test('all 给全量：每条带 live 布尔，死条也读得出来', async () => {
  const home = newHome()
  const old = await seed(home, { text: '旧的' })
  const added = await addRule(home, { text: '新的', why: '替代旧的', supersedes: [old.id], now: NOW })
  const all = listRules(home, { all: true, now: NOW })
  assert.equal(all.total, 2)
  const byId = new Map(all.items.map((rec) => [rec.id, rec.live]))
  assert.equal(byId.get(old.id), false)
  assert.equal(byId.get(added.id), true)
})

test('读命令不写盘：listRules 前后字节不变，空目录也不抛不建库', () => {
  const empty = newHome()
  const onEmpty = listRules(empty, { now: NOW })
  assert.deepEqual(onEmpty.items, [])
  assert.equal(onEmpty.live, 0)
  assert.equal(onEmpty.skipped, 0)
  assert.deepEqual(fs.readdirSync(empty), [], '读不在别人的数据目录里建东西')

  // 一行缺字段的旧行：读得进去但读不成规矩，算坏行。
  const home = newHome()
  fs.writeFileSync(rulesPath(home), `${JSON.stringify({ id: 'r-1', at: NOW })}\n`)
  const before = fs.readFileSync(rulesPath(home))
  listRules(home, { now: NOW, all: true })
  assert.deepEqual(fs.readFileSync(rulesPath(home)), before)
})

test('数据里活条超过上限：不删也不抛，把超出的条数交给调用方报 ! ', async () => {
  const home = newHome()
  for (let i = 0; i <= RULE_LIMIT; i += 1) {
    // 绕过门面直接追加：模拟"上限被改小"或别人写进来的历史数据。
    const row = { id: `r-20260101-${i}`, at: NOW + i, text: `第 ${i} 条`, why: '外来的', supersedes: [], seen: 0 }
    fs.appendFileSync(rulesPath(home), `${JSON.stringify(row)}\n`)
  }
  const listed = listRules(home, { now: NOW })
  assert.equal(listed.live, RULE_LIMIT + 1)
  assert.equal(listed.over, 1)
  assert.equal(rawRules(home).length, RULE_LIMIT + 1, '读不能顺手删规矩')
})

test('缺 home：明确报错，不往当前工作目录写规矩', async () => {
  await assert.rejects(() => addRule(undefined, { text: '规矩', why: '理由', now: NOW }), /需要一个数据目录/)
  assert.throws(() => listRules(''), /需要一个数据目录/)
})

// 用例跑完把临时数据目录删掉：一次全量会开出上百个，留在系统临时目录里就是垃圾（AGENTS 六）。
test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})
