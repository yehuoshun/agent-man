import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseAt, dayKey, relTime, stamp } from '../src/time.mjs'
import { cost, truncate } from '../src/cost.mjs'
import { select } from '../src/budget.mjs'
import { renderDigest } from '../src/render.mjs'
import { readEvents, appendEvent, resolveHome, writeAtomic } from '../src/store.mjs'
import { main, parseArgs } from '../src/cli.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))

/** 静音 logger，同时把输出收下来断言 */
function recorder() {
  const lines = []
  const errs = []
  return {
    log: (s) => lines.push(String(s)),
    error: (s) => errs.push(String(s)),
    get all() {
      return [...lines, ...errs].join('\n')
    },
    lines,
    errs,
  }
}

// ---------------------------------------------------------------- 时间

test('混时区按绝对时刻排序，不按字面', () => {
  // 参考实现用 localeCompare，这三条会排成 09:00 → 02:00 → 21:00
  const a = '2026-11-05T09:00:00+08:00' // 01:00Z
  const b = '2026-11-05T02:00:00Z' // 10:00 +08
  const c = '2026-11-04T21:00:00-05:00' // 02:00Z
  const sorted = [a, b, c].map((s) => parseAt(s)).sort((x, y) => x - y)
  assert.deepEqual(sorted, [parseAt(a), parseAt(c), parseAt(b)])
})

test('parseAt 空值取 now，解析不了就抛', () => {
  assert.equal(parseAt(undefined, { now: 123 }), 123)
  assert.equal(parseAt('', { now: 5 }), 5)
  assert.equal(parseAt('1794415872'), 1794415872000) // 10 位当秒
  assert.equal(parseAt(1794415872000), 1794415872000)
  assert.throws(() => parseAt('昨天下午'), /看不懂的时间/)
})

test('dayKey 用本地日历日，relTime 半天后先判日历日', () => {
  const at = new Date(2026, 10, 5, 23, 30).getTime() // 本地 11-05 23:30
  assert.equal(dayKey(at), '2026-11-05')

  // 跨了日历日，但只过了 1.5 小时 —— 说"1 小时前"，不该因为过了午夜就变成"昨天"
  const now = new Date(2026, 10, 6, 1, 0).getTime()
  assert.equal(relTime(at, { now }), '1 小时前')

  // 过了半天才切成"昨天 + 钟点"，这比"23 小时前"更好读
  const nextDay = new Date(2026, 10, 6, 23, 0).getTime()
  assert.equal(relTime(at, { now: nextDay }), '昨天 23:30')

  // 同一段距离，钟点在 12 小时内不该换说法
  assert.equal(relTime(at, { now: at + 90 * 60e3 }), '1 小时前')
  assert.equal(relTime(at, { now: at + 5 * 3600e3 }), '5 小时前')

  // 同一天隔了 21.5 小时：说"21 小时前"，不能说"昨天"（那是今天凌晨）
  const today00 = new Date(2026, 10, 12, 0, 30).getTime()
  const today22 = new Date(2026, 10, 12, 22, 0).getTime()
  assert.equal(dayKey(today00), dayKey(today22))
  assert.equal(relTime(today00, { now: today22 }), '21 小时前')

  // 隔了两个日历日、却还没到 36 小时：说"2 天前"，不是"昨天"
  const twoAgo = new Date(2026, 10, 4, 22, 0).getTime()
  const nowMorning = new Date(2026, 10, 6, 7, 0).getTime()
  assert.equal(relTime(twoAgo, { now: nowMorning }), '2 天前')
})

test('stamp 带本地偏移，round-trip 回同一时刻', () => {
  const at = Date.now()
  assert.equal(parseAt(stamp(at)), at - (at % 1000))
})

// ---------------------------------------------------------------- 预算

test('cost 区分 CJK 与 ASCII', () => {
  assert.equal(cost('今天风大'), 4)
  assert.equal(cost('hello'), 2) // 5 * 0.28 = 1.4 → 2
})

test('truncate 优先切在句末', () => {
  const s = '今天风很大，她把窗关上了。然后我们去楼下走了走，回来后煮了面。'
  const t = truncate(s, 14)
  assert.ok(t.cut)
  assert.ok(t.text.endsWith('…'))
  assert.ok(t.cost ?? true)
  assert.ok(cost(t.text) <= 14, `超预算了: ${cost(t.text)} > 14 (${t.text})`)
  // 不该切在"窗关上了"中间
  assert.ok(t.text.startsWith('今天风很大，她把窗关上了。'), t.text)
})

test('truncate 句末太靠前时退到逗号', () => {
  const s = '今天风很大，她把窗关上了，然后我们去楼下走了走，回来后煮了面。'
  const t = truncate(s, 10)
  assert.ok(cost(t.text) <= 10, t.text)
  assert.ok(t.text.endsWith('…'))
})

test('truncate 不超预算，也不会吐出单个省略号以外的空串', () => {
  for (const cap of [2, 3, 5, 8, 13, 21, 34]) {
    const t = truncate('一二三四五六七八九十'.repeat(3), cap)
    assert.ok(cost(t.text) <= cap, `cap=${cap} -> ${t.text} (${cost(t.text)})`)
    assert.ok(t.text.length >= 1)
  }
})

// ---------------------------------------------------------------- 选择

const ev = (at, fact, weight) => ({ at, fact, ...(weight ? { weight } : {}) })

test('总代价永不超预算——包括 weight=3', () => {
  const now = Date.parse('2026-11-05T12:00:00+08:00')
  const events = Array.from({ length: 30 }, (_, i) =>
    ev(now - i * 3600e3, `第 ${i} 条记录，长度大概是这样`, i % 4 === 0 ? 3 : 1),
  )
  for (const budget of [40, 100, 240, 600]) {
    const s = select(events, { budget })
    assert.ok(s.used <= budget, `budget=${budget} used=${s.used}`)
    assert.ok(s.pinned.length + s.recent.length > 0)
  }
})

test('一条放不下不终止后面的候选（break → continue）', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const events = [
    ev(t0 + 3000, '新的一条很短', 2), // 先占住
    ev(t0 + 2000, '这是一条特别特别长的记录'.repeat(6), 2), // 放不下
    ev(t0 + 1000, '旧的疤', 3), // 不该被那条长的连坐
  ]
  // pinnedCap = floor(60 * 0.7) = 42；短条 ~7，长条 ~120，疤 3
  const s = select(events, { budget: 60 })
  const facts = s.pinned.map((e) => e.fact)
  assert.ok(facts.includes('旧的疤'), `weight=3 被连坐了: ${JSON.stringify(facts)}`)
  assert.ok(s.used <= 60)
})

test('w3 超预算时切开并记账，不静默消失', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const long = '疤。'.repeat(40) // 80 代价
  const s = select([ev(t0, long, 3)], { budget: 50 })
  assert.equal(s.pinned.length, 1)
  assert.equal(s.pinned[0].cut, true)
  assert.ok(s.used <= 50)
  assert.equal(s.drops.filter((d) => d.why === 'truncated').length, 1)
})

test('真放不下时 drops 里有它，理由是 no-room', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const events = [ev(t0, '短', 2), ev(t0 + 1, '这是一条中等长度的记录'.repeat(4), 3)]
  const s = select(events, { budget: 20 })
  const dropped = s.drops.filter((d) => d.why === 'no-room')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].weight, 3)
})

test('pinned 按权重优先，w3 不被新的 w2 挤掉', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const s = select([ev(t0 + 10_000, '新的 w2', 2), ev(t0, '旧的 w3', 3)], { budget: 100 })
  assert.deepEqual(
    s.pinned.map((e) => e.fact),
    ['旧的 w3', '新的 w2'],
  )
})

test('recent 没用掉的额度还给 pinned（回归：只有一条 w3 时不被 70% 份额判死）', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  // 只有一条长 w3，没有任何 recent。pinnedCap = floor(40*0.7) = 28，
  // 它的 charge 远超 28 —— 但整份预算 40 全空着，它该拿到这部分。
  const long = '这一条很长的疤'.repeat(5) // 35 代价
  const s = select([ev(t0, long, 3)], { budget: 90 })
  assert.equal(s.pinned.length, 1, '唯一一条被份额判死了')
  assert.equal(s.pinned[0].cut, undefined)
  assert.ok(s.used <= 90)
})

test('pinned 拿满份额后，剩下的给 recent，反过来不行', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const bigPinned = ev(t0, '疤'.repeat(50), 3) // 50 代价
  const small = ev(t0 + 1000, '小事', 1)
  const s = select([bigPinned, small], { budget: 120 })
  // pinnedCap = 84，w3 占 62，剩 58 给 recent
  assert.equal(s.pinned.length, 1)
  assert.equal(s.recent.length, 1)
  assert.ok(s.used <= 120)
})

test('输出按时间升序（人往前读）', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const s = select([ev(t0 + 5000, 'c', 1), ev(t0, 'a', 1), ev(t0 + 3000, 'b', 1)], { budget: 100 })
  assert.deepEqual(
    s.recent.map((e) => e.fact),
    ['a', 'b', 'c'],
  )
})

// ---------------------------------------------------------------- 渲染

test('renderDigest 不超预算，且超长单行不会撑爆', () => {
  const t0 = Date.parse('2026-11-05T10:00:00Z')
  const events = [ev(t0 + 2, '短一', 1), ev(t0 + 1, '短二', 1), ev(t0, '很长的单行'.repeat(200), 3)]
  const { text, stats } = renderDigest(events, { budget: 120, now: t0 + 3600e3 })
  assert.ok(stats.used <= 120, `used=${stats.used}`)
  assert.ok(text.includes('我记得的事'))
  // 参考实现在这里会输出 1400 字的 self 块
  assert.ok(text.length < 700, `渲染结果太长了: ${text.length}`)
})

test('renderDigest 空库给出可读提示而不是空文件', () => {
  const { text } = renderDigest([], { now: Date.now() })
  assert.ok(text.includes('还没有任何记录'))
})

test('相对时间在渲染时才定，写死的旧文本会露馅', () => {
  const at = Date.parse('2026-11-05T10:00:00Z')
  const a = renderDigest([ev(at, '一件事', 1)], { now: at + 3600e3 }).text
  const b = renderDigest([ev(at, '一件事', 1)], { now: at + 3 * 3600e3 }).text
  assert.notEqual(a, b)
})

// ---------------------------------------------------------------- 存储

test('坏行跳过并计数，好行一条不丢；行首 BOM 能救回来', () => {
  const home = tmp()
  const p = path.join(home, 'events.jsonl')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    p,
    [
      JSON.stringify({ at: 3, fact: 'c' }),
      'not json at all',
      JSON.stringify({ at: 1, fact: 'a' }),
      '',
      '\uFEFF' + JSON.stringify({ at: 2, fact: 'b' }), // BOM 那次的教训：trim 能救
      JSON.stringify({ at: '不是数字', fact: 'bad' }),
    ].join('\n'),
    'utf8',
  )
  const { events, bad } = readEvents(home)
  assert.equal(bad, 2) // 只有 "not json" 和 at 不是数字这两行真读不出来
  assert.deepEqual(
    events.map((e) => e.fact),
    ['a', 'b', 'c'],
  )
})

test('整份文件带 BOM 也能读第一条', () => {
  const home = tmp()
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'events.jsonl'),
    '\uFEFF' + JSON.stringify({ at: 1, fact: '首条' }) + '\n',
    'utf8',
  )
  const { events, bad } = readEvents(home)
  assert.equal(bad, 0)
  assert.equal(events[0].fact, '首条')
})

test('append 后读回顺序稳定，且文件里没有 BOM', () => {
  const home = tmp()
  appendEvent(home, { at: 2, fact: 'later' })
  appendEvent(home, { at: 1, fact: 'earlier' })
  const raw = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8')
  assert.notEqual(raw.charCodeAt(0), 0xfeff)
  assert.deepEqual(
    readEvents(home).events.map((e) => e.fact),
    ['earlier', 'later'],
  )
})

test('since/until 按数值过滤', () => {
  const home = tmp()
  for (const at of [1, 2, 3, 4]) appendEvent(home, { at, fact: `t${at}` })
  assert.deepEqual(
    readEvents(home, { since: 2, until: 3 }).events.map((e) => e.fact),
    ['t2', 't3'],
  )
})

test('AGENT_MAN_HOME 覆盖默认目录', () => {
  assert.equal(resolveHome({ AGENT_MAN_HOME: '/x/y' }, '/home/u'), path.resolve('/x/y'))
  assert.equal(resolveHome({}, '/home/u'), path.resolve('/home/u/.agent-man'))
})

test('writeAtomic 不留 .tmp', () => {
  const home = tmp()
  const f = path.join(home, 'sub', 'a.md')
  writeAtomic(f, 'hello')
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello')
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['a.md'])
})

// ---------------------------------------------------------------- CLI

test('parseArgs 支持 --k v / --k=v / 位置参数 / -- 终止', () => {
  assert.deepEqual(parseArgs(['log', '一句话', '--weight', '2', '--kind=dm']), {
    cmd: 'log',
    pos: ['一句话'],
    flags: { weight: '2', kind: 'dm' },
  })
  assert.deepEqual(parseArgs(['log', '--', '--不是flag']), {
    cmd: 'log',
    pos: ['--不是flag'],
    flags: {},
  })
  assert.deepEqual(parseArgs(['digest', '--out']), { cmd: 'digest', pos: [], flags: { out: true } })
})

test('CLI log → digest 端到端', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-05T12:00:00+08:00')

  assert.equal(main(['log', '今天风大，她把窗关上了', '--weight', '2', '--feel', '安心'], { env, out: recorder(), now }), 0)
  assert.equal(main(['log', '煮了面', '--at', '2026-11-05 11:00'], { env, out: recorder(), now }), 0)

  const out = recorder()
  assert.equal(main(['digest'], { env, out, now }), 0)
  const text = out.lines.join('\n')
  assert.ok(text.includes('今天风大，她把窗关上了（安心）'), text)
  assert.ok(text.includes('煮了面'), text)
  assert.ok(text.indexOf('不会忘的') < text.indexOf('最近'))
})

test('CLI digest --out 写字，stdout 只报统计', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  main(['log', '记一条'], { env, out: recorder() })
  const target = path.join(home, 'digest.md')
  const out = recorder()
  assert.equal(main(['digest', '--out', target, '--budget', '200'], { env, out }), 0)
  assert.ok(fs.readFileSync(target, 'utf8').includes('记一条'))
  assert.ok(out.lines.join('\n').includes('写好了'))
})

test('CLI 对坏输入返回非零码而不是抛栈', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  assert.equal(main(['log'], { env, out: recorder() }), 1)
  assert.equal(main(['log', 'x', '--weight', '9'], { env, out: recorder() }), 1)
  assert.equal(main(['digest', '--budget', '-1'], { env, out: recorder() }), 1)
  assert.equal(main(['nope'], { env, out: recorder() }), 2)
})

test('重复记录会提醒，但不拦', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-05T12:00:00+08:00')
  const first = recorder()
  main(['log', '今天风大'], { env, out: first, now })
  assert.equal(first.errs.length, 0)

  const second = recorder()
  assert.equal(main(['log', '今天风大'], { env, out: second, now: now + 3600e3 }), 0)
  assert.ok(second.errs.join('\n').includes('一模一样'))
  assert.equal(readEvents(home).events.length, 2) // 还是记了
})

test('w3 被丢时给出刺眼提示', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-05T12:00:00+08:00')
  main(['log', '短', '--weight', '2'], { env, out: recorder(), now })
  main(['log', '这是一条很长很长的疤'.repeat(10), '--weight', '3'], { env, out: recorder(), now: now + 1000 })

  const out = recorder()
  main(['digest', '--budget', '30'], { env, out, now })
  assert.ok(out.errs.join('\n').includes('weight=3'), out.errs.join('\n'))
})
