import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MEMORY_MAX, cost } from '../src/core/index.mjs'
import { add, conflict, find, list, ls, orphan, revise, show } from '../src/memory/index.mjs'
import { appendJsonl, ensure, eventsFile } from '../src/store/index.mjs'

const DAY = 24 * 60 * 60 * 1000
// 时间用例一律传死 now（AGENTS 六）；用本地时间构造，CI 的纽约时区腿也成立。
const NOW = new Date(2026, 10, 13, 21, 40, 0).getTime()

function newHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
}

function ctxOf(home, now = NOW) {
  return { home, now }
}

function memoryPath(home) {
  return path.join(home, 'memory.jsonl')
}

function seedEvent(home, id, at = NOW, text = '她关窗') {
  ensure(home)
  appendJsonl(eventsFile(home, at), { id, at, text, src: { origin: 'user' } })
  return { id, at }
}

function rawRows(home) {
  const file = memoryPath(home)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

async function one(home, { key = '她怕冷', fact = '她关窗是因为冷', at, from, imp, evidence, now = NOW } = {}) {
  const event = seedEvent(home, `e-${Math.random().toString(36).slice(2, 8)}`, at ?? now)
  return add(
    { key, fact, at, from, imp, evidence: evidence ?? { ids: [event.id] } },
    ctxOf(home, now),
  )
}

test('同 key 写第二条：旧记录收口，新记录继承旧的 from', async () => {
  const home = newHome()
  const first = await one(home, { fact: '她关窗是因为冷', from: NOW - 5 * DAY })
  const second = await one(home, { fact: '她关窗是因为怕吵', now: NOW + 1000 })
  const rows = await ls({ all: true }, ctxOf(home))
  const old = rows.items.find((rec) => rec.id === first.id)
  const fresh = rows.items.find((rec) => rec.id === second.id)
  assert.equal(old.to, second.record.at)
  assert.equal(old.by, second.id)
  assert.equal(fresh.to, null)
  assert.equal(fresh.from, old.from)
  assert.equal(rows.items.filter((rec) => rec.key === '她怕冷' && rec.to === null).length, 1)
})

test('同 key 第二条只追加：原行逐字不动（旧行永不改写）', async () => {
  const home = newHome()
  const first = await one(home)
  const before = rawRows(home)
  await one(home, { fact: '她关窗是因为怕吵' })
  const after = rawRows(home)
  assert.deepEqual(after[0], before[0])
  assert.equal(after[0].to, null)
  assert.equal(after.length, 3) // 新条 + 旧条收口版本；原文仍在原位
})

test('同 key 同 fact 同 imp：不写新记录，返回 same', async () => {
  const home = newHome()
  const first = await one(home, { imp: 2 })
  const rowsBefore = rawRows(home)
  const again = await add(
    { key: '她怕冷', fact: '她关窗是因为冷', imp: 2, evidence: { ids: [rowsBefore[0].evidence.ids[0]] } },
    ctxOf(home),
  )
  assert.equal(again.status, 'same')
  assert.equal(again.id, first.id)
  assert.equal(rawRows(home).length, rowsBefore.length)
})

test('同 fact 不同 imp 不算同一个结论：写新版本并收口旧的', async () => {
  const home = newHome()
  const first = await one(home, { imp: 0 })
  const second = await one(home, { imp: 3, now: NOW + 1000 })
  assert.equal(second.status, 'added')
  assert.notEqual(second.id, first.id)
  const rows = await ls({ all: true }, ctxOf(home))
  assert.equal(rows.items.find((rec) => rec.id === first.id).to, second.record.at)
})

test('key 前后空格先 trim：同一个槽位不该因为空格变成两条', async () => {
  const home = newHome()
  const first = await one(home, { key: '  她怕冷  ' })
  const again = await one(home, { key: '她怕冷' })
  assert.equal(again.status, 'same')
  assert.equal(again.id, first.id)
})

test('不同 key 互不干扰：各留各的活记录', async () => {
  const home = newHome()
  const a = await one(home, { key: '她怕冷' })
  const b = await one(home, { key: '她怕吵' })
  const rows = await ls({ all: true }, ctxOf(home))
  assert.equal(rows.items.find((rec) => rec.id === a.id).to, null)
  assert.equal(rows.items.find((rec) => rec.id === b.id).to, null)
})

test('新记录 seen 从 0 起、imp 缺省 0', async () => {
  const home = newHome()
  const first = await one(home)
  assert.equal(first.record.seen, 0)
  assert.equal(first.record.imp, 0)
})

test('同一毫秒连写两条：后一条 at 至少晚 1ms，[from, to) 仍然非空', async () => {
  const home = newHome()
  const first = await one(home, { fact: '第一版' })
  const second = await one(home, { fact: '第二版' })
  assert.equal(second.record.at, first.record.at + 1)
  assert.ok(second.record.to === null)
})

test('证据解析不到任何真实事件：拒绝写盘，不写半条记忆', async () => {
  const home = newHome()
  await assert.rejects(
    add({ key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-不存在'] } }, ctxOf(home)),
    /真实事件/,
  )
  assert.equal(fs.existsSync(memoryPath(home)), false)
})

test('证据只命中一部分：仍可写，未命中的留给 orphan 报出', async () => {
  const home = newHome()
  const event = seedEvent(home, 'e-20261113-01')
  const written = await add(
    { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: [event.id, 'e-ghost'] } },
    ctxOf(home),
  )
  assert.deepEqual(written.record.evidence.ids, ['e-20261113-01', 'e-ghost'])
  const audit = orphan(ctxOf(home))
  assert.deepEqual(audit.items.map((item) => item.missing), [['e-ghost']])
})

test('fact 超过 MEMORY_MAX：拒绝，并说清预算是多少', async () => {
  const home = newHome()
  const event = seedEvent(home, 'e-20261113-02')
  const fact = '很'.repeat(MEMORY_MAX + 2)
  assert.ok(cost(fact) > MEMORY_MAX) // 真跑 cost 复核，不靠猜字数
  await assert.rejects(
    add({ key: '她怕冷', fact, evidence: { ids: [event.id] } }, ctxOf(home)),
    new RegExp(String(MEMORY_MAX)),
  )
})

test('空 key / 空 fact：拒绝，而不是写一条没有槽位的记忆', async () => {
  const home = newHome()
  const event = seedEvent(home, 'e-20261113-03')
  await assert.rejects(
    add({ key: '   ', fact: '她关窗是因为冷', evidence: { ids: [event.id] } }, ctxOf(home)),
    /key 必须是非空字符串/,
  )
  await assert.rejects(
    add({ key: '她怕冷', fact: '  ', evidence: { ids: [event.id] } }, ctxOf(home)),
    /fact 必须是非空字符串/,
  )
})

test('ls 默认只给 30 天窗口内：更早的记录要 --all 或 since 才读得到', async () => {
  const home = newHome()
  const old = await one(home, { key: '旧事', fact: '四十天前的事', at: NOW - 40 * DAY, now: NOW - 40 * DAY })
  const fresh = await one(home, { key: '新事', fact: '今天的事' })
  const byDefault = await ls({}, ctxOf(home))
  assert.deepEqual(byDefault.items.map((rec) => rec.id), [fresh.id])
  const all = await ls({ all: true }, ctxOf(home))
  assert.deepEqual(all.items.map((rec) => rec.id).sort(), [old.id, fresh.id].sort())
  const wide = await ls({ since: NOW - 41 * DAY }, ctxOf(home))
  assert.equal(wide.items.length, 2)
})

test('30 天窗口边界：正好 30 天前还在窗口里', async () => {
  const home = newHome()
  const edge = await one(home, { at: NOW - 30 * DAY, now: NOW - 30 * DAY })
  const listed = await ls({}, ctxOf(home))
  assert.deepEqual(listed.items.map((rec) => rec.id), [edge.id])
})

test('ls 按 at 倒序，key 过滤是精确匹配', async () => {
  const home = newHome()
  const a = await one(home, { key: '她怕冷', fact: '早' })
  const b = await one(home, { key: '她怕冷', fact: '晚', now: NOW + 5000 })
  const c = await one(home, { key: '她怕吵', fact: '另一槽位' })
  const listed = await ls({ all: true }, ctxOf(home))
  assert.deepEqual(listed.items.map((rec) => rec.id), [b.id, c.id, a.id])
  const keyed = await ls({ all: true, key: '她怕冷' }, ctxOf(home))
  assert.deepEqual(keyed.items.map((rec) => rec.id), [b.id, a.id])
})

test('list 与 ls 是同一个读法（design §7 叫 list）', async () => {
  const home = newHome()
  const written = await one(home)
  assert.deepEqual(list({ all: true }, ctxOf(home)).items, ls({ all: true }, ctxOf(home)).items)
  assert.equal(list({ all: true }, ctxOf(home)).items[0].id, written.id)
})

test('key 过滤给空串：拒绝，空库上也不装作没看见', async () => {
  const home = newHome()
  assert.throws(() => ls({ all: true, key: '  ' }, ctxOf(home)), /key 过滤要给非空槽位名/)
})

test('find 只做字面搜索：不做语义相似度，也不搜 key', async () => {
  const home = newHome()
  const written = await one(home, { key: '她怕冷', fact: '她关窗是因为冷' })
  const hit = await find('关窗', {}, ctxOf(home))
  assert.deepEqual(hit.items.map((rec) => rec.id), [written.id])
  const byKey = await find('她怕冷', {}, ctxOf(home))
  assert.deepEqual(byKey.items, [])
  const semantic = await find('空调', {}, ctxOf(home))
  assert.deepEqual(semantic.items, [])
})

test('find 空查询：拒绝，不把整库倒出来', async () => {
  const home = newHome()
  assert.throws(() => find('   ', {}, ctxOf(home)), /非空查询/)
})

test('revise 只追加新版本：旧记录收口，新版本改 fact，from/key/evidence 不变', async () => {
  const home = newHome()
  const first = await one(home, { imp: 1 })
  const revised = await revise(first.id, { fact: '她关窗是因为怕吵' }, ctxOf(home, NOW + 2000))
  assert.equal(revised.status, 'revised')
  assert.notEqual(revised.id, first.id)
  assert.equal(revised.record.key, first.record.key)
  assert.equal(revised.record.from, first.record.from)
  assert.deepEqual(revised.record.evidence, first.record.evidence)
  assert.equal(revised.record.by, first.id)
  const rows = await ls({ all: true }, ctxOf(home))
  const old = rows.items.find((rec) => rec.id === first.id)
  assert.equal(old.to, revised.record.at)
  assert.equal(old.by, revised.id)
  assert.equal(rows.items.filter((rec) => rec.to === null).length, 1)
})

test('revise 不许改 at / id / key / from：历史坐标不可重写', async () => {
  const home = newHome()
  const first = await one(home)
  for (const field of ['at', 'id', 'key', 'from']) {
    await assert.rejects(revise(first.id, { [field]: 1 }, ctxOf(home)), /只能改 fact \/ imp/)
  }
})

test('revise 已失效的记录：拒绝，不复活旧版本', async () => {
  const home = newHome()
  const first = await one(home, { fact: '第一版' })
  await one(home, { fact: '第二版' })
  await assert.rejects(revise(first.id, { fact: '想复活' }, ctxOf(home)), /已被/)
})

test('同 key 两条活记录算冲突：conflict 报出，不自动消解', async () => {
  const home = newHome()
  const first = await one(home)
  // 模拟"写完新条、还没收口旧条"就崩了：两条都还活着。
  appendJsonl(memoryPath(home), {
    ...first.record,
    id: 'm-19700101-99',
    at: first.record.at + 1000,
    fact: '崩在半路的那条',
  })
  const found = conflict('她怕冷', ctxOf(home))
  assert.equal(found.items.length, 1)
  assert.deepEqual(found.items[0].ids.sort(), [first.id, 'm-19700101-99'].sort())
  assert.equal((await ls({}, ctxOf(home))).items.length, 2) // 读命令只是报出，不写盘消解
})

test('conflict 在健康数据上返回空：不把正常版本链当冲突', async () => {
  const home = newHome()
  const first = await one(home, { fact: '第一版' })
  await revise(first.id, { fact: '第二版' }, ctxOf(home, NOW + 1000))
  assert.deepEqual(conflict('她怕冷', ctxOf(home)).items, [])
  assert.deepEqual(conflict(ctxOf(home)).items, [])
})

test('add 碰到多条活记录：全部收口并在 replaced 里点名（并发不静默吞）', async () => {
  const home = newHome()
  const first = await one(home)
  appendJsonl(memoryPath(home), {
    ...first.record,
    id: 'm-19700101-98',
    at: first.record.at + 1000,
    fact: '并发写进来的另一条',
  })
  const third = await one(home, { fact: '第三版', now: NOW + 5000 })
  assert.deepEqual(third.replaced.sort(), [first.id, 'm-19700101-98'].sort())
  assert.equal((await ls({}, ctxOf(home))).items.length, 1)
})

test('show 给 id：单条 + 证据命中情况 + 版本链（at 升序）', async () => {
  const home = newHome()
  const event = seedEvent(home, 'e-20261113-04')
  const first = await add(
    { key: '她怕冷', fact: '第一版', evidence: { ids: [event.id, 'e-ghost'] } },
    ctxOf(home),
  )
  const revised = await revise(first.id, { fact: '第二版' }, ctxOf(home, NOW + 1000))
  const detail = show(first.id, ctxOf(home))
  assert.equal(detail.record.id, first.id)
  assert.deepEqual(detail.evidence, [
    { id: 'e-20261113-04', found: true },
    { id: 'e-ghost', found: false },
  ])
  assert.deepEqual(detail.chain.map((item) => item.id), [first.id, revised.id])
  assert.deepEqual(detail.chain.map((item) => item.live), [false, true])
})

test('show 给唯一活 key：读到该条；未知 id 返回 record=null 而不是抛', async () => {
  const home = newHome()
  const first = await one(home)
  assert.equal(show('她怕冷', ctxOf(home)).record.id, first.id)
  assert.equal(show('m-不存在', ctxOf(home)).record, null)
})

test('show 的 key 有多条活记录：报错，不替人挑一条', async () => {
  const home = newHome()
  const first = await one(home)
  appendJsonl(memoryPath(home), { ...first.record, id: 'm-19700101-97', at: first.record.at + 1000 })
  assert.throws(() => show('她怕冷', ctxOf(home)), /冲突/)
})

test('orphan 只报不删：坏证据记录仍然活着，读盘行数不变', async () => {
  const home = newHome()
  const event = seedEvent(home, 'e-20261113-05')
  await add(
    { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: [event.id, 'e-ghost'] } },
    ctxOf(home),
  )
  const before = rawRows(home)
  const audit = orphan(ctxOf(home))
  assert.equal(audit.items.length, 1)
  assert.deepEqual(audit.items[0].missing, ['e-ghost'])
  assert.equal(audit.items[0].live, true)
  assert.deepEqual(rawRows(home), before)
})

test('坏行跳过并计数：一行坏掉不丢整份记忆，也不装没发生', async () => {
  const home = newHome()
  const written = await one(home)
  fs.appendFileSync(memoryPath(home), 'not json at all\n')
  fs.appendFileSync(memoryPath(home), `${JSON.stringify({ id: 42, at: 'x' })}\n`)
  const listed = await ls({ all: true }, ctxOf(home))
  assert.deepEqual(listed.items.map((rec) => rec.id), [written.id])
  assert.equal(listed.skipped, 2)
  const detail = show(written.id, ctxOf(home))
  assert.equal(detail.skipped, 2) // 记忆里两条坏行被跳过并计数，不抛
})

test('读命令不写盘：ls / find / show / conflict / orphan 前后字节不变', async () => {
  const home = newHome()
  const written = await one(home)
  const before = fs.readFileSync(memoryPath(home))
  const ctx = ctxOf(home)
  ls({ all: true }, ctx)
  find('关窗', {}, ctx)
  show(written.id, ctx)
  conflict(ctx)
  orphan(ctx)
  assert.deepEqual(fs.readFileSync(memoryPath(home)), before)
})

test('空数据目录读命令不抛、也不顺手建库', async () => {
  const home = newHome()
  assert.deepEqual(ls({ all: true }, ctxOf(home)).items, [])
  assert.deepEqual(find('关窗', {}, ctxOf(home)).items, [])
  assert.equal(show('她怕冷', ctxOf(home)).record, null)
  assert.deepEqual(conflict(ctxOf(home)).items, [])
  assert.equal(fs.existsSync(memoryPath(home)), false)
})

test('缺 ctx.home：明确报错，不往当前工作目录写记忆', async () => {
  await assert.rejects(add({ key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-1'] } }), /ctx\.home/)
  assert.throws(() => ls({ all: true }), /ctx\.home/)
})
