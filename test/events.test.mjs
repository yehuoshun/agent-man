import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { EVENTS_MAX, cost } from '../src/core/index.mjs'
import { eventAdd, events } from '../src/memory/index.mjs'
import { readJsonl, eventsFile } from '../src/store/index.mjs'

// 时间用例一律传死 now（AGENTS 六）；用本地时间构造，CI 的纽约时区腿也成立。
const NOW = new Date(2026, 10, 13, 21, 40, 0).getTime()

function newHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
}

function ctxOf(home, now = NOW) {
  return { home, now }
}

// 读回那一日分片里的原文行：情景不允许"读出来长得不一样"。
function rowsOf(home, at = NOW) {
  return readJsonl(eventsFile(home, at)).items
}

test('记一条情景：事件本身落盘，id 的日期取调用方给的时钟', async () => {
  const home = newHome()
  const one = await eventAdd({ text: '她把盐又放多了', imp: 1, cues: '做饭,盐' }, ctxOf(home))
  assert.match(one.id, /^e-20261113-\d+$/)
  const rows = rowsOf(home)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    id: one.id,
    at: NOW,
    text: '她把盐又放多了',
    imp: 1,
    cues: ['做饭', '盐'],
    // 没给 src 就是"用户说的"：分不清来源的原文等于没记（§4）。
    src: { origin: 'user' },
  })
})

test('事件只追加：同一件事记两次就是两条，后一条不覆盖前一条', async () => {
  const home = newHome()
  const first = await eventAdd({ text: '第一次' }, ctxOf(home))
  const second = await eventAdd({ text: '第二次' }, ctxOf(home, NOW + 60_000))
  const rows = rowsOf(home, NOW)
  const rows2 = rowsOf(home, NOW + 60_000)
  const ids = [...rows, ...rows2].map((rec) => rec.id)
  assert.ok(ids.includes(first.id))
  assert.ok(ids.includes(second.id))
  assert.notEqual(first.id, second.id)
})

test('空内容拒绝：没有原文的事件不叫情景', async () => {
  const home = newHome()
  await assert.rejects(() => eventAdd({ text: '   ' }, ctxOf(home)), /事件得有内容/)
  assert.deepEqual(rowsOf(home), [])
})

test('超单条上限就拒绝，并说清是拆条不是截断', async () => {
  const home = newHome()
  const long = '很'.repeat(EVENTS_MAX + 10)
  await assert.rejects(() => eventAdd({ text: long }, ctxOf(home)), (e) => {
    assert.match(e.message, new RegExp(String(EVENTS_MAX)))
    assert.match(e.message, /拆成几条/)
    assert.ok(cost(long) > EVENTS_MAX)
    return true
  })
  assert.deepEqual(rowsOf(home), [])
})

test('src 写 tool:<名字> 落成 {origin: tool, ref}；写 tool 不带名字要报错', async () => {
  const home = newHome()
  const one = await eventAdd({ text: '外面在下雨', src: 'tool:天气' }, ctxOf(home))
  assert.deepEqual(rowsOf(home)[0].src, { origin: 'tool', ref: '天气' })
  assert.equal(one.record.src.origin, 'tool')
  await assert.rejects(() => eventAdd({ text: '来路不明', src: 'user:她' }, ctxOf(home)), /不带名字/)
  await assert.rejects(() => eventAdd({ text: '没名字', src: 'tool' }, ctxOf(home)), /tool:<名字>/)
})

test('线索去重且保持给的次序：顺序是人的次序，读的人要靠它认出来', async () => {
  const home = newHome()
  await eventAdd({ text: '一句', cues: ['加班', '夜里', '加班'] }, ctxOf(home))
  await eventAdd({ text: '又一句', cues: '加班, 夜里' }, ctxOf(home, NOW + 1))
  const rows = [...rowsOf(home), ...rowsOf(home, NOW + 1)]
  assert.deepEqual(rows[0].cues, ['加班', '夜里'])
  assert.deepEqual(rows[1].cues, ['加班', '夜里'])
})

test('imp 只收 0..3 的整数：别的数字是误输入，不许当成"普通"悄悄写下去', async () => {
  const home = newHome()
  await assert.rejects(() => eventAdd({ text: '一句', imp: 7 }, ctxOf(home)), /imp 只能是/)
  await assert.rejects(() => eventAdd({ text: '一句', imp: 1.5 }, ctxOf(home)), /imp 只能是/)
  assert.deepEqual(rowsOf(home), [])
})

test('写坏半条也不留：形状不合规时一行都不落盘', async () => {
  const home = newHome()
  await assert.rejects(() => eventAdd({ text: '一句', src: 'assistant' }, ctxOf(home)), /src 只能是/)
  assert.deepEqual(rowsOf(home), [])
})

test('写进去的事件能被 events() 按窗口读回来', async () => {
  const home = newHome()
  const one = await eventAdd({ text: '她说周五的体检报告该出来了', imp: 2 }, ctxOf(home))
  const read = events(home, { now: NOW + 1000 })
  assert.equal(read.items.length, 1)
  assert.equal(read.items[0].id, one.id)
  assert.equal(read.items[0].text, '她说周五的体检报告该出来了')
})
