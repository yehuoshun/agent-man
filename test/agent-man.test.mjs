import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseAt, dayKey, dayStartFromEnv, relTime, stamp, weekKey } from '../src/time.mjs'
import { cost, truncate } from '../src/cost.mjs'
import { select } from '../src/budget.mjs'
import { renderDigest } from '../src/render.mjs'
import {
  readEvents,
  appendEvent,
  readMemory,
  resolveHome,
  writeAtomic,
  readConsolidation,
  readTraces,
} from '../src/store.mjs'
import { makeItem, activeItems, selectMemory } from '../src/memory.mjs'
import { owed, owedCount, backlog, BACKLOG_COST } from '../src/consolidate.mjs'
import { main, parseArgs, FLAGS } from '../src/cli.mjs'

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
  const at = Date.parse('2026-11-12T00:30:00+08:00')
  assert.equal(dayKey(at), '2026-11-12')
  assert.equal(dayKey(at, { dayStart: 4 }), '2026-11-11')
  assert.equal(dayKey(Date.parse('2026-11-12T04:30:00+08:00'), { dayStart: 4 }), '2026-11-12')
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
  const now = Date.parse('2026-11-12T12:00:00+08:00')
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
  const now = Date.parse('2026-11-12T12:00:00+08:00')
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
  const now = Date.parse('2026-11-12T12:00:00+08:00')
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