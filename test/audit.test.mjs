// audit 车道的用例：三个只读检查（trace / timeline / orphan）+ doctor 自检。
// 每条用例名都要能读成一句约束（AGENTS 六）——"跑完文件数不变"是约束，函数名不是。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { trace } from '../src/audit/index.mjs'
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
