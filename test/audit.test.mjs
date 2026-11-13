// audit 车道的用例：三个只读检查（trace / timeline / orphan）+ doctor 自检。
// 每条用例名都要能读成一句约束（AGENTS 六）——"跑完文件数不变"是约束，函数名不是。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { doctor, orphan, timeline, trace } from '../src/audit/index.mjs'
import { DEFAULT_WINDOW_DAYS, RULE_LIMIT, SELF_MAX, cost } from '../src/core/index.mjs'
import { notes, plans } from '../src/intent/index.mjs'
import { add as addMemory } from '../src/memory/index.mjs'
import { appendJsonl, ensure, eventsFile, stateFile } from '../src/store/index.mjs'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// 时间一律传死（AGENTS 六）：用本地时间构造函数，CI 的纽约时区腿也走同一天。
const NOW = new Date(2026, 10, 13, 21, 40).getTime()

async function inHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    return await body(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// 数据目录的完整快照：文件名（目录带 /）+ 每个文件的内容。
// 只比文件名会漏掉"内容被改写"，只比内容会漏掉"多建了一个空文件"。
function snapshot(dir) {
  const out = []
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        out.push(`${rel}/`)
        walk(full)
      } else {
        out.push(`${rel}:${fs.readFileSync(full, 'utf8')}`)
      }
    }
  }
  walk(dir)
  return out.sort()
}

function seedEvent(home, { id, at, text }) {
  ensure(home)
  return appendJsonl(eventsFile(home, at), { id, at, text, src: { origin: 'user' } })
}

function seedRule(home, { id, at, supersedes = [], text = '夜里十一点后不提工作' }) {
  ensure(home)
  return appendJsonl(path.join(home, 'rules.jsonl'), { id, at, text, why: '昨天 23:40 提加班', supersedes })
}

function traceRow(at, over = {}) {
  return {
    at,
    budget: 1200,
    used: 1087,
    header: 'full',
    kept: ['m-1'],
    dropped: [{ id: 'e-2', reason: 'budget' }],
    ...over,
  }
}

function seedTrace(home, row) {
  ensure(home)
  return appendJsonl(stateFile(home, 'trace', row.at), row)
}

function check(report, name) {
  const one = report.checks.find((item) => item.name === name)
  assert.ok(one, `doctor 少了「${name}」这一项`)
  return one
}

test('trace 按 at 倒序只给最近 20 条，但总数照实说', async () => {
  await inHome(async (home) => {
    for (let i = 0; i < 25; i += 1) seedTrace(home, traceRow(NOW - i * MINUTE))
    const got = trace({ home, now: NOW })
    assert.equal(got.total, 25)
    assert.equal(got.limit, 20)
    assert.equal(got.items.length, 20)
    assert.equal(got.items[0].at, NOW)
    assert.equal(got.items[19].at, NOW - 19 * MINUTE)
    // 一条账只交出六格：渲染归 view，audit 不夹带别的字段。
    assert.deepEqual(Object.keys(got.items[0]).sort(), ['at', 'budget', 'dropped', 'header', 'kept', 'used'])
    assert.deepEqual(got.items[0].dropped, [{ id: 'e-2', reason: 'budget' }])
  })
})

test('trace 跨月分片一起读：上个月的账不会因为翻月就不见', async () => {
  await inHome(async (home) => {
    const last = new Date(2026, 9, 5, 9, 0).getTime()
    seedTrace(home, traceRow(last))
    seedTrace(home, traceRow(NOW))
    // 两笔账真落在两个月的文件里，否则这条用例什么也没验。
    assert.notEqual(stateFile(home, 'trace', last), stateFile(home, 'trace', NOW))
    const got = trace({ home, now: NOW })
    assert.deepEqual(got.items.map((one) => one.at), [NOW, last])
    assert.equal(got.total, 2)
  })
})

test('trace 坏行与形状不全的行跳过并计数，不装作没发生', async () => {
  await inHome(async (home) => {
    seedTrace(home, traceRow(NOW))
    const file = stateFile(home, 'trace', NOW)
    fs.appendFileSync(file, 'not json\n')
    fs.appendFileSync(file, `${JSON.stringify({ at: NOW - MINUTE, budget: 'x' })}\n`)
    const got = trace({ home, now: NOW })
    assert.equal(got.skipped, 2)
    assert.deepEqual(got.items.map((one) => one.at), [NOW])
  })
})

test('trace 的形状由 schema 说了算：多写的字段照样读得出，缺格的账跳过', async () => {
  await inHome(async (home) => {
    // 账本将来多记一个快照（design §14.13 的情绪）照样能读：形状不锁死在 audit 这一层。
    seedTrace(home, { ...traceRow(NOW), affect: { mood: 'tired' } })
    // 少了 header：这行读不出"抬头当时让到哪一档"，跳过并计数，不替它补一个空串。
    const at = NOW - MINUTE
    ensure(home)
    appendJsonl(stateFile(home, 'trace', at), { at, budget: 1200, used: 10, kept: [], dropped: [] })
    const got = trace({ home, now: NOW })
    assert.deepEqual(got.items.map((one) => one.at), [NOW])
    assert.equal(got.skipped, 1)
    // 判完形状只交六格：多写的字段不往上层流。
    assert.deepEqual(Object.keys(got.items[0]).sort(), ['at', 'budget', 'dropped', 'header', 'kept', 'used'])
  })
})

test('trace 的 limit 只认非负整数，打错就拒绝并说清怎么给', async () => {
  await inHome(async (home) => {
    seedTrace(home, traceRow(NOW))
    assert.throws(() => trace({ home, limit: -1 }), /limit/)
    assert.throws(() => trace({ home, limit: 1.5 }), /limit/)
    // 0 是合法请求：只要总数，不要条目。
    const none = trace({ home, limit: 0 })
    assert.deepEqual(none.items, [])
    assert.equal(none.total, 1)
  })
})

test('trace 是读命令：跑完账本一个字节都不变', async () => {
  await inHome(async (home) => {
    seedTrace(home, traceRow(NOW))
    const before = snapshot(home)
    trace({ home, now: NOW })
    assert.deepEqual(snapshot(home), before)
  })
})

test('trace 在没有数据的地方不抛也不建库', async () => {
  await inHome(async (home) => {
    assert.deepEqual(trace({ home, now: NOW }), { items: [], total: 0, limit: 20, skipped: 0 })
    assert.deepEqual(fs.readdirSync(home), [])
  })
})

test('timeline 把五类记忆按 at 排成一条线，kind 用记录的单数名', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW - 5 * HOUR, text: '她关了窗' })
    await addMemory(
      { key: '她怕冷', fact: '她关窗是因为冷', at: NOW - 4 * HOUR, evidence: { ids: ['e-1'] } },
      { home, now: NOW },
    )
    seedRule(home, { id: 'r-1', at: NOW - 3 * HOUR })
    await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: NOW - 2 * HOUR })
    await plans.add(home, { text: '陪她看牙', due: NOW + DAY, at: NOW - HOUR })

    const got = timeline({ home, now: NOW })
    assert.deepEqual(got.items.map((one) => one.kind), ['plan', 'note', 'rule', 'memory', 'event'])
    assert.deepEqual(Object.keys(got.items[0]).sort(), ['at', 'id', 'kind', 'text'])
    assert.match(got.items[0].id, /^p-/)
    assert.match(got.items[1].id, /^n-/)
    assert.equal(got.items[2].id, 'r-1')
    assert.equal(got.items[3].text, '她关窗是因为冷')
    assert.equal(got.items[4].text, '她关了窗')
    assert.equal(got.total, 5)
    assert.equal(got.since, NOW - DEFAULT_WINDOW_DAYS * DAY)
    assert.equal(got.all, false)
  })
})

test('timeline 默认只给窗口内的，给了 all 才把更早的也放进来', async () => {
  await inHome(async (home) => {
    const old = NOW - (DEFAULT_WINDOW_DAYS + 1) * DAY
    seedEvent(home, { id: 'e-old', at: old, text: '很久以前' })
    seedEvent(home, { id: 'e-new', at: NOW - HOUR, text: '刚刚' })

    const recent = timeline({ home, now: NOW })
    assert.deepEqual(recent.items.map((one) => one.id), ['e-new'])
    assert.equal(recent.since, NOW - DEFAULT_WINDOW_DAYS * DAY)

    const full = timeline({ home, now: NOW, all: true })
    assert.deepEqual(full.items.map((one) => one.id), ['e-new', 'e-old'])
    assert.equal(full.since, null)
    assert.equal(full.all, true)
  })
})

test('timeline 的 limit 只截显示条数，被截掉的用 total 说出来', async () => {
  await inHome(async (home) => {
    for (let i = 1; i <= 3; i += 1) seedEvent(home, { id: `e-${i}`, at: NOW - i * HOUR, text: `第 ${i} 件` })
    const got = timeline({ home, now: NOW, limit: 2 })
    assert.equal(got.items.length, 2)
    assert.equal(got.total, 3)
    assert.equal(got.limit, 2)
    assert.throws(() => timeline({ home, now: NOW, limit: -2 }), /limit/)
    // 不给 limit 就是不截：时间线的条数由窗口决定，不另设隐藏上限。
    assert.equal(timeline({ home, now: NOW }).limit, null)
  })
})

test('timeline 把坏行记为 skipped，不装作时间线是干净的', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW - HOUR, text: '她关了窗' })
    seedRule(home, { id: 'r-1', at: NOW - 2 * HOUR })
    fs.appendFileSync(eventsFile(home, NOW), 'oops\n')
    // 合法 JSON 但缺 text 的规矩行：读不出正文，算坏行而不是一条空规矩。
    fs.appendFileSync(path.join(home, 'rules.jsonl'), `${JSON.stringify({ id: 'r-2', at: NOW })}\n`)
    const got = timeline({ home, now: NOW })
    assert.equal(got.skipped, 2)
    assert.deepEqual(got.items.map((one) => one.id), ['e-1', 'r-1'])
  })
})

test('timeline 不落盘：跑完数据目录的文件数与字节都不变', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW - HOUR, text: '她关了窗' })
    seedRule(home, { id: 'r-1', at: NOW - 2 * HOUR })
    await notes.add(home, { text: '问她头痛好点没', trigger: '她提到加班', at: NOW - 3 * HOUR })
    const before = snapshot(home)
    timeline({ home, now: NOW, all: true })
    assert.deepEqual(snapshot(home), before)
  })
})

test('timeline 没有 home 就报错，不去读进程的当前目录', async () => {
  assert.throws(() => timeline({ now: NOW }), /timeline 需要一个数据目录/)
  assert.throws(() => timeline({ home: '   ', now: NOW }), /timeline 需要一个数据目录/)
})

test('证据指向不存在的事件：orphan 把结论与缺的 id 一起列出来', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW, text: '她关了窗' })
    await addMemory(
      { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-1', 'e-ghost'] } },
      { home, now: NOW },
    )
    const got = orphan({ home })
    assert.equal(got.items.length, 1)
    assert.equal(got.items[0].key, '她怕冷')
    assert.deepEqual(got.items[0].missing, ['e-ghost'])
    assert.equal(got.skipped, 0)
  })
})

test('orphan 只报不改：跑完 memory.jsonl 与事件分片一个字节都不变', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW, text: '她关了窗' })
    // 造一条坏证据的结论：事件那边没了一半（分片丢了 / 只写了一半），结论还指着它。
    // 不能靠 add 造——证据一条都解析不到时 add 会拒写（design §4 的闸），所以先用真事件
    // 写一条合法的，再追加同 id 的新版本把证据换掉（只追加、后写赢，正是收口那一套）。
    const made = await addMemory(
      { key: '她怕冷', fact: '她关窗是因为冷', evidence: { ids: ['e-1'] } },
      { home, now: NOW },
    )
    appendJsonl(path.join(home, 'memory.jsonl'), { ...made.record, evidence: { ids: ['e-1', 'e-ghost'] } })
    const before = snapshot(home)
    assert.equal(orphan({ home }).items.length, 1)
    assert.deepEqual(snapshot(home), before)
  })
})

test('orphan 没有 home 就报错，不猜一个默认目录', async () => {
  assert.throws(() => orphan({}), /orphan 需要一个数据目录/)
})

test('空数据目录上 doctor 不抛：说缺 schema，别的项照实报', async () => {
  await inHome(async (home) => {
    const got = doctor({ home, ctx: { home } })
    assert.equal(got.ok, false)
    assert.equal(check(got, '数据目录').ok, true)
    const schema = check(got, 'schema 版本')
    assert.equal(schema.ok, false)
    assert.match(schema.detail, /schema\.json/)
    assert.equal(check(got, '分片坏行').ok, true)
    assert.equal(check(got, 'self.md 预算').ok, true)
    assert.equal(check(got, 'rules 活条数').ok, true)
  })
})

test('坏行不吞：doctor 列出坏行所在文件与行号', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW, text: '她关了窗' })
    const file = eventsFile(home, NOW)
    fs.appendFileSync(file, 'not json\n')
    const got = doctor({ home })
    const bad = check(got, '分片坏行')
    assert.equal(bad.ok, false)
    // 文件按数据目录的相对路径报，行号是文件里的真实行号（第 2 行）。
    assert.match(bad.detail, /events\/2026-11-13\.jsonl:2/)
    assert.match(bad.detail, /不是合法 JSON/)
    assert.equal(got.ok, false)
  })
})

test('同 id 同 at 的两行判为收口副本冲突，并说出是哪个 id', async () => {
  await inHome(async (home) => {
    ensure(home)
    const row = {
      id: 'm-1',
      at: NOW,
      key: '她怕冷',
      fact: '她关窗是因为冷',
      imp: 3,
      from: NOW,
      to: null,
      by: null,
      evidence: { ids: ['e-1'] },
    }
    appendJsonl(path.join(home, 'memory.jsonl'), row)
    appendJsonl(path.join(home, 'memory.jsonl'), row)
    const one = check(doctor({ home }), 'memory 收口副本')
    assert.equal(one.ok, false)
    assert.match(one.detail, /m-1/)
    assert.match(one.detail, /at=/)
  })
})

test(`规则超过 ${RULE_LIMIT} 条 doctor 报红，但不删任何一条`, async () => {
  await inHome(async (home) => {
    for (let i = 1; i <= RULE_LIMIT + 1; i += 1) seedRule(home, { id: `r-${i}`, at: NOW - i * MINUTE })
    const file = path.join(home, 'rules.jsonl')
    const before = fs.readFileSync(file, 'utf8')
    const one = check(doctor({ home }), 'rules 活条数')
    assert.equal(one.ok, false)
    assert.match(one.detail, new RegExp(String(RULE_LIMIT + 1)))
    // 只报不改：一行都没被删（doctor 没有自动修复这个功能，也不该有）。
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(before.split('\n').filter(Boolean).length, RULE_LIMIT + 1)
  })
})

test('被 supersedes 收口的规矩不算活条数：21 行只留 1 条活', async () => {
  await inHome(async (home) => {
    const old = []
    for (let i = 1; i <= RULE_LIMIT; i += 1) {
      seedRule(home, { id: `r-${i}`, at: NOW - i * MINUTE })
      old.push(`r-${i}`)
    }
    seedRule(home, { id: 'r-new', at: NOW, supersedes: old, text: '夜里十一点后不提工作，改成十点' })
    const one = check(doctor({ home }), 'rules 活条数')
    assert.equal(one.ok, true)
    assert.match(one.detail, new RegExp(`1 / ${RULE_LIMIT}`))
  })
})

test('self.md 超过 SELF_MAX doctor 报红，但文件一字不动', async () => {
  await inHome(async (home) => {
    ensure(home)
    const text = '很'.repeat(SELF_MAX + 1)
    fs.writeFileSync(path.join(home, 'self.md'), text)
    // 先确认这份样本真的超预算，否则这条用例证不了任何事。
    assert.ok(cost(text) > SELF_MAX)
    const one = check(doctor({ home }), 'self.md 预算')
    assert.equal(one.ok, false)
    assert.match(one.detail, new RegExp(String(SELF_MAX)))
    assert.equal(fs.readFileSync(path.join(home, 'self.md'), 'utf8'), text)
  })
})

test('meta.json 的 parts 冷却记录形状不对就报红，并指出哪个插件哪个字段', async () => {
  await inHome(async (home) => {
    ensure(home)
    const meta = path.join(home, 'state', 'meta.json')
    fs.writeFileSync(meta, JSON.stringify({ parts: { weather: { fail: 'x', until: 'soon' } } }))
    const bad = check(doctor({ home }), 'meta.json 冷却记录')
    assert.equal(bad.ok, false)
    assert.match(bad.detail, /weather/)
    assert.match(bad.detail, /fail/)
    assert.match(bad.detail, /until/)

    // 形状正确的一条不该被误报（fail 0 + until null 是 design §4 的静止态）。
    fs.writeFileSync(meta, JSON.stringify({ parts: { weather: { fail: 0, until: null } } }))
    assert.equal(check(doctor({ home }), 'meta.json 冷却记录').ok, true)
  })
})

test('meta.json 坏成不是 JSON：说读不出，不假装没写过', async () => {
  await inHome(async (home) => {
    ensure(home)
    fs.writeFileSync(path.join(home, 'state', 'meta.json'), '{oops')
    const one = check(doctor({ home }), 'meta.json 冷却记录')
    assert.equal(one.ok, false)
    assert.match(one.detail, /JSON/)
  })
})

test('schema 版本与代码不一致就报红，并说清这份数据该怎么处理', async () => {
  await inHome(async (home) => {
    ensure(home)
    fs.writeFileSync(path.join(home, 'schema.json'), '{"version":2}\n')
    const one = check(doctor({ home }), 'schema 版本')
    assert.equal(one.ok, false)
    assert.match(one.detail, /2/)
  })
})

test('数据目录不存在时 doctor 不抛，指出缺的是哪个目录', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    const dir = path.join(base, 'nope')
    const got = doctor({ home: dir })
    assert.equal(got.ok, false)
    assert.equal(check(got, '数据目录').ok, false)
    assert.match(check(got, '数据目录').detail, /不存在/)
    assert.ok(check(got, '数据目录').detail.includes(dir))
    // 只是查，不顺手把目录建出来。
    assert.equal(fs.existsSync(dir), false)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('doctor 是读命令：跑完数据目录的文件清单与字节全同', async () => {
  await inHome(async (home) => {
    seedEvent(home, { id: 'e-1', at: NOW, text: '她关了窗' })
    seedRule(home, { id: 'r-1', at: NOW - HOUR })
    seedTrace(home, traceRow(NOW))
    fs.writeFileSync(path.join(home, 'state', 'meta.json'), JSON.stringify({ parts: {} }))
    fs.writeFileSync(path.join(home, 'self.md'), '# 我\n\n话不多，先听。\n')
    const before = snapshot(home)
    doctor({ home })
    assert.deepEqual(snapshot(home), before)
  })
})

test('doctor 的七项自检一项不少，每项都带正文', async () => {
  await inHome(async (home) => {
    const got = doctor({ home })
    assert.deepEqual(got.checks.map((one) => one.name), [
      '数据目录',
      'schema 版本',
      '分片坏行',
      'memory 收口副本',
      'meta.json 冷却记录',
      'self.md 预算',
      'rules 活条数',
    ])
    for (const one of got.checks) {
      assert.equal(typeof one.ok, 'boolean')
      assert.equal(typeof one.detail, 'string')
      assert.ok(one.detail.trim() !== '', `${one.name} 没有正文：读的人看不出发生了什么`)
    }
    // ok 是七项的与，不是另算一次——两处各算一遍迟早分叉。
    assert.equal(got.ok, got.checks.every((one) => one.ok))
  })
})
