// recall 的用例名一律写约束（AGENTS 六）：看得懂"锁住了什么"，才敢改算式。
// 时间一律传死 now，不碰当前时钟——CI 的腿在别的时区，靠 now 的用例不该跟着跑偏。
import assert from 'node:assert/strict'
import test from 'node:test'

import { S0_EVENT, S0_MEMORY, SCORE_CUE, SCORE_R } from '../src/core/index.mjs'
import {
  allocate,
  cue,
  guarantee,
  kindOf,
  rank,
  retention,
  score,
  sortByScore,
  strength,
} from '../src/recall/index.mjs'

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

test('同样的 R 下，带查询线索的条目排在前面', () => {
  const hit = { id: 'e-1', at: T0, text: '她关了窗', cues: ['窗'] }
  const miss = { id: 'e-2', at: T0, text: '今天吃了面' }
  const rows = rank([miss, hit], { now: T0, query: '窗' })
  assert.equal(rows[0].id, 'e-1', `排在最前的是 ${rows[0].id}：线索没进排序`)
  assert.ok(rows[0].cue > 0 && rows[1].cue === 0, `cue 是 ${rows[0].cue}/${rows[1].cue}`)
  assert.ok(rows[0].score > rows[1].score, '带线索的分数没更高')
  assert.equal(score(hit, '窗', T0), rows[0].score, 'score() 与 rank() 算的不是同一个数')
})

test('线索只写在 cues 里也算命中，不必重复写进正文', () => {
  const rec = { id: 'e-1', at: T0, text: '什么都没说', cues: ['加班'] }
  assert.ok(cue('加班', rec) > 0, 'cues 被漏掉了：design §5 写的是 cues ∪ text')
  assert.equal(cue('加班', { id: 'e-2', at: T0, text: '什么都没说' }), 0)
})

test('空查询不加线索分：分数正好是 0.6·R', () => {
  const rows = rank([
    { id: 'e-1', at: T0, text: '她关了窗' },
    { id: 'e-2', at: T0 + DAY, text: '她关了窗' },
  ], { now: T0 + DAY, query: '' })
  for (const row of rows) {
    assert.equal(row.cue, 0, `${row.id} 在空查询下拿到了线索分 ${row.cue}`)
    assert.equal(row.score, SCORE_R * row.R, `${row.id} 的分数不是 0.6·R`)
  }
  assert.ok(SCORE_CUE > 0, '常数被清零了：0.4 这个权重是 design §10 定的')
})

test('同分时按时间倒序：新的在前', () => {
  const rows = rank([
    { id: 'r-1', at: T0, text: '老规矩' },
    { id: 'r-2', at: T0 + DAY, text: '新规矩' },
  ], { now: T0 + DAY })
  assert.equal(rows[0].score, rows[1].score, '规矩的 R 应当恒为 1，两条分数该一样')
  assert.equal(rows[0].id, 'r-2', `同分时排前面的是 ${rows[0].id}：不是最新的那条`)
})

test('同分同时间按 id 码位序，localeCompare 会把这一对排反', () => {
  const rows = rank([
    { id: 'r-a', at: T0, text: '规矩甲' },
    { id: 'r-Z', at: T0, text: '规矩乙' },
  ], { now: T0 })
  // 码位：'Z'(90) < 'a'(97)；localeCompare 在 en 下把 'a' 排在 'Z' 前。
  assert.equal(rows[0].id, 'r-Z', `码位序没用上：排前面的是 ${rows[0].id}`)
})

test('rank 把结果做成副本，传进来的候选一个都不改', () => {
  const cands = [{ id: 'e-2', at: T0, text: '乙' }, { id: 'e-1', at: T0, text: '甲' }]
  const before = JSON.stringify(cands)
  const rows = rank(cands, { now: T0, query: '甲' })
  assert.notEqual(rows, cands, 'rank 直接把入参数组还回来了')
  assert.equal(JSON.stringify(cands), before, 'rank 改动了传进来的候选')
  assert.notEqual(rows[0], cands[0], '返回的是入参对象本身：下游一改就污染了候选')
})

test('候选不是数组就报错，不静默返回空表', () => {
  assert.throws(() => rank(null, { now: T0 }), /候选数组/)
  assert.throws(() => rank('e-1', { now: T0 }), /候选数组/)
})

test('结论的正文在 fact 上：检索照样能命中', () => {
  const memory = { id: 'm-1', at: T0, key: '她怕冷', fact: '她关窗是因为冷' }
  assert.ok(cue('关窗', memory) > 0, 'fact 没被当正文：结论永远搜不到')
  assert.equal(memory.score, undefined, 'cue() 往传进来的记录上写了东西')
})

test('design §7 的 sortByScore 与 rank 给出同一份次序', () => {
  const cands = [
    { id: 'e-1', at: T0, text: '她关了窗', cues: ['窗'] },
    { id: 'e-2', at: T0 + DAY, text: '她关了窗' },
    { id: 'e-3', at: T0, text: '今天吃了面' },
  ]
  const a = sortByScore(cands, '窗', T0 + DAY)
  const b = rank(cands, { now: T0 + DAY, query: '窗' })
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id))
})

test('两段份额加起来等于总量：除不尽的部分也不许在分配里蒸发', () => {
  for (const total of [1200, 1201, 77.5, 1, 0]) {
    const plan = allocate(total)
    assert.equal(plan.memory + plan.events, total, `${total} 被分成了 ${plan.memory}+${plan.events}`)
  }
  const plan = allocate(1200)
  assert.equal(plan.memory, 720, '0.6 没乘上：design §10 定的是 SHARE_MEMORY 0.6')
  assert.equal(plan.events, 480)
  assert.equal(allocate(NaN).memory + allocate(NaN).events, 0, '总量不是数字时该当 0，不是 NaN')
})

test('结论那段没用完，剩下的额度借给事件那段', () => {
  const plan = allocate(1000, { memory: 100, events: 900 })
  assert.equal(plan.memory, 100, `memory 只要 100 却分走了 ${plan.memory}：份额不该硬塞`)
  assert.equal(plan.events, 900, `events 要 900 只拿到 ${plan.events}：空着的额度没借出去`)
  assert.equal(plan.borrowed, 500, `借了 ${plan.borrowed}，该是 500（600 份额里空着的 500）`)
  assert.equal(plan.spare, 0)
  assert.deepEqual(plan.short, { memory: 0, events: 0 })
})

test('两段都想超时先按 0.6/0.4 分，缺口写进 short 不许悄悄吞掉', () => {
  const plan = allocate(1000, { memory: 900, events: 900 })
  assert.equal(plan.memory, 600, `memory 分到 ${plan.memory}：没有份额就谈不了借还`)
  assert.equal(plan.events, 400)
  assert.deepEqual(plan.short, { memory: 300, events: 500 })
  assert.equal(plan.spare, 0)
  assert.equal(plan.memory + plan.events, 1000, '分出去的总量超了预算，这是预算不可协商的第一道门')
})

test('两段都用不完时，剩下的记在 spare，不当成已经花掉', () => {
  const plan = allocate(1000, { memory: 100, events: 100 })
  assert.equal(plan.memory, 100)
  assert.equal(plan.events, 100)
  assert.equal(plan.borrowed, 0, '谁都没借，borrowed 却是' + plan.borrowed)
  assert.equal(plan.spare, 800, `剩 ${plan.spare} 该记成 800`)
})

test('保底先挑最重的那条，再挑最新的那条', () => {
  // 调用方已按分数排好序：头部就是最重的；at 最大的是最新的。
  const items = [
    { id: 'e-1', at: T0, text: '重的' },
    { id: 'e-2', at: T0 + DAY, text: '中间的' },
    { id: 'e-3', at: T0 + 2 * DAY, text: '最新的' },
  ]
  const order = guarantee({ name: 'events', items })
  assert.deepEqual(order.map((r) => r.id), ['e-1', 'e-3', 'e-2'])
})

test('最重的那条正好也是最新的时候，保底不把同一条挑两遍', () => {
  const items = [
    { id: 'e-1', at: T0 + 2 * DAY, text: '又重又新' },
    { id: 'e-2', at: T0, text: '又轻又旧' },
  ]
  const order = guarantee({ name: 'events', items })
  assert.deepEqual(order.map((r) => r.id), ['e-1', 'e-2'])
  assert.equal(new Set(order).size, order.length, '同一条被挑了两遍：保底等于白占两份预算')
})

test('空段没有保底可挑，也不报错', () => {
  assert.deepEqual(guarantee({ name: 'events', items: [] }), [])
  assert.deepEqual(guarantee({ name: 'events' }), [])
  assert.deepEqual(guarantee(undefined), [])
})
