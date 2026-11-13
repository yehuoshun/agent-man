// recall 的用例名一律写约束（AGENTS 六）：看得懂"锁住了什么"，才敢改算式。
// 时间一律传死 now，不碰当前时钟——CI 的腿在别的时区，靠 now 的用例不该跟着跑偏。
import assert from 'node:assert/strict'
import test from 'node:test'

import { S0_EVENT, S0_MEMORY } from '../src/core/index.mjs'
import { kindOf, retention, strength } from '../src/recall/index.mjs'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1763043120000

test('保留率隔一个 S0 正好落到 1/e，再旧只会更小', () => {
  const rec = { id: 'e-1', at: T0, text: '她关了窗', imp: 0, seen: 0 }
  const exact = strength(rec, T0 + S0_EVENT)
  assert.equal(exact.S, S0_EVENT, 'imp 与 seen 都是 0 时 S 就该等于 S0')
  assert.ok(Math.abs(exact.R - Math.exp(-1)) < 1e-12, `R 是 ${exact.R}，不是 1/e`)
  const older = strength(rec, T0 + 2 * S0_EVENT)
  assert.ok(older.R < exact.R, '两倍 S0 之后还比一倍 S0 时新：R 没有随时间下降')
  assert.ok(strength(rec, T0).R === 1, '刚写下的记录不是满保留')
})

test('seen 让 S 变大：被复述过的条目在同一时刻留得更多', () => {
  const fresh = { id: 'e-1', at: T0, text: '她关了窗', imp: 0, seen: 0 }
  const told = { id: 'e-1', at: T0, text: '她关了窗', imp: 0, seen: 3 }
  const now = T0 + 2 * S0_EVENT
  const a = strength(fresh, now)
  const b = strength(told, now)
  assert.ok(Math.abs(b.S - S0_EVENT * (1 + Math.log(4))) < 1e-9, `seen=3 时 S 是 ${b.S}`)
  assert.ok(b.R > a.R, '复述过三次的条目反而衰减更快：seen 没进 S')
})

test('imp 按 (1+2·imp) 放大 S：imp=2 时 S 是 S0 的五倍', () => {
  const rec = { id: 'e-1', at: T0, text: '她关了窗', imp: 2, seen: 0 }
  assert.equal(strength(rec, T0).S, S0_EVENT * 5)
  const light = strength({ ...rec, imp: 0 }, T0 + S0_EVENT)
  const heavy = strength(rec, T0 + S0_EVENT)
  assert.ok(heavy.R > light.R, '更重要的条目没有留得更多')
})

test('规矩不衰减：一百年后规矩的 R 仍是 1', () => {
  const rule = { id: 'r-1', at: T0, text: '夜里十一点后不提工作', seen: 0 }
  assert.equal(kindOf(rule), 'rule', 'r- 前缀没认出规矩')
  assert.equal(retention(rule, T0 + 100 * 365 * DAY), 1)
})

test('结论比情景抗衰减：同一时刻六天前的结论比六天前的事件留得多', () => {
  const now = T0 + 6 * DAY
  const event = strength({ id: 'e-1', at: T0, text: '她关了窗' }, now)
  const memory = strength({ id: 'm-1', at: T0, fact: '她关窗是因为冷' }, now)
  assert.equal(event.S, S0_EVENT)
  assert.equal(memory.S, S0_MEMORY)
  assert.ok(Math.abs(memory.R - Math.exp(-6 * DAY / S0_MEMORY)) < 1e-12)
  assert.ok(memory.R > event.R, '结论没有比情景更抗衰减：S0 按层取错了')
})

test('没给 now 就报错，不偷偷读当前时间', () => {
  assert.throws(() => strength({ id: 'e-1', at: T0 }, undefined), /now/)
  assert.throws(() => retention({ id: 'e-1', at: T0 }, Number.NaN), /now/)
})

test('未来的 at 不能超过 1：R 夹在 [0,1]', () => {
  const ahead = strength({ id: 'e-1', at: T0 + DAY, text: '还没发生' }, T0)
  assert.equal(ahead.R, 1, `未来记录算出 R=${ahead.R}：没有夹到 1`)
})

test('没有 at 的记录按最旧处理：R 是 0 而不是 1', () => {
  const lost = strength({ id: 'e-1', text: '不知道什么时候' }, T0)
  assert.equal(lost.R, 0, '缺 at 时被当成了满保留')
})

test('认不出层就按情景算：S0 取最小的那个，衰减最快', () => {
  assert.equal(kindOf({ id: 'x-1', text: '来历不明' }), 'event')
  assert.equal(strength({ id: 'x-1', text: '来历不明', at: T0 }, T0).S, S0_EVENT)
})

test('正文在 fact 上的结论也算有正文，不会被当成空条目', () => {
  const memory = { id: 'm-1', at: T0, fact: '她关窗是因为冷' }
  assert.equal(kindOf(memory), 'memory')
  assert.equal(strength(memory, T0).S, S0_MEMORY)
})
