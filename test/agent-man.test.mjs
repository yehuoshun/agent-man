import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAt, dayKey, dayStartFromEnv, relTime, stamp, weekKey } from '../src/time.mjs'
import { cost, truncate } from '../src/cost.mjs'
import { select } from '../src/budget.mjs'
import { renderDigest } from '../src/render.mjs'
import { buildTrace, neverShown, traceLine } from '../src/trace.mjs'
import {
  readEvents,
  appendEvent,
  readMemory,
  resolveHome,
  writeAtomic,
  assertLanded,
  renameWithRetry,
  claimId,
  appendTrace,
  readConsolidation,
  readTraces,
  readJudges,
  appendJudge,
} from '../src/store.mjs'
import { makeItem, activeItems, selectMemory } from '../src/memory.mjs'
import { owed, owedCount, backlog, BACKLOG_COST } from '../src/consolidate.mjs'
import { main, parseArgs, FLAGS } from '../src/cli.mjs'
import { inQuiet } from '../src/when.mjs'
import { cacheState } from '../src/sky.mjs'

// 时区不进用例：要"本地某天某点"就用本地时间构造。
// 写死 +08:00 的 epoch 只在东八区等于那一天，UTC/纽约机器上 dayKey 会落到前一天。
function localAt(y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime()
}

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

test('整段文本（含标题与注释行）也不超预算', () => {
  const now = Date.parse('2026-11-05T12:00:00+08:00')
  const events = Array.from({ length: 20 }, (_, i) =>
    ev(now - i * 3600e3, `第 ${i} 条记录，长度大概是这样`, i % 4 === 0 ? 3 : 1),
  )
  // 以前只算条目：预算 120 实测输出 137，预算 30 实测 53。
  for (const budget of [60, 120, 240, 600, 1200]) {
    const { text, stats } = renderDigest(events, { budget, now })
    assert.ok(cost(text) <= budget, `budget=${budget} 实际=${cost(text)}`)
    assert.equal(stats.used, cost(text), '实占要报整段文本的代价')
    assert.equal(stats.over, 0)
  }
})

test('预算连头部都放不下时降级到只剩标题，不假装装下了', () => {
  const events = [ev(1000, '很长的记录'.repeat(20), 3)]
  const { text, stats } = renderDigest(events, { budget: 30, now: 5000 })
  assert.ok(cost(text) <= 30, `实际=${cost(text)}：${text}`)
  assert.equal(stats.kept, 0)
  assert.ok(stats.drops.length >= 1)
})

test('头部装得下、内容装不下时也要降级：80 的预算不许买一份空摘要', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  // 实测老规则：FULL 骨架 69，剩 11 分给两条（要 26 和 12），取 0 丢 2，
  // 而 69 ≤ 80 所以"没超预算"就算成功，交出去一份只有标题和「（还没有）」的空壳。
  const events = [
    { at: now - 8 * 60e3, fact: '今天风大', weight: 0 },
    { at: now - 50 * 60e3, fact: '她把窗关上了，说外面风大', feel: '被照顾到', weight: 2 },
  ]
  const { text, stats } = renderDigest(events, { budget: 80, now })
  assert.equal(stats.kept, 2, `没装下两条：\n${text}`)
  assert.ok(cost(text) <= 80, `超了：${cost(text)}`)
  assert.match(text, /她把窗关上了/)
  // 换成 compact 头部，而不是留着最贵的那种
  assert.match(text, /<!-- 2\/0 · 取 2\+0 · 丢 0 · 截 0 -->/)
})

test('宁可掉一行注释，也要多装一条：头部不是越详细越好', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  // 老规则在 85 这里：FULL 只装得下 w0（12），装不下 w2（26），照样收手；
  // 换成 compact 两条都装得下。同样没超预算，凭什么要少的那个？
  const events = [
    { at: now - 8 * 60e3, fact: '今天风大', weight: 0 },
    { at: now - 50 * 60e3, fact: '她把窗关上了，说外面风大', feel: '被照顾到', weight: 2 },
  ]
  const { text, stats } = renderDigest(events, { budget: 85, now })
  assert.equal(stats.kept, 2, `少装了一条：\n${text}`)
  assert.ok(cost(text) <= 85)
})

test('一条都装不下时不留空壳：宁肯只剩标题，也不花 69 买两行「（还没有）」', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  // 预算 100 时 select 还能把这条切开塞进去，所以压到 60：四种头部都装不下一条，
  // 那就只剩标题，别留一份「（还没有）」的空壳。
  const events = [{ at: now - 60e3, fact: '很长'.repeat(80), weight: 0 }]
  const { text, stats } = renderDigest(events, { budget: 60, now })
  assert.equal(stats.kept, 0)
  assert.equal(text.trim(), '# 我记得的事')
  assert.ok(stats.drops.length >= 1, '丢了要报出来')
})

test('保底一条：预算 60 时宁可"最近"空着，也要留下那条 w2', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  // 日记层分到 27，份额只有 18，装不下代价 26 的 w2；recent 拿的是全额，
  // 于是"不会忘的"整块空掉，只剩一条无关紧要的"今天风大"。
  const events = [
    { at: now - 50 * 60e3, fact: '她把窗关上了，说外面风大', feel: '被照顾到', weight: 2 },
    { at: now - 8 * 60e3, fact: '今天风大', weight: 0 },
  ]
  const { text, stats } = renderDigest(events, { budget: 60, now })
  assert.match(text, /她把窗关上了/)
  assert.equal(stats.kept, 1)
  assert.equal(stats.floorKeep, true)
  // 空着的那段得说"放不下"，不能说"还没有"——那条近况是真实存在的
  assert.match(text, /## 最近\n- （放不下，丢了 1 条）/)
  assert.ok(cost(text) <= 60)
})

test('保底也保不了装不下的东西：预算 16 时 w2 如实记 no-room', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const events = [{ at: now - 50 * 60e3, fact: '她把窗关上了，说外面风大', weight: 2 }]
  const r = select(events, { budget: 16 })
  assert.equal(r.pinned.length, 0)
  assert.equal(r.floorKeep, false)
  assert.equal(r.drops[0].why, 'no-room')
})

test('保底只保一条：两条 w2 抢预算时同权重取近的，丢的那条要报出来', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const older = { at: now - 90 * 60e3, fact: '她把窗关上了，说外面风大', weight: 2 }
  const newer = { at: now - 30 * 60e3, fact: '医生说要吃满一疗程', weight: 2 }
  const r = select([older, newer], { budget: 30 })
  assert.equal(r.pinned.length, 1)
  assert.equal(r.pinned[0].at, newer.at)
  assert.equal(r.drops.length, 1)
  assert.equal(r.drops[0].at, older.at)
  assert.equal(r.drops[0].why, 'no-room')
})

test('对称保底：预算紧到只够一边时，仍给"最近"留一个位子', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const mk = (min, fact, weight) => ({ at: now - min * 60e3, fact, weight })
  // 六条 w2 之外还有一条长近况。份额（70%）装得下三条旧的，但"最近"那一层
  // 只剩 30%——装不下代价 60 的那条近况。旧规则下它整块掉出去，只剩三句旧疤。
  const events = [
    mk(600, '她把窗关上了，说外面风大', 2),
    mk(540, '医生说要吃满一疗程，别自己停', 2),
    mk(480, '她妈下周三来，得把屋子收拾出来', 2),
    mk(8, '今天风大，她出门没带围巾，回来以后一句话没说，坐了很久才说有点累', 0),
  ]
  const { text, stats } = renderDigest(events, { budget: 100, now })
  assert.match(text, /今天风大/, '"最近"是这个零件存在的理由，不许整块消失')
  assert.equal(stats.kept, 2, '少装一条旧的，换一条近的')
  assert.equal(stats.floorKeep, true)
  assert.equal(stats.recentFloorKeep, true)
  assert.ok(cost(text) <= 100)
})

test('两条保底撞车：先保重的那条，近的如实记 no-room，不假装保住了', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const events = [
    { at: now - 50 * 60e3, fact: '她把窗关上了，说外面风大', weight: 2 },
    { at: now - 8 * 60e3, fact: '今天风大', weight: 0 },
  ]
  // 两条代价 26 + 12 装不进 30：重的那条留下，近的那条记 no-room（顺序是硬的，不掷骰子）
  const r = select(events, { budget: 30 })
  assert.equal(r.pinned.length, 1)
  assert.equal(r.pinned[0].weight, 2)
  assert.equal(r.recent.length, 0)
  assert.equal(r.recentFloorKeep, false)
  assert.equal(r.drops.find((d) => d.weight === 0).why, 'no-room')
})

test('重复：逐字相同的两条只留一条，头部分明写「合 1」（§28）', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const same = '她把窗关上了'
  const events = [
    { at: now - 90 * 60e3, fact: same, weight: 2 },
    { at: now - 60 * 60e3, fact: same, weight: 2 },
    { at: now - 30 * 60e3, fact: '她说外面风大，就把窗关了', weight: 2 },
  ]
  const { text, stats } = renderDigest(events, { budget: 200, now })
  assert.equal(stats.kept, 2)
  assert.equal(stats.merged, 1)
  assert.equal(text.split(same).length - 1, 1, '同一句话只该占一行')
  assert.match(text, /合 1/)
  const dup = stats.drops.filter((d) => d.why === 'dup')
  assert.equal(dup.length, 1)
  assert.equal(dup[0].at, now - 90 * 60e3, '合掉的是旧的那条，留最新的')
})

test('重复：同一句话权重不同不算复读——w2 和 w0 说的是两件事', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const events = [
    { at: now - 60 * 60e3, fact: '今天风大', weight: 2 },
    { at: now - 8 * 60e3, fact: '今天风大', weight: 0 },
  ]
  const { stats } = renderDigest(events, { budget: 200, now })
  assert.equal(stats.merged, 0, '权重变了是信号，不是复读')
  assert.equal(stats.kept, 2)
})

test('重复：合掉以后省下的额度装得下一条真事', () => {
  const now = Date.parse('2026-11-12T09:50:00+08:00')
  const events = [
    { at: now - 3 * 60e3, fact: '窗关上了', weight: 2 },
    { at: now - 2 * 60e3, fact: '窗关上了', weight: 2 },
    { at: now - 60e3, fact: '药要吃完', weight: 2 },
    { at: now, fact: '周末回家', weight: 2 },
  ]
  // 三条真事各 14 代价，60 的份额装得下；不合并的话第四条(复读)会挤掉一条真事
  const r = select(events, { budget: 60 })
  assert.equal(r.merged, 1)
  assert.deepEqual(
    r.pinned.map((e) => e.fact),
    ['窗关上了', '药要吃完', '周末回家'],
  )
})

test('账本：合掉的重复不算「截」，单独记「合」', () => {
  const stats = {
    budget: 200,
    used: 34,
    keptAt: [1794458529041, 1794458529102],
    merged: 1,
    drops: [{ at: 1794458528987, why: 'dup', weight: 2 }],
  }
  const line = traceLine(buildTrace(stats, { now: 1794458529164 }))
  assert.match(line, /丢 0 · 截 0 · 合 1/)
})

test('账本：被合掉的重复不算"从没露过面"——那是假警报', () => {
  const events = [
    { at: 100, fact: '窗关上了', weight: 2 },
    { at: 200, fact: '窗关上了', weight: 2 },
    { at: 300, fact: '药要吃完', weight: 2 },
  ]
  const traces = [{ keptAt: [200], drops: [{ at: 100, why: 'dup', weight: 2 }] }]
  assert.deepEqual(
    neverShown(events, traces).map((e) => e.at),
    [300],
    '孪生兄弟露过面，就算露过了',
  )
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

test('半行会当场被抓住：写进去的那行读不回来就报错，不等下次读', () => {
  const home = tmp()
  appendEvent(home, { at: 1, fact: '整条' })
  const file = path.join(home, 'events.jsonl')
  fs.appendFileSync(file, '{"at":2,"fact":"断在', 'utf8')
  assert.throws(() => assertLanded(file, '{"at":2,"fact":"断在"}\n'), /没落全/)
  // 半行确实会在下次读时被算成坏行：报出来，但前面的记录不受牵连
  const { events, bad } = readEvents(home)
  assert.equal(bad, 1)
  assert.equal(events.length, 1)
})

test('别人在你写完之后插了一行：核对不该慌——旧写法在这里 50% 假警报', () => {
  const home = tmp()
  const file = path.join(home, 'events.jsonl')
  appendEvent(home, { at: 1, fact: '我的话' })
  const mine = `${JSON.stringify({ at: 1, fact: '我的话' })}\n`

  // 另一个进程恰好在"我写完"和"我读回"之间追加了一条：旧写法读到的是它，
  // 于是对着一条完好的记录喊"没落全"。实测 30 个并发 log 里 15 个这么中招。
  appendEvent(home, { at: 2, fact: '别人的话' })

  assert.doesNotThrow(() => assertLanded(file, mine))
  // 真丢了还是要抓住：文件里根本没有这一行
  assert.throws(() => assertLanded(file, `${JSON.stringify({ at: 9, fact: '没写过' })}\n`), /没落全/)
  assert.equal(readEvents(home).events.length, 2)
})

test('覆盖写先把内容落盘再改名：写完立刻读得到完整内容，也不留 .tmp', () => {
  const home = tmp()
  const f = path.join(home, 'state', 'consolidation.json')
  writeAtomic(f, '{"at":1}\n')
  writeAtomic(f, '{"at":2}\n')
  assert.equal(fs.readFileSync(f, 'utf8'), '{"at":2}\n')
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['consolidation.json'])
})

test('账本也落盘核对：写进去的那行立刻读得回来', () => {
  const home = tmp()
  appendTrace(home, { at: 5, budget: 60, keptAt: [] })
  const { traces, bad } = readTraces(home)
  assert.equal(bad, 0)
  assert.equal(traces[0].at, 5)
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
  // 开关不吃后面的词；等号只认 true / false
  assert.deepEqual(parseArgs(['digest', '--due']), { cmd: 'digest', pos: [], flags: { due: true } })
  assert.deepEqual(parseArgs(['digest', '--due=false']), {
    cmd: 'digest',
    pos: [],
    flags: { due: false },
  })
  // 值选项缺值不再静默变成 `true`（旧行为：`digest --out` 得到 flags.out = true）
  assert.throws(() => parseArgs(['digest', '--out']), /选项 --out 需要值/)
})

test('选项名写错就报错：--waight 不是 --weight，不许静默降级成 w0', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const out = recorder()
  assert.equal(main(['log', '这是一条疤', '--waight', '3'], { env, out }), 2)
  assert.ok(out.errs.join('\n').includes('未知选项 --waight'), out.all)
  assert.ok(out.errs.join('\n').includes('是不是想写 --weight'), out.all)
  assert.equal(readEvents(home).events.length, 0) // 没落盘，而不是悄悄记成 w0
})

test('--kind 给空串不算"默认 note"：报错，不记一条"没来源"的日记', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const out = recorder()
  assert.equal(main(['log', '一条日记', '--kind', '  '], { env, out }), 1)
  assert.ok(out.errs.join('\n').includes('--kind 不能是空的'), out.all)
  assert.equal(readEvents(home).events.length, 0) // 不是悄悄落盘成 kind: ""
})

test('--supersede 少一个 s 会被拦住，不留两条并存的同主题记忆', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T09:00:00+08:00')
  const first = main(['remember', '版本一', '--topic', '她怕冷', '--refs', '2026-11-01'], {
    env,
    out: recorder(),
    now,
  })
  assert.equal(first, 0)

  const out = recorder()
  const bad = main(
    [
      'remember',
      '版本二',
      '--topic',
      '她怕冷',
      '--refs',
      '2026-11-05',
      '--supersede',
      '2026-11-12-01',
    ],
    { env, out, now },
  )
  assert.equal(bad, 2)
  assert.ok(out.errs.join('\n').includes('--supersedes'), out.all) // 提示语把正确写法列出来了
  assert.equal(activeItems(readMemory(home).items).length, 1)
})

test('开关只认裸用或 true/false：--due=false 不报欠账', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T09:00:00+08:00')
  main(['log', '一条日记', '--at', '2026-11-01 10:00'], { env, out: recorder(), now })

  const off = recorder()
  assert.equal(main(['digest', '--due=false'], { env, out: off, now }), 0)
  assert.ok(off.all.includes('我记得的事'), off.all) // 渲染了摘要
  assert.ok(!off.all.includes('欠'), off.all) // 而不是摊账

  const bad = recorder()
  assert.equal(main(['digest', '--due=也许'], { env, out: bad, now }), 2)
  assert.ok(bad.errs.join('\n').includes('只接受 true / false'), bad.all)
})

test('值选项没给值就报错，不从下一个词里抓', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['digest', '--budget'], { env, out }), 2)
  assert.ok(out.errs.join('\n').includes('--budget 需要值'), out.all)

  // 值以 -- 开头的必须写成 --title="-- 开头"；以前会静默变成 title=true
  assert.equal(main(['digest', '--title', '-- 开头'], { env, out: recorder() }), 2)
  assert.equal(main(['digest', '--title=-- 开头'], { env, out: recorder() }), 0)
})

test('不吃位置参数的命令多了词就报错', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['ls', '多出来的'], { env, out }), 2)
  assert.ok(out.errs.join('\n').includes('位置参数'), out.all)
  assert.equal(main(['digest', '顺便'], { env, out: recorder() }), 2)
})

test('HELP 里写的选项和 FLAGS 表对得上（加参数不会只改一半）', () => {
  const help = recorder()
  main(['--help'], { out: help })
  const text = help.all
  for (const [cmd, spec] of Object.entries(FLAGS)) {
    for (const f of [...spec.value, ...spec.bool]) {
      assert.ok(text.includes(`--${f}`), `${cmd} 的 --${f} 没写进 HELP`)
    }
  }
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

// ---------------------------------------------------------------- 长期层

test('日界按 dayStart 平移：dayStart=4 时 00:30 算前一天', () => {
  // 日界是本地日历日的概念，所以这里必须造"本地 00:30"而不是写死 +08:00：
  // 写死偏移的测试在 CI（UTC）上会红，而抓的其实是测试自己——见 §27。
  const at = new Date(2026, 10, 12, 0, 30).getTime()
  assert.equal(dayKey(at), '2026-11-12')
  assert.equal(dayKey(at, { dayStart: 4 }), '2026-11-11')
  assert.equal(dayKey(new Date(2026, 10, 12, 4, 30).getTime(), { dayStart: 4 }), '2026-11-12')
})

test('AGENT_MAN_DAY_START 坏了就报错，不猜', () => {
  assert.equal(dayStartFromEnv({}), 0)
  assert.equal(dayStartFromEnv({ AGENT_MAN_DAY_START: '4' }), 4)
  assert.throws(() => dayStartFromEnv({ AGENT_MAN_DAY_START: '25' }), /0\.\.23/)
  assert.throws(() => dayStartFromEnv({ AGENT_MAN_DAY_START: '四' }), /0\.\.23/)
})

test('长期条目的校验：主题、出处、覆盖范围，缺一个都进不了文件', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const base = { topic: '她怕冷', fact: '入秋后先关窗再抱怨风', refs: '2026-11-05' }
  assert.throws(() => makeItem({ ...base, topic: '' }, { now }), /--topic/)
  assert.throws(() => makeItem({ ...base, fact: '  ' }, { now }), /事实/)
  assert.throws(() => makeItem({ ...base, tier: 9 }, { now }), /--tier/)
  assert.throws(() => makeItem({ ...base, refs: '' }, { now }), /--refs/)
  assert.throws(() => makeItem({ ...base, from: '2026-11-09', to: '2026-11-05' }, { now }), /span-to 早于/)
  // 确实没有出处时，可以明说
  assert.doesNotThrow(() => makeItem({ ...base, refs: undefined, noRefs: true }, { now }))
})

test('长期条目按日期发号，同一天递增', () => {
  const now = localAt(2026, 11, 12, 12)
  const a = makeItem({ topic: 'a', fact: '一', refs: '2026-11-01' }, { now })
  const b = makeItem({ topic: 'b', fact: '二', refs: '2026-11-01' }, { now, existing: [a] })
  assert.equal(a.id, '2026-11-12-01')
  assert.equal(b.id, '2026-11-12-02')
})

test('remember 落盘成一行 JSON，recall 能读回来', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  assert.equal(
    main(['remember', '入秋后先关窗再抱怨风', '--topic', '她怕冷', '--refs', '2026-11-05'], { env, out: recorder() }),
    0,
  )
  const { items, bad } = readMemory(home)
  assert.equal(bad, 0)
  assert.equal(items.length, 1)
  assert.equal(items[0].topic, '她怕冷')
  assert.deepEqual(items[0].refs, ['2026-11-05'])
  assert.equal(items[0].tier, 0)

  const out = recorder()
  assert.equal(main(['recall'], { env, out }), 0)
  assert.ok(out.all.includes('她怕冷'), out.all)
})

test('没带 --refs 的 remember 退出码 1 且不落盘', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  assert.equal(main(['remember', '一条没有出处的结论', '--topic', '她怕冷'], { env, out: recorder() }), 1)
  assert.equal(readMemory(home).items.length, 0)
})

test('supersedes 让旧条目退场，但旧行仍在文件里', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = localAt(2026, 11, 12, 12)
  main(['remember', '版本一', '--topic', '她怕冷', '--refs', '2026-11-01'], { env, out: recorder(), now })
  main(
    ['remember', '版本二', '--topic', '她怕冷', '--refs', '2026-11-09', '--supersedes', '2026-11-12-01'],
    { env, out: recorder(), now },
  )
  const { items } = readMemory(home)
  assert.equal(items.length, 2, '旧行不该被改写或删除')
  assert.deepEqual(
    activeItems(items).map((it) => it.fact),
    ['版本二'],
  )

  const out = recorder()
  main(['recall'], { env, out })
  assert.ok(out.all.includes('已被取代'), out.all)
  assert.ok(!out.all.includes('版本一'), out.all)
})

test('长期层挑条目：tier 小的先说，放不下的记 no-room 但不连坐', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const mk = (id, tier, fact) => makeItem({ id, tier, topic: 'x', fact, refs: '2026-11-01' }, { now })
  const items = [mk('a', 1, '中期结论'), mk('b', 0, '近期结论'.repeat(30))]
  const s = selectMemory(items, { budget: 40, now })
  assert.deepEqual(
    s.shown.map((it) => it.id),
    ['a'],
  )
  assert.equal(s.drops.length, 1)
  assert.ok(s.used <= 40)
})

// ---------------------------------------------------------------- 两层摘要

const manyMemory = (now, n = 6) =>
  Array.from({ length: n }, (_, i) =>
    makeItem({ id: `m${i}`, topic: `主题${i}`, fact: '结论'.repeat(20), refs: '2026-11-01' }, { now }),
  )

test('两层都在：长期层最多拿 60%，日记层不会被挤没', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const memory = manyMemory(now)
  const events = Array.from({ length: 6 }, (_, i) => ev(now - i * 3600e3, '日记'.repeat(20), 1))
  const { text, stats } = renderDigest({ events, memory }, { budget: 200, now })

  assert.ok(cost(text) <= 200, `实际=${cost(text)}`)
  assert.ok(stats.longUsed <= 120, `长期拿了超过 60%: ${stats.longUsed}`)
  assert.ok(stats.kept >= 1, '日记层被长期层挤没了')
  assert.ok(text.includes('记住的事'))
  assert.ok(text.indexOf('记住的事') < text.indexOf('最近'))
})

test('日记层空时，长期层能借到几乎全部预算', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const memory = manyMemory(now, 10)
  const { text, stats } = renderDigest({ events: [], memory }, { budget: 400, now })
  assert.ok(cost(text) <= 400, `实际=${cost(text)}`)
  assert.ok(stats.longKept > 5, `只装了 ${stats.longKept} 条：60% 的份额没有被借用`)
})

test('两层都塞满时整段仍不超预算，丢了就报 drops', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const memory = manyMemory(now, 12)
  const events = Array.from({ length: 30 }, (_, i) => ev(now - i * 3600e3, '这一条很长的日记'.repeat(5), i % 5 === 0 ? 3 : 1))
  const { text, stats } = renderDigest({ events, memory }, { budget: 300, now })
  assert.ok(cost(text) <= 300, `实际=${cost(text)}`)
  assert.ok(stats.drops.length + stats.longDrops.length > 0)
  assert.equal(stats.over, 0)
})
// ---------------------------------------------------------------- 欠账（巩固）

test('ISO 周按周四归属：跨年那几天不分家，1 月 4 日那周算第 1 周', () => {
  const at = (y, m, d) => new Date(y, m - 1, d, 12, 0).getTime()
  assert.equal(weekKey(at(2026, 1, 1)), '2026-W01') // 周四
  assert.equal(weekKey(at(2026, 1, 4)), '2026-W01') // 周日，还是同一周
  assert.equal(weekKey(at(2026, 1, 5)), '2026-W02')
  assert.equal(weekKey(at(2026, 12, 31)), '2026-W53')
  assert.equal(weekKey(at(2027, 1, 1)), '2026-W53') // 跨了年，但属于上一年的最后一周
  assert.equal(weekKey(at(2024, 12, 30)), '2025-W01') // 反过来：12 月最后几天可以属于下一年第 1 周
})

test('欠账只算到昨天：今天和本周都还没写完，允许滞后一个周期', () => {
  const now = new Date(2026, 10, 12, 10, 0).getTime() // 11-12 周四
  const ev = (y, m, d, h = 8) => ({ at: new Date(y, m - 1, d, h, 0).getTime(), fact: 'x' })

  const sameDay = owed([ev(2026, 11, 12)], { basis: new Date(2026, 10, 12, 9, 0).getTime(), now })
  assert.equal(sameDay.days, 0, '当天结过账，今天还没过完就不算欠')
  assert.equal(sameDay.weeks, 0)

  const oneDay = owed([ev(2026, 11, 9)], { basis: new Date(2026, 10, 10, 10, 0).getTime(), now })
  assert.equal(oneDay.days, 1, '11-10 结的账，昨天那份日记还欠着')
  assert.equal(oneDay.fromDay, '2026-11-10')

  const longGap = owed([ev(2026, 10, 20)], { basis: new Date(2026, 9, 20, 10, 0).getTime(), now })
  assert.ok(longGap.weeks >= 2, `周结欠账=${longGap.weeks}`)
  assert.equal(owedCount(longGap), longGap.days + longGap.weeks)
})

test('从来没结过账：从第一条日记算起，不报 0', () => {
  const now = new Date(2026, 10, 12, 10, 0).getTime()
  const events = [{ at: new Date(2026, 10, 9, 8, 0).getTime(), fact: 'a' }, { at: now - 3600e3, fact: 'b' }]
  const d = owed(events, { basis: null, now })
  assert.equal(d.settled, false)
  assert.equal(d.days, 2)
  assert.equal(d.fromDay, '2026-11-09')
  assert.equal(d.backlog.count, 2, '没结过账时积压是全部，不是"上次结账之后"')

  const empty = owed([], { basis: null, now })
  assert.equal(empty.any, false)
  assert.equal(empty.from, null)
})

test('按量欠账：30 条或 600 代价，超一个就算一次', () => {
  const now = new Date(2026, 10, 12, 10, 0).getTime()
  const basis = now - 600e3 // 十分钟前刚结过，日结周结都不欠，只剩按量
  const many = Array.from({ length: 30 }, (_, i) => ({ at: now - 1000 * i - 1000, fact: '短' }))

  const d = owed(many, { basis, now })
  assert.equal(d.backlog.count, 30)
  assert.equal(d.over, true)
  assert.equal(owedCount(d), 1, '按量只算一次，不按条数累加')

  assert.equal(owed(many.slice(0, 29), { basis, now }).over, false, '29 条还没到线')

  const heavy = [{ at: now - 2000, fact: '长'.repeat(600) }]
  assert.ok(backlog(heavy, -Infinity).cost >= BACKLOG_COST)
  assert.equal(owed(heavy, { basis, now }).over, true, '代价够了也算欠，哪怕只有一条')
})

test('remember 成功才写结账记录，校验不过就不写', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  main(['log', '今天风大'], { env, out: recorder(), now })
  assert.equal(readConsolidation(home), null, '还没 remember，不该有结账记录')

  assert.equal(main(['remember', '没有出处的结论', '--topic', '她怕冷'], { env, out: recorder(), now }), 1)
  assert.equal(readConsolidation(home), null, '校验失败的 remember 不能清账')

  assert.equal(
    main(['remember', '入秋后先关窗', '--topic', '她怕冷', '--refs', '2026-11-12'], { env, out: recorder(), now }),
    0,
  )
  const rec = readConsolidation(home)
  assert.equal(rec.at, now)
  assert.equal(rec.settled, 1)
  // 只存时刻，不存日/周标签：改 AGENT_MAN_DAY_START 不该让历史记录变形（§12）
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'settled'])
})

test('digest --due 只摊账：不渲染摘要，结完账就归零', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = localAt(2026, 11, 12, 12)
  main(['log', '三天前的日记', '--at', '2026-11-09 10:00'], { env, out: recorder(), now })
  main(['log', '昨天的日记', '--at', '2026-11-11 10:00'], { env, out: recorder(), now })

  const before = recorder()
  assert.equal(main(['digest', '--due'], { env, out: before, now }), 0)
  assert.ok(before.lines[0].startsWith('欠 2 次巩固'), before.all)
  assert.ok(!before.all.includes('我记得的事'), '--due 不该渲染摘要')

  main(['remember', '她怕冷', '--topic', '她怕冷', '--refs', '2026-11-09'], { env, out: recorder(), now })
  const after = recorder()
  assert.equal(main(['digest', '--due'], { env, out: after, now }), 0)
  assert.ok(after.lines[0].startsWith('没有欠账'), after.all)
})

test('结账记录坏了就报错，不猜', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const file = path.join(home, 'state', 'consolidation.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, '{ 这不是 JSON\n', 'utf8')
  const bad = recorder()
  assert.equal(main(['digest', '--due'], { env, out: bad }), 1)
  assert.ok(bad.errs.join('\n').includes('consolidation.json'), bad.errs.join('\n'))

  fs.writeFileSync(file, '{"settled":3}\n', 'utf8')
  const noAt = recorder()
  assert.equal(main(['digest', '--due'], { env, out: noAt }), 1)
  assert.ok(noAt.errs.join('\n').includes('at'), noAt.errs.join('\n'))
})

test('从没结过账时不说"上次结到"，那是另一件事', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  main(['log', '三周前的日记', '--at', '2026-10-21 10:00'], { env, out: recorder(), now })

  const out = recorder()
  assert.equal(main(['digest', '--due'], { env, out, now }), 0)
  assert.ok(out.all.includes('周结'), `三周没结过，周结那行也该出现：\n${out.all}`)
  assert.ok(out.all.includes('从第一条日记'), out.all)
  assert.ok(!out.all.includes('上次结到'), `从没结过账，不能说"上次结到"：\n${out.all}`)
})

// ---------------------------------------------------------------- 账本

test('digest 落一行账：装下的与丢掉的分得开，账里不抄原文', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  main(['log', '今天风大', '--at', '2026-11-12 11:52'], { env, out: recorder(), now })
  main(['log', '她把窗关上了', '--weight', '2', '--at', '2026-11-12 11:00'], { env, out: recorder(), now })

  assert.equal(main(['digest', '--budget', '60'], { env, out: recorder(), now }), 0)
  const { traces } = readTraces(home)
  assert.equal(traces.length, 1, '一次 digest 一行账')

  const t = traces[0]
  assert.equal(t.at, now)
  assert.equal(t.budget, 60)
  assert.ok(t.used <= 60, `账上的实占不能超预算：${t.used}`)
  const dropped = t.drops.map((d) => d.at)
  assert.equal(
    t.keptAt.length + dropped.length,
    2,
    `装下的 + 丢掉的 = 读到的，不许有条目凭空消失：${JSON.stringify(t)}`,
  )
  for (const at of t.keptAt) assert.ok(!dropped.includes(at), '同一条不能既算装下又算丢了')

  // 账是账不是备份：原文在 events.jsonl，抄一份进来就有两个会不一致的副本。
  const raw = fs.readFileSync(path.join(home, 'state', 'trace.jsonl'), 'utf8')
  assert.ok(!raw.includes('她把窗关上了'), `账本不该抄原文：${raw}`)
})

test('trace --never 报的是"没进过摘要"，不是"不重要"', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  main(['log', '早就写下的那条', '--at', '2026-11-12 10:00'], { env, out: recorder(), now })
  main(['digest'], { env, out: recorder(), now })

  const none = recorder()
  assert.equal(main(['trace', '--never'], { env, out: none }), 0)
  assert.ok(none.lines[0].startsWith('0 条日记没进过摘要'), none.all)

  main(['log', '进过账之后才写的', '--at', '2026-11-12 11:00'], { env, out: recorder(), now })
  const some = recorder()
  assert.equal(main(['trace', '--never'], { env, out: some }), 0)
  assert.ok(some.lines[0].startsWith('1 条日记没进过摘要'), some.all)
  assert.ok(some.all.includes('进过账之后才写的'), some.all)
  assert.ok(!some.all.includes('早就写下的那条'), `进过摘要的不该被列出来：\n${some.all}`)
})

test('trace 列出每次 digest 的账；--due 不记账（它本身就是账）', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  main(['log', '今天的风'], { env, out: recorder(), now })

  assert.equal(main(['digest', '--due'], { env, out: recorder(), now }), 0)
  assert.deepEqual(readTraces(home).traces, [], '--due 是问账，不是用摘要，不落账')

  const empty = recorder()
  assert.equal(main(['trace'], { env, out: empty }), 0)
  assert.ok(empty.lines[0].includes('还没有账'), empty.all)

  main(['digest', '--budget', '800'], { env, out: recorder(), now })
  main(['digest', '--budget', '400'], { env, out: recorder(), now })
  const out = recorder()
  assert.equal(main(['trace'], { env, out }), 0)
  assert.ok(out.lines[0].includes('共 2 次'), out.all)
  assert.ok(out.all.includes('预算 800') && out.all.includes('预算 400'), out.all)
})

test('账本坏行跳过并报出来，不让一条坏账藏住整本', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const file = path.join(home, 'state', 'trace.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"at":1794000000000,"budget":1200,"used":10,"keptAt":[]}\n坏了\n', 'utf8')

  const out = recorder()
  assert.equal(main(['trace'], { env, out }), 0)
  assert.ok(out.all.includes('共 1 次'), out.all)
  assert.ok(out.errs.join('\n').includes('1 行账读不出来'), out.errs.join('\n'))
})

test('trace --limit 只认正整数，多余的位置参数也不吃', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  assert.equal(main(['trace', '--limit', '0'], { env, out: recorder() }), 1)
  assert.equal(main(['trace', '--never', '10'], { env, out: recorder() }), 2)
})

// ---------------------------------------------------------------- find（日记原文）

test('find 按原文搜：命中就是命中，没命中的一条都不带', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '今天风大，她把窗关上了', '--at', '2026-11-10 10:00'], { env, out: recorder() })
  main(['log', '煮了番茄面，盐放多了', '--at', '2026-11-11 19:00'], { env, out: recorder() })

  const out = recorder()
  assert.equal(main(['find', '窗'], { env, out }), 0)
  assert.ok(out.lines[0].includes('2 条日记里，含“窗”的 1 条'), out.all)
  assert.ok(out.all.includes('她把窗关上了'), out.all)
  assert.ok(!out.all.includes('番茄面'), `没命中的不该跟着出现：\n${out.all}`)
})

test('find 只写日期时按本地整天算，不从 UTC 零点切一刀', () => {
  // Date.parse('2026-11-05') 是 UTC 零点，东八区等于当天 08:00。拿它当 --since
  // 会把 00:30 那条挡在外面，看着像"那天凌晨什么都没记"——实测踩过。
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '凌晨记的', '--at', '2026-11-05 00:30'], { env, out: recorder() })
  main(['log', '深夜记的', '--at', '2026-11-05 23:30'], { env, out: recorder() })
  main(['log', '隔天记的', '--at', '2026-11-06 00:30'], { env, out: recorder() })

  const out = recorder()
  assert.equal(main(['find', '记的', '--since', '2026-11-05', '--until', '2026-11-05'], { env, out }), 0)
  assert.ok(out.lines[0].includes('含“记的”的 2 条'), out.all)
  assert.ok(out.all.includes('凌晨记的') && out.all.includes('深夜记的'), out.all)
  assert.ok(!out.all.includes('隔天记的'), `--until 那天之后的不该混进来：\n${out.all}`)
})

test('find --kind 只看一类；--limit 取最近几条并说清还有多少没列', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '风很大', '--kind', 'dm', '--at', '2026-11-10 10:00'], { env, out: recorder() })
  main(['log', '风停了', '--kind', 'note', '--at', '2026-11-10 11:00'], { env, out: recorder() })
  main(['log', '风把门吹开', '--kind', 'dm', '--at', '2026-11-10 12:00'], { env, out: recorder() })

  const out = recorder()
  assert.equal(main(['find', '风', '--kind', 'dm', '--limit', '1'], { env, out }), 0)
  assert.ok(out.lines[0].includes('含“风”的 2 条（kind=dm）'), out.all)
  assert.ok(out.all.includes('风把门吹开'), out.all)
  assert.ok(!out.all.includes('风很大'), `--limit 1 只留最近一条：\n${out.all}`)
  assert.ok(out.all.includes('只列最近 1 条'), out.all)
})

test('find 没找到也是答案：exit 0，并且说清搜的是多大范围', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '今天风大'], { env, out: recorder(), now: Date.parse('2026-11-12T12:00:00+08:00') })

  const out = recorder()
  assert.equal(main(['find', '盐'], { env, out }), 0)
  assert.ok(out.lines[0].includes('1 条日记里没有含“盐”的'), out.all)
})

test('find 没给词就报错；它只搜日记，结论层归 recall --grep', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['remember', '入秋后先关窗再抱怨风', '--topic', '她怕冷', '--refs', '2026-11-05'], {
    env,
    out: recorder(),
  })

  const bad = recorder()
  assert.equal(main(['find'], { env, out: bad }), 1)
  assert.ok(bad.errs.join('\n').includes('要找什么'), bad.errs.join('\n'))

  const out = recorder()
  assert.equal(main(['find', '关窗'], { env, out }), 0)
  assert.ok(out.lines[0].includes('0 条日记里没有含“关窗”的'), `原文里没有，不该从长期层凑：\n${out.all}`)

  const recall = recorder()
  assert.equal(main(['recall', '--grep', '关窗'], { env, out: recall }), 0)
  assert.ok(recall.all.includes('她怕冷'), recall.all)
})

test('静默时段跨零点算得对：23 点是夜里，07 点还是夜里，08 点不是', () => {
  const t = (s) => parseAt(s)
  assert.equal(inQuiet(t('2026-11-12 23:30')), true)
  assert.equal(inQuiet(t('2026-11-13 07:59')), true)
  assert.equal(inQuiet(t('2026-11-13 08:00')), false)
  assert.equal(inQuiet(t('2026-11-12 22:59')), false)
})

test('cue：有新的就说，说出来之后不再重复端上来（水位）', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '今天风大', '--at', '2026-11-12 09:00'], {
    env, out: recorder(), now: t('2026-11-12 09:00'),
  })

  const out = recorder()
  assert.equal(main(['cue'], { env, out, now: t('2026-11-12 21:40') }), 0)
  assert.ok(out.all.includes('这会儿 21:40'), out.all)
  assert.ok(out.all.includes('还没在这儿开过口'), out.all)
  assert.ok(out.all.includes('今天风大'), out.all)

  const again = recorder()
  assert.equal(main(['cue'], { env, out: again, now: t('2026-11-12 22:00') }), 0)
  assert.ok(again.all.includes('不打扰'), again.all)
  assert.ok(again.all.includes('没有新东西'), again.all)
})

test('cue --out：话照说，只是换个去处——文件里是同一批行，屏幕上只留一句指路', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '今天风大', '--at', '2026-11-12 09:00'], {
    env, out: recorder(), now: t('2026-11-12 09:00'),
  })

  const file = path.join(env.AGENT_MAN_HOME, 'inbox', 'today.md')
  const out = recorder()
  assert.equal(main(['cue', '--out', file], { env, out, now: t('2026-11-12 21:40') }), 0)

  assert.deepEqual(out.lines, [`写好了: ${path.resolve(file)}`])
  assert.deepEqual(out.errs, [])
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('这会儿 21:40。'), text)
  assert.ok(text.includes('今天风大'), text)
  assert.ok(text.endsWith('\n'), '文件要以换行收尾，别让 cat 和下一行黏在一起')

  // 水位照走：写进文件也算"交给模型看过了"，否则定时跑一晚就每 6 小时说一遍同样的话。
  const again = recorder()
  main(['cue'], { env, out: again, now: t('2026-11-12 22:00') })
  assert.ok(again.all.includes('不打扰'), again.all)
})

test('cue --why：把这次为什么说记下来，下一次 cue 先看见上一次的判断', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '今天风大', '--at', '2026-11-12 09:00'], {
    env, out: recorder(), now: t('2026-11-12 09:00'),
  })

  const first = recorder()
  assert.equal(
    main(['cue', '--why', '她在开会，晚点再提'], { env, out: first, now: t('2026-11-12 21:40') }),
    0,
  )
  assert.ok(first.all.includes('今天风大'), first.all)

  const file = path.join(env.AGENT_MAN_HOME, 'state', 'judge.jsonl')
  const recs = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].said, true, '这次真开口了')
  assert.equal(recs[0].why, '她在开会，晚点再提')
  assert.ok(Number.isFinite(parseAt(recs[0].at)), 'at 要能解析回时刻')

  // 判断不能每次从零开始：下次即使没什么可说，也要先把上一次端出来。
  const again = recorder()
  assert.equal(main(['cue'], { env, out: again, now: t('2026-11-12 21:55') }), 0)
  assert.ok(again.all.includes('不打扰'), again.all)
  assert.ok(again.all.includes('上次：'), again.all)
  assert.ok(again.all.includes('说了话——她在开会，晚点再提'), again.all)
})

test('cue --why：没开口也记（said:false），--peek 看过不算说过', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '今天风大', '--at', '2026-11-12 09:00'], {
    env, out: recorder(), now: t('2026-11-12 09:00'),
  })
  // 先走一遍水位，第二次就落进"刚开过口，不到 6 小时"
  main(['cue'], { env, out: recorder(), now: t('2026-11-12 10:00') })

  const quiet = recorder()
  assert.equal(
    main(['cue', '--why', '刚说过，别念第二遍'], { env, out: quiet, now: t('2026-11-12 10:30') }),
    0,
  )
  assert.ok(quiet.all.includes('不打扰'), quiet.all)

  const peek = recorder()
  assert.equal(
    main(['cue', '--force', '--peek', '--why', '只看一眼'], {
      env, out: peek, now: t('2026-11-12 10:40'),
    }),
    0,
  )

  const file = path.join(env.AGENT_MAN_HOME, 'state', 'judge.jsonl')
  const recs = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
  assert.deepEqual(recs.map((r) => r.said), [false, false], '没开口和只看一眼，都不算说了话')
})

test('cue --why 给空串直接报错：可以没理由地说，但不能假装有理由', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['cue', '--why', ''], { env, out }), 1)
  assert.ok(out.errs.join('\n').includes('--why 不能是空的'), out.all)
  assert.equal(fs.existsSync(path.join(env.AGENT_MAN_HOME, 'state', 'judge.jsonl')), false)
})

test('判断记录只留最近 200 条；坏行跳过并计数，不让一行吃掉整段历史', () => {
  const home = tmp()
  const base = localAt(2026, 11, 12, 10, 0)
  for (let i = 0; i < 205; i++) {
    appendJudge(home, { at: stamp(base + i * 60_000), said: i % 2 === 0, why: `第 ${i} 条` })
  }

  const { judges, bad } = readJudges(home)
  assert.equal(bad, 0)
  assert.equal(judges.length, 200)
  assert.equal(judges[0].why, '第 5 条', '超上限时从最旧的开始丢')
  assert.equal(judges[199].why, '第 204 条')

  fs.appendFileSync(path.join(home, 'state', 'judge.jsonl'), '{ 坏\n', 'utf8')
  const after = readJudges(home)
  assert.equal(after.bad, 1)
  assert.equal(after.judges.length, 200)
})

test('cue：离上次开口不到六小时不叫人，--force 可以硬问', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '第一件'], { env, out: recorder(), now: t('2026-11-12 09:00') })
  main(['cue'], { env, out: recorder(), now: t('2026-11-12 10:00') })
  main(['log', '第二件'], { env, out: recorder(), now: t('2026-11-12 10:30') })

  const out = recorder()
  main(['cue'], { env, out, now: t('2026-11-12 11:00') })
  assert.ok(out.all.includes('不打扰'), out.all)
  assert.ok(out.all.includes('不到 6 小时'), out.all)

  const forced = recorder()
  assert.equal(main(['cue', '--force'], { env, out: forced, now: t('2026-11-12 11:00') }), 0)
  assert.ok(forced.all.includes('第二件'), forced.all)
})

test('cue：静默时段不叫人；--peek 说了也不记水位', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const t = (s) => parseAt(s)
  main(['log', '半夜的事'], { env, out: recorder(), now: t('2026-11-12 21:00') })

  const quiet = recorder()
  main(['cue'], { env, out: quiet, now: t('2026-11-12 23:30') })
  assert.ok(quiet.all.includes('静默时段'), quiet.all)

  const peek = recorder()
  main(['cue', '--force', '--peek'], { env, out: peek, now: t('2026-11-12 23:40') })
  assert.ok(peek.all.includes('半夜的事'), peek.all)

  const again = recorder()
  main(['cue'], { env, out: again, now: t('2026-11-13 09:00') })
  assert.ok(again.all.includes('半夜的事'), `--peek 不该把水位抬走：\n${again.all}`)
})

test('cue 的水位坏了就报错，不猜：猜错会让同一条日记永远端不上来', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  fs.mkdirSync(path.join(home, 'state'), { recursive: true })
  fs.writeFileSync(path.join(home, 'state', 'cue.json'), '{ 坏', 'utf8')
  const out = recorder()
  assert.equal(main(['cue'], { env, out, now: parseAt('2026-11-12 21:00') }), 1)
  assert.ok(out.errs.join('\n').includes('不是合法 JSON'), out.errs.join('\n'))
})

test('cue --min-gap / --limit 只认合法值，多余的位置参数也不吃', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const bad = recorder()
  assert.equal(main(['cue', '--limit', '0'], { env, out: bad }), 1)
  assert.ok(bad.errs.join('\n').includes('--limit 必须是正整数'))
  const gap = recorder()
  assert.equal(main(['cue', '--min-gap', 'abc'], { env, out: gap }), 1)
  assert.ok(gap.errs.join('\n').includes('--min-gap'))
  const pos = recorder()
  assert.equal(main(['cue', '多嘴'], { env, out: pos }), 2)
})

test('show 顺着 refs 回到那天的原文：结论能追到出处', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '她把窗关上了，说外面风大', '--at', '2026-11-12 09:00', '--kind', 'dm'], {
    env, out: recorder(), now: parseAt('2026-11-12 09:00'),
  })
  main(['log', '别的日子', '--at', '2026-11-06 09:00'], { env, out: recorder() })
  main(['remember', '入秋后先关窗再抱怨风', '--topic', '她怕冷', '--refs', '2026-11-05,2026-11-12'], {
    env, out: recorder(),
  })

  const out = recorder()
  assert.equal(main(['show', '怕冷'], { env, out }), 0)
  assert.ok(out.all.includes('她怕冷：入秋后先关窗再抱怨风'), out.all)
  assert.ok(out.all.includes('她把窗关上了'), `refs 指向的那天要能取出来：\n${out.all}`)
  assert.ok(!out.all.includes('别的日子'), `别的日子不该混进来：\n${out.all}`)
  assert.ok(out.all.includes('2026-11-05：那天没有日记'), `没日记的那天要明说，不能装作有：\n${out.all}`)
})

test('show 用 id 也能定位；--no-refs 的条目如实说没出处', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['remember', '她不喜欢被安排', '--topic', '边界', '--no-refs', '--id', '2026-11-12-01'], {
    env, out: recorder(),
  })
  const out = recorder()
  assert.equal(main(['show', '2026-11-12-01'], { env, out }), 0)
  assert.ok(out.all.includes('没写（存的时候用了 --no-refs）'), out.all)
})

test('show 只查长期层：没有这条结论就直说，并指向 find', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '她把窗关上了'], { env, out: recorder() })
  const out = recorder()
  assert.equal(main(['show', '关窗'], { env, out }), 0)
  assert.ok(out.all.includes('长期层里没有含“关窗”的结论'), out.all)
  assert.ok(out.all.includes('原文用 find'), out.all)

  const bad = recorder()
  assert.equal(main(['show'], { env, out: bad }), 1)
  assert.ok(bad.errs.join('\n').includes('要给个词'))
})

test('递话：便条由 cue 递出，递过就烧——不会再端第二次', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const now = parseAt('2026-11-12 20:00')
  const left = recorder()
  const code = main(['leave', '记得问她头痛好点没', '--when', '她提到加班时'], { env, out: left, now })
  assert.equal(code, 0)
  assert.ok(left.all.includes('留好了 2026-11-12-01'), left.all)

  const first = recorder()
  assert.equal(main(['cue'], { env, out: first, now }), 0)
  assert.ok(first.all.includes('记得问她头痛好点没'), first.all)
  assert.ok(first.all.includes('说的时候：她提到加班时'), first.all)

  const second = recorder()
  assert.equal(main(['cue'], { env, out: second, now: now + 7 * 3600e3 }), 0)
  assert.ok(!second.all.includes('记得问她头痛好点没'), `便条只能端一次：\n${second.all}`)
})

test('递话：没写什么时候看的便条不收——那是噪音', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['leave', '随便一句'], { env, out }), 1)
  assert.ok(out.errs.join('\n').includes('--when'), out.errs.join('\n'))
})

test('递话：过期的便条不端上来，但也不装作没有——只报一次', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const now = parseAt('2026-11-12 20:00')
  main(['leave', '三天前的计划', '--when', '下次开口时', '--ttl', '2'], { env, out: recorder(), now })
  const late = now + 3 * 24 * 3600e3

  const out = recorder()
  assert.equal(main(['cue'], { env, out, now: late }), 0)
  assert.ok(out.all.includes('过期作废'), out.all)
  assert.ok(!out.all.includes('· 2026-11-12-01  三天前的计划'), `作废的不能再端：\n${out.all}`)

  const again = recorder()
  assert.equal(main(['cue', '--force'], { env, out: again, now: late + 7 * 3600e3 }), 0)
  assert.ok(!again.all.includes('过期作废'), `报过一次就别念了：\n${again.all}`)
})

test('递话：静默时段不打扰，便条留着等下次开口', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const at = parseAt('2026-11-12 09:00')
  main(['leave', '明早要问她睡得怎么样', '--when', '下次开口时', '--at', '2026-11-12 09:00'], {
    env, out: recorder(), now: at,
  })

  const quiet = recorder()
  assert.equal(main(['cue'], { env, out: quiet, now: parseAt('2026-11-12 23:30') }), 0)
  assert.ok(quiet.all.includes('静默时段'), quiet.all)
  assert.ok(!quiet.all.includes('明早要问她'), `静默时段不该递：\n${quiet.all}`)

  const morning = recorder()
  assert.equal(main(['cue'], { env, out: morning, now: parseAt('2026-11-13 08:05') }), 0)
  assert.ok(morning.all.includes('明早要问她睡得怎么样'), `下一场该递出来：\n${morning.all}`)
})

test('递话：--peek 看过不烧——定时器的输出只是被记录时，别把便条吃掉', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const now = parseAt('2026-11-12 20:00')
  main(['leave', '带伞', '--when', '早上出门时'], { env, out: recorder(), now })

  const peek = recorder()
  assert.equal(main(['cue', '--peek', '--force'], { env, out: peek, now }), 0)
  assert.ok(peek.all.includes('带伞'), `--peek 也得看得见：\n${peek.all}`)

  const again = recorder()
  assert.equal(main(['cue', '--force'], { env, out: again, now: now + 60e3 }), 0)
  assert.ok(again.all.includes('带伞'), `--peek 不该烧掉便条，下一次还得递：\n${again.all}`)

  const third = recorder()
  assert.equal(main(['cue', '--force'], { env, out: third, now: now + 120e3 }), 0)
  assert.ok(!third.all.includes('带伞'), `真递过一次就烧了：\n${third.all}`)
})

// ---------------------------------------------------------------- 看天气

function skyOf(over = {}) {
  return {
    at: 0,
    place: '上海',
    current: { temp: 17.6, code: 3 },
    daily: [
      { date: '2026-11-12', tmax: 18.3, tmin: 12.7, precip: 0 },
      { date: '2026-11-13', tmax: 21.5, tmin: 14.6, precip: 2.4 },
    ],
    ...over,
  }
}

/** now 在天气源时区的今天/明天（'YYYY-MM-DD'）。 */
function sourceDates(now, tz = 'Asia/Shanghai') {
  const fmt = (t) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t))
  return [fmt(now), fmt(now + 24 * 3600e3)]
}

/** 假天气源：只记账、不发请求。天气是外部世界，测它必须能换数。 */
function fakeNet() {
  const calls = { geocode: 0, sky: 0 }
  const net = {
    calls,
    data: skyOf(),
    error: null,
    async geocode(name) {
      calls.geocode++
      return { name: `${name}，某市，中国`, short: name, lat: 31.2, lon: 121.4, tz: 'Asia/Shanghai' }
    },
    async fetchSky(place, { now }) {
      calls.sky++
      if (net.error) throw net.error
      // 真天气源给的是**它那个时区**的今天：假的照做，否则用例换个时区就跑不通。
      const [today, tomorrow] = sourceDates(now)
      const daily = net.data.daily.map((d, i) => ({ ...d, date: i ? tomorrow : today }))
      return { ...net.data, at: now, place: place.short, daily }
    },
  }
  return net
}

const skyNow = new Date(2026, 10, 12, 9, 0).getTime()

test('看天：第一次说，之后没变就不打扰——变了才开口', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()

  let out = recorder()
  assert.equal(await main(['place', '上海'], { env, out, now: skyNow, net }), 0)
  assert.match(out.all, /记下了：上海/)

  out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow, net }), 0)
  assert.match(out.all, /上海 09:00，阴，17\.6℃/)
  assert.match(out.all, /今天 12\.7–18\.3℃，明天 14\.6–21\.5℃/)
  assert.match(out.all, /第一次看天/)

  out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 3600e3, net }), 0)
  assert.match(out.all, /和上次说的一样，不打扰/)
})

test('看天：天况换类、最高温跳 5 度才叫变了（差 4.9 度不算）', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  await main(['sky'], { env, out: recorder(), now: skyNow, net })

  // 只涨 4.9 度、天况还是阴：不是新闻
  net.data = skyOf({ daily: [{ ...skyOf().daily[0], tmax: 23.2 }, skyOf().daily[1]] })
  const quiet = recorder()
  assert.equal(await main(['sky'], { env, out: quiet, now: skyNow + 3600e3, net }), 0)
  assert.doesNotMatch(quiet.all, /变了什么/)

  // 换类 + 下雨 + 跳 6.8 度：这才是"变了"
  const wet = skyOf({
    current: { temp: 19.1, code: 63 },
    daily: [{ date: '2026-11-12', tmax: 25.1, tmin: 13.4, precip: 3.2 }, skyOf().daily[1]],
  })
  net.data = wet
  const out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 7200e3, net }), 0)
  assert.match(out.all, /变了什么：/)
  assert.match(out.all, /阴变中雨/)
  assert.match(out.all, /最高 18\.3→25\.1℃/)
  assert.match(out.all, /要下雨 3\.2mm/)
})

test('看天：半小时内不重复取数，--fresh 才重新取', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  await main(['sky'], { env, out: recorder(), now: skyNow, net })
  assert.equal(net.calls.sky, 1)

  // 半小时之内再问：吃缓存，不再打天气源
  await main(['sky'], { env, out: recorder(), now: skyNow + 600e3, net })
  await main(['sky'], { env, out: recorder(), now: skyNow + 1500e3, net })
  assert.equal(net.calls.sky, 1)

  await main(['sky', '--fresh'], { env, out: recorder(), now: skyNow + 1600e3, net })
  assert.equal(net.calls.sky, 2)
})

test('看天：取不到数就直说；有旧数才用旧数，并且要报出是几点的', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })

  net.error = new Error('连不上天气源（timeout）；这次没取到数')
  let out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow, net }), 1)
  assert.match(out.errs.join('\n'), /连不上天气源/)

  // 先说一次，攒下旧数；一天以后断网：能说，但得说清那是几点的
  net.error = null
  await main(['sky'], { env, out: recorder(), now: skyNow, net })
  net.error = new Error('连不上天气源（timeout）；这次没取到数')
  out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 24 * 3600e3, net }), 0)
  assert.match(out.errs.join('\n'), /下面用的是 .*的数据/)
})

test('看天：缓存分四档——跨日的不许当今天说，超过一天就当没有', () => {
  const at = Date.parse('2026-11-12T09:00:00+08:00')
  const data = { daily: [{ date: '2026-11-12' }] }
  const rec = { at, data }

  assert.equal(cacheState(null), 'none')
  assert.equal(cacheState({ at, data: null }, { now: at }), 'none')
  assert.equal(cacheState(rec, { now: at + 60e3, tz: 'Asia/Shanghai' }), 'fresh')
  assert.equal(cacheState(rec, { now: at + 3600e3, tz: 'Asia/Shanghai' }), 'same-day')

  // 上海 13 号早上五点，纽约还是 12 号下午四点：同一个时刻，两个"今天"。
  const later = Date.parse('2026-11-13T05:00:00+08:00')
  assert.equal(cacheState(rec, { now: later, tz: 'Asia/Shanghai' }), 'cross-day')
  assert.equal(cacheState(rec, { now: later, tz: 'America/New_York' }), 'same-day')

  assert.equal(cacheState(rec, { now: at + 25 * 3600e3, tz: 'Asia/Shanghai' }), 'too-old')
})

test('看天：跨日那份数只报"上次的样子"，不装成今天，也不比"变了什么"', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  await main(['sky'], { env, out: recorder(), now: skyNow, net })

  // 隔了一天，断网：手上这份数说的是昨天，不许再拿"今天 13–18℃"糊过去。
  net.error = new Error('连不上天气源（timeout）；这次没取到数')
  const out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 24 * 3600e3, net }), 0)

  const text = out.lines.join('\n')
  // 报的是缓存里那天的日期（源时区的今天），不是本机的今天——别写死日期。
  const [, mm, dd] = sourceDates(skyNow)[0].split('-')
  assert.match(text, /今天没取到数/)
  assert.match(text, new RegExp(`上次是 ${Number(mm)} 月 ${Number(dd)} 日：`))
  assert.doesNotMatch(text, /变了什么/)
  assert.doesNotMatch(text, /今天 \d+–\d+℃/)
  assert.match(out.errs.join('\n'), /下面用的是 .*的数据/)
})

test('看天：超过一天的旧数当没有——宁可说没数，也不把前天的雨说成今天', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  await main(['sky'], { env, out: recorder(), now: skyNow, net })

  net.error = new Error('连不上天气源（timeout）；这次没取到数')
  const out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 25 * 3600e3, net }), 1)
  assert.match(out.errs.join('\n'), /连不上天气源/)
  assert.doesNotMatch(out.lines.join('\n'), /今天/)
})

test('看天：地方只查一次坐标，之后每次看天不再查地名', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  await main(['sky'], { env, out: recorder(), now: skyNow, net })
  await main(['sky', '--fresh'], { env, out: recorder(), now: skyNow + 60e3, net })
  assert.equal(net.calls.geocode, 1)
})

test('看天：没记下地方就不猜坐标，直接要城市名', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow, net: fakeNet() }), 1)
  assert.match(out.errs.join('\n'), /agent-man place/)
})

// ---------------------------------------------------------------- 日程

test('日程：记下、列出、划掉之后不再出现', () => {
  const env = { AGENT_MAN_HOME: tmp() }

  let out = recorder()
  assert.equal(main(['plan', '陪她去看牙', '--at', '2026-11-14 09:30'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /记下了 2026-11-14-p01：陪她去看牙/)

  out = recorder()
  assert.equal(main(['plan'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /接下来 7 天：1 条/)
  assert.match(out.all, /· 2026-11-14-p01  2026-11-14 09:30  陪她去看牙/)

  out = recorder()
  assert.equal(main(['plan', '--done', '2026-11-14-p01'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /划掉了 2026-11-14-p01/)

  out = recorder()
  assert.equal(main(['plan'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /接下来 7 天没有安排/)
})

test('日程：过点的不装作没有，标出来；划错了的 id 要能发现', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['plan', '早上寄快递', '--at', '2026-11-12 07:00'], { env, out: recorder(), now: skyNow })

  const out = recorder()
  assert.equal(main(['plan'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /早上寄快递（已经过点了）/)

  const bad = recorder()
  assert.equal(main(['plan', '--done', '2026-11-12-p99'], { env, out: bad, now: skyNow }), 1)
  assert.match(bad.errs.join('\n'), /没有这条安排：2026-11-12-p99/)
})

test('日程：没有时间的安排不是安排', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['plan', '陪她去看牙'], { env, out, now: skyNow }), 1)
  assert.match(out.errs.join('\n'), /新安排要写时间/)
})

test('看天：顺带报今天的安排；不打扰时只说还有几条', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  main(['plan', '陪她去看牙', '--at', '2026-11-12 15:30'], { env, out: recorder(), now: skyNow })

  let out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow, net }), 0)
  assert.match(out.all, /今天的安排：/)
  assert.match(out.all, /· 15:30  陪她去看牙/)

  out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 3600e3, net }), 0)
  assert.match(out.all, /今天还有 1 条安排/)
})

test('日程：未来按日历日说话，不把同一个日期说两遍', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['plan', '陪她去看牙', '--at', '2026-11-14 09:30'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /2026-11-14 09:30（2 天后）/)
  assert.doesNotMatch(out.all, /09:30（2026-11-14/)
})

test('cue：日程只是处境，不当开口的理由；列出来但不记水位', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['plan', '交电费', '--at', '2026-11-12 20:00'], { env, out: recorder(), now: skyNow })

  let out = recorder()
  assert.equal(main(['cue'], { env, out, now: skyNow }), 0)
  assert.match(out.all, /不打扰：没有新东西；今天还有 1 条安排/)
  assert.equal(fs.existsSync(path.join(env.AGENT_MAN_HOME, 'state', 'cue.json')), false)

  // 有日记要端上来时，顺带把今天的安排摆在处境里（已经过点的标出来）。
  main(['log', '她说电费又忘了'], { env, out: recorder(), now: skyNow })
  out = recorder()
  assert.equal(main(['cue'], { env, out, now: skyNow + 60e3 }), 0)
  assert.match(out.all, /今天的安排：/)
  assert.match(out.all, /· 20:00  交电费/)
})

// ---------------------------------------------------------------- 仓库自身

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function walkText(start, out = []) {
  for (const d of fs.readdirSync(path.join(repoRoot, start), { withFileTypes: true })) {
    if (d.name === '.git' || d.name === 'node_modules' || d.name === 'tmp') continue
    const rel = path.posix.join(start, d.name)
    if (d.isDirectory()) walkText(rel, out)
    else if (/\.(mjs|json|md|ya?ml)$/.test(d.name) || d.name.startsWith('.')) out.push(rel)
  }
  return out
}

test('仓库里没有第三方依赖：import 只认 node: 与相对路径', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(fs.existsSync(path.join(repoRoot, 'node_modules')), false)

  for (const rel of walkText('src').concat(walkText('bin'), walkText('test'))) {
    if (!rel.endsWith('.mjs')) continue
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    // 只看行首的 import/export：注释和字符串里提到 from ' 不算依赖
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*(?:import|export)\b.*?from '([^']+)'/) || line.match(/^\s*import '([^']+)'/)
      if (!m) continue
      const spec = m[1]
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${rel} 引了 ${spec}：不装依赖是硬约束`)
    }
  }
})

test('所有文本文件都是 LF、无 BOM：在 Windows 上改也不会整文件 diff', () => {
  const files = walkText('.')
  assert.ok(files.length > 10, '扫到的文件太少，说明遍历本身坏掉了')
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(repoRoot, rel))
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${rel} 带 BOM`)
    assert.equal(buf.includes(0x0d), false, `${rel} 里有 CR：行末必须是 LF`)
  }
})

test('bin 指向真实文件，版本号两边一致——打包前先对账', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(repoRoot, pkg.bin['agent-man'])), 'bin 指的文件不存在')

  const cli = fs.readFileSync(path.join(repoRoot, 'src/cli.mjs'), 'utf8')
  const m = cli.match(/const VERSION = '([^']+)'/)
  assert.ok(m, 'src/cli.mjs 里没有 VERSION')
  assert.equal(m[1], pkg.version, 'VERSION 和 package.json 的 version 不一致')

  // 打包带上的是这些东西，漏了 docs 就等于发了个没有说明书的东西
  for (const p of pkg.files) {
    assert.ok(fs.existsSync(path.join(repoRoot, p)), `package.json 的 files 里有不存在的路径：${p}`)
  }
})

// ---------------------------------------------------------------- 并发写（§29）

test('rename 撞上手：等一会儿再试，第三次成了就不报错', () => {
  let calls = 0
  const rename = () => {
    calls += 1
    if (calls >= 3) return
    const e = new Error('EPERM: operation not permitted, rename')
    e.code = 'EPERM'
    throw e
  }
  renameWithRetry(rename, 'a.tmp', 'a.json', { tries: 5, waitMs: 1 })
  assert.equal(calls, 3)
})

test('rename 一直是别人拿着：报"另一个进程正拿着它"，并收走临时文件', () => {
  const dir = tmp()
  const file = path.join(dir, 'a.json')
  const t = `${file}.123.tmp`
  fs.writeFileSync(t, '{}')
  const rename = () => {
    const e = new Error('EPERM: operation not permitted, rename')
    e.code = 'EPERM'
    throw e
  }
  assert.throws(() => renameWithRetry(rename, t, file, { tries: 3, waitMs: 1 }), /另一个进程正拿着它/)
  assert.equal(fs.existsSync(t), false, '放弃以后不该把 .tmp 留在目录里')
  assert.equal(fs.existsSync(file), false)
})

test('rename 的错不是"忙"就别重试：ENOENT 一次就抛', () => {
  let calls = 0
  const rename = () => {
    calls += 1
    const e = new Error('ENOENT: no such file or directory, rename')
    e.code = 'ENOENT'
    throw e
  }
  assert.throws(() => renameWithRetry(rename, 'missing.tmp', 'a.json', { tries: 4, waitMs: 1 }), /ENOENT/)
  assert.equal(calls, 1, '不是并发的错，重试只是拖时间')
})

test('结账写不进去：长期条目照样算记下了，只警告一句，不让人以为要重记', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = localAt(2026, 11, 12, 12)
  main(['log', '今天风大'], { env, out: recorder(), now })
  // 结账记录的位置被一个目录占住：读不出来，也换不上去
  fs.mkdirSync(path.join(home, 'state', 'consolidation.json'), { recursive: true })

  const out = recorder()
  const code = main(['remember', '入秋后先关窗', '--topic', '她怕冷', '--refs', '2026-11-12'], { env, out, now })
  assert.equal(code, 0, '条目已经落盘，命令就不该像没发生一样报失败')
  assert.equal(readMemory(home).items.length, 1, '条目本身必须已经落盘')
  assert.ok(out.lines.some((l) => l.includes('结账: 没更新')), out.all)
  assert.ok(out.errs.some((l) => l.includes('这条记下了')), out.all)
  assert.ok(!out.all.includes('清了'), '不能假装结过账')
})

test('发号的号是抢来的：别人先占了当天第一号，我就从第二号开始', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = localAt(2026, 11, 12, 12)
  assert.equal(claimId(home, '2026-11-12-01'), true, '第一个抢到')
  assert.equal(claimId(home, '2026-11-12-01'), false, '同一个号抢第二次要落空')

  main(['remember', '入秋后先关窗', '--topic', '她怕冷', '--refs', '2026-11-12'], { env, out: recorder(), now })
  assert.equal(readMemory(home).items[0].id, '2026-11-12-02', '号被占了就该往后挪，不能发重复的')
})

test('--id 是调用方自己认的号：不抢名额，撞了也不改', () => {
  const home = tmp()
  const env = { AGENT_MAN_HOME: home }
  const now = localAt(2026, 11, 12, 12)
  claimId(home, 'hand-made')
  const out = recorder()
  const argv = ['remember', '她自己认的号', '--topic', '她怕冷', '--refs', '2026-11-12', '--id', 'hand-made']
  assert.equal(main(argv, { env, out, now }), 0)
  assert.equal(readMemory(home).items[0].id, 'hand-made')
})

// ---------------------------------------------------------------- 一天

test('看天：今天的安排过点了要标出来——和 cue 一个口径（§31）', async () => {
  const env = { AGENT_MAN_HOME: tmp() }
  const net = fakeNet()
  await main(['place', '上海'], { env, out: recorder(), now: skyNow, net })
  main(['plan', '她要做体检', '--at', '2026-11-12 08:00'], { env, out: recorder(), now: skyNow })
  main(['plan', '下午三点她开会', '--at', '2026-11-12 15:00'], { env, out: recorder(), now: skyNow })

  const out = recorder()
  assert.equal(await main(['sky'], { env, out, now: skyNow + 4 * 3600e3, net }), 0)
  assert.ok(out.lines.includes('· 08:00  她要做体检（已经过点了）'), out.all)
  assert.ok(out.lines.includes('· 15:00  下午三点她开会'), `还没到的别乱标：\n${out.all}`)
})

test('一天：新日记、便条、作废的便条、今天的安排同时在场——顺序和数字都对得上', () => {
  const env = { AGENT_MAN_HOME: tmp() }
  main(['log', '早上她说梦到搬家', '--at', '2026-11-12 07:40'], {
    env, out: recorder(), now: parseAt('2026-11-12 07:40'),
  })
  main(['log', '中午她自己煮了面', '--at', '2026-11-12 12:10'], {
    env, out: recorder(), now: parseAt('2026-11-12 12:10'),
  })
  main(['remember', '入秋先关窗再抱怨风', '--topic', '她怕冷', '--refs', '2026-11-11'], {
    env, out: recorder(), now: parseAt('2026-11-12 09:00'),
  })
  main(['leave', '别急着问结果，先说今天辛苦了', '--when', '她提体检', '--at', '2026-11-12 08:00'], {
    env, out: recorder(), now: parseAt('2026-11-12 08:00'),
  })
  main(['leave', '旧的便条，早该作废', '--when', '下次开口时', '--ttl', '1', '--at', '2026-11-11 09:00'], {
    env, out: recorder(), now: parseAt('2026-11-11 09:00'),
  })
  main(['plan', '她要做体检', '--at', '2026-11-12 09:30'], { env, out: recorder(), now: parseAt('2026-11-12 06:00') })

  const now = parseAt('2026-11-12 13:27')
  const out = recorder()
  assert.equal(main(['cue'], { env, out, now }), 0)
  const text = out.all
  const marks = ['之后攒了 2 条', '还留了 1 张便条', '已过期作废', '今天的安排：'].map((s) => text.indexOf(s))
  assert.ok(marks.every((i) => i >= 0), `四段都要在：\n${text}`)
  assert.deepEqual([...marks].sort((a, b) => a - b), marks, `顺序是日记→便条→作废→安排：\n${text}`)
  assert.ok(text.includes('· 09:30  她要做体检（已经过点了）'), text)

  // 再看一次：便条烧掉了、作废的只念一次、日记不重复念
  const again = recorder()
  assert.equal(main(['cue'], { env, out: again, now: now + 7 * 3600e3 }), 0)
  assert.ok(!again.all.includes('先说今天辛苦了'), `便条递过就烧：\n${again.all}`)
  assert.ok(!again.all.includes('已过期作废'), `作废的只报一次：\n${again.all}`)
  assert.ok(!again.all.includes('早上她说梦到搬家'), `同一条日记别念第二遍：\n${again.all}`)

  const digest = recorder()
  assert.equal(main(['digest', '--budget', '400'], { env, out: digest, now: now + 8 * 3600e3 }), 0)
  assert.ok(digest.all.includes('## 记住的事'), digest.all)
  assert.ok(digest.all.includes('入秋先关窗再抱怨风'), digest.all)
  assert.ok(digest.all.includes('## 最近'), digest.all)
})

// ---------------------------------------------------------------- 零件在进程外（§32）

/** 造一个假零件：把收到的参数写进 got.json 再退出（退出码默认 3）。 */
function fakePart(dir, name = 'testpart', code = 3) {
  const got = path.join(dir, 'got.json')
  fs.writeFileSync(
    path.join(dir, `${name}.mjs`),
    `import fs from 'node:fs'\n` +
      `fs.writeFileSync(${JSON.stringify(got)}, JSON.stringify(process.argv.slice(2)))\n` +
      `process.exit(${code})\n`,
  )
  if (process.platform === 'win32') {
    // npm 在 Windows 上给的就是 .cmd（不能直接 CreateProcess，得走 cmd.exe /c）
    fs.writeFileSync(path.join(dir, `agent-man-${name}.cmd`), `@node "%~dp0${name}.mjs" %*\r\n`)
  } else {
    const shim = path.join(dir, `agent-man-${name}`)
    fs.writeFileSync(shim, `#!/bin/sh\nnode "$(dirname "$0")/${name}.mjs" "$@"\n`)
    fs.chmodSync(shim, 0o755)
  }
  return got
}

const partEnv = (dir) => ({
  ...process.env,
  PATH: dir + path.delimiter + process.env.PATH,
  AGENT_MAN_HOME: tmp(),
})

test('零件：命令表里没有的名字，转给 PATH 上的 agent-man-<名字>，退出码透传', () => {
  const dir = tmp()
  const got = fakePart(dir)
  assert.equal(main(['testpart', '--limit', '5'], { env: partEnv(dir), out: recorder() }), 3)
  assert.deepEqual(JSON.parse(fs.readFileSync(got, 'utf8')), ['--limit', '5'])
})

test('零件：参数原样到（空格、中文、& 都不拆）', () => {
  const dir = tmp()
  const got = fakePart(dir)
  const argv = ['带 空格', '中文', 'a&b']
  assert.equal(main(['testpart', ...argv], { env: partEnv(dir), out: recorder() }), 3)
  assert.deepEqual(JSON.parse(fs.readFileSync(got, 'utf8')), argv)
})

test('零件：没装就还是未知命令，并说清怎么装', () => {
  const env = { ...process.env, PATH: tmp(), AGENT_MAN_HOME: tmp() }
  const out = recorder()
  assert.equal(main(['nope'], { env, out }), 2)
  assert.match(out.all, /未知命令: nope/)
  assert.match(out.all, /npm i -g agent-man-nope/)
})

test(
  '零件：Windows 上参数里有 %名字% 直接拒绝（cmd 会把它换成环境变量）',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = tmp()
    fakePart(dir)
    const out = recorder()
    assert.equal(main(['testpart', '%PATH%'], { env: partEnv(dir), out }), 2)
    assert.match(out.all, /不能有 %名字%/)
  },
)

test('日记带出处：行里能看见这条是谁记的', () => {
  const env = { ...process.env, AGENT_MAN_HOME: tmp() }
  main(['log', '刷了 B站', '--src', 'bili', '--at', '2026-11-12 09:00'], { env, out: recorder() })
  main(['log', '手写的', '--at', '2026-11-12 09:05'], { env, out: recorder() })
  const out = recorder()
  main(['ls'], { env, out })
  assert.match(out.all, /\[note\|bili\]  刷了 B站/)
  assert.match(out.all, /\[note\]  手写的/)
})
