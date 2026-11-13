// host 车道的用例只钉四件事：装配的账（整块丢、used 是 cost(text)）、回顾的降级、
// 工具的参数校验与"只有六个写入口"、以及 apply 在假 ctx 上不抛。
// 装配与回顾是纯函数，所以这里不需要 DSH 运行时；apply 用记录调用的假 ctx 贴着真实的形状跑。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cost } from '../src/core/index.mjs'
import {
  LOOK_ACTIONS, SLOTS, TOOLS, WRITE_ACTIONS, affectLine, callTool, compose, recall,
} from '../src/host/index.mjs'
import { debt } from '../src/mind/index.mjs'
import { use as useSoul } from '../src/soul/index.mjs'
import { apply } from '../dsh/index.mjs'

// 时间一律传死（AGENTS 六）：本地 2026-11-13 15:00。CI 有别的时区腿，所以不用带偏移的字符串。
const T = new Date(2026, 10, 13, 15, 0).getTime()

async function inHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    return await body(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// 一句话的块：给多少字就是多少 cost（半角 0.28/字）。
const ascii = (n, ch = 'a') => ch.repeat(n)

test('compose 按固定次序装块，块之间空一行，used 就是 cost(text)', () => {
  const out = compose({
    blocks: [
      { name: 'recall', text: '回顾', budget: 100 },
      { name: 'soul', text: '灵魂', budget: 100 },
      { name: 'situation', text: '处境', budget: 100 },
    ],
    budget: 100,
  })
  assert.equal(out.text, '灵魂\n\n处境\n\n回顾')
  assert.equal(out.used, cost(out.text))
  assert.deepEqual(out.dropped, [])
  assert.equal(out.budget, 100)
})

test('块超过自己的槽位就整块丢：不切半句、不占总预算', () => {
  const body = ascii(40) // 11.2 cost
  const out = compose({ blocks: [{ name: 'soul', text: body, budget: 5 }], budget: 1000 })
  assert.equal(out.text, '')
  assert.equal(out.used, cost(''))
  assert.deepEqual(out.dropped,
    [{ name: 'soul', reason: 'budget', stage: 'slot', used: cost(body), budget: 5 }])
  assert.match(out.warnings.join('\n'), /! soul 块 11\.2 cost 超过它的槽位 5/)
})

test('槽位过了、总预算装不下：整块丢，剩下的块照旧原样装进去', () => {
  const big = ascii(100) // 28 cost
  const out = compose({
    blocks: [
      { name: 'soul', text: '灵魂', budget: 100 },
      { name: 'situation', text: big, budget: 100 },
    ],
    budget: 20, // 灵魂 2 + 空行 0.56 + 大块 28 装不下
  })
  assert.equal(out.text, '灵魂')
  assert.equal(out.used, cost(out.text))
  assert.equal(out.dropped.length, 1)
  assert.equal(out.dropped[0].name, 'situation')
  assert.equal(out.dropped[0].stage, 'total')
  // 丢的理由要写在警告里，且要报出"加上它要多少"，不然人不知道差多少。
  assert.match(out.warnings.join('\n'), /situation 块放不进总预算 20（加上它要 30\.6）/)
})

test('总预算连一块都装不下时 text 为空、used 为 0，不拿账本数字冒充', () => {
  const out = compose({ blocks: [{ name: 'soul', text: ascii(10), budget: 100 }], budget: 1 })
  assert.equal(out.text, '')
  assert.equal(out.used, 0)
  assert.equal(out.dropped[0].stage, 'total')
})

test('不认识的块名与重复的块都会被说出来，不安静地少一块', () => {
  const out = compose({
    blocks: [
      { name: 'nope', text: 'x', budget: 10 },
      { name: 'soul', text: '一', budget: 10 },
      { name: 'soul', text: '二', budget: 10 },
    ],
    budget: 100,
  })
  assert.equal(out.text, '一')
  assert.deepEqual(out.dropped.map((one) => one.reason), ['unknown', 'duplicate'])
  assert.equal(out.warnings.filter((line) => line.startsWith('! ')).length, 2)
})

test('空块不占 dropped、也不占预算', () => {
  const out = compose({
    blocks: [{ name: 'soul', text: '  \n ', budget: 10 }, { name: 'user', text: '称呼', budget: 10 }],
    budget: 100,
  })
  assert.equal(out.text, '称呼')
  assert.deepEqual(out.dropped, [])
})

test('情绪行只出数字与标签，不超过 80 cost，且不含第一人称感受动词', () => {
  const line = affectLine({ v: 58.4, e: 61, t: 43.2, r: 0, mood: '平淡', transient: [1, 2, 3] })
  assert.match(line, /^v=58 e=61 t=43 r=0 · 平淡 · 3 条刺激 · /)
  assert.ok(cost(line) <= 80, `情绪行 ${cost(line)} cost 超过 80`)
  assert.doesNotMatch(line, /我|感到|觉得|feel/u)
})

test('情绪行在隐藏、缺轴、快照为空时整行不出', () => {
  const snap = { v: 50, e: 60, t: 40, r: 0, mood: '平淡', transient: [] }
  assert.equal(affectLine(snap, { visible: false }), '')
  assert.equal(affectLine({ ...snap, e: undefined }), '')
  assert.equal(affectLine(null), '')
})

test('拿不到 search 时回顾空着，只给一条 ! 警告，不抛', async () => {
  const out = await recall({ now: T, budget: 100 })
  assert.equal(out.text, '')
  assert.deepEqual(out.lines, [])
  assert.equal(out.used, 0)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /^! /)
  assert.match(out.warnings[0], /search 没接上/)
})

test('回顾按预算装：整条装不下就切在句子边界，切过的记一笔 cut', async () => {
  const lines = [
    { sessionId: 's1', seq: 3, text: '第一句话。第二句话也很长很长很长很长很长很长很长。' },
    { sessionId: 's2', seq: 7, text: '另一条命中' },
  ]
  const out = await recall({ lines, now: T, budget: 40 })
  assert.ok(out.used <= 40)
  assert.equal(out.used, cost(out.text))
  assert.match(out.text, /^来自旧会话的字面命中，不是当前会话内容。\n- s1#3：/)
  assert.ok(out.dropped.some((one) => one.reason === 'cut' || one.reason === 'budget'))
})

test('回顾：检索抛错只降级成警告', async () => {
  const out = await recall({
    search: async () => { throw new Error('sessionQuery 挂了') },
    now: T,
    budget: 100,
  })
  assert.equal(out.text, '')
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /旧会话检索失败（sessionQuery 挂了）/)
})

test('两个工具的名字与写入口只有那六项', () => {
  assert.deepEqual(TOOLS.map((one) => one.name), ['agent_man', 'agent_man_look'])
  assert.deepEqual([...WRITE_ACTIONS],
    ['event add', 'memory add', 'rule add', 'note add', 'plan add', 'self append'])
  const write = TOOLS.find((one) => one.name === 'agent_man')
  const look = TOOLS.find((one) => one.name === 'agent_man_look')
  assert.deepEqual(write.inputSchema.properties.action.enum, [...WRITE_ACTIONS])
  assert.deepEqual(look.inputSchema.properties.action.enum, [...LOOK_ACTIONS])
  assert.equal(write.inputSchema.additionalProperties, false)
})

test('工具参数不合法一律返回 { ok: false, error }，不抛', async () => {
  const cases = [
    [{ name: 'nope', args: {} }, /不认识的工具/],
    [null, /不认识的工具/],
    [{ name: 'agent_man', args: null }, /参数要是对象/],
    [{ name: 'agent_man', args: [] }, /参数要是对象/],
    [{ name: 'agent_man', args: {} }, /action 只能是/],
    [{ name: 'agent_man', args: { action: 'do something' } }, /action 只能是/],
    [{ name: 'agent_man', args: { action: 'event add' } }, /event add 缺 text/],
    [{ name: 'agent_man', args: { action: 'rule add', text: 'x' } }, /rule add 缺 why/],
    [{ name: 'agent_man', args: { action: 'memory add', key: 'k', fact: 'f' } },
      /memory add 要 evidence：至少 1 个 event id/],
    [{ name: 'agent_man', args: { action: 'memory add', key: 'k', fact: 'f', evidence: {} } },
      /evidence 只能是 event id 的数组/],
    [{ name: 'agent_man', args: { action: 'note add', text: 'x', trigger: 'y', imp: 9 } },
      /imp 只能是 0–3 的整数/],
    [{ name: 'agent_man_look', args: { action: 'event find' } }, /event find 要 query/],
  ]
  for (const [call, want] of cases) {
    const out = await callTool(call?.name, call?.args, { home: '/nowhere', now: T })
    assert.equal(out.ok, false, `${JSON.stringify(call)} 应该报错`)
    assert.equal(typeof out.error, 'string')
    assert.match(out.error, want)
  }
})

test('工具没有 home 就不动笔：返回错误而不是落到不知道哪儿', async () => {
  const out = await callTool('agent_man', { action: 'event add', text: 'x' }, { now: T })
  assert.equal(out.ok, false)
  assert.match(out.error, /没有数据目录/)
})

test('工具背后是领域门面：三个写入口真写盘，读回来就是那条记录', async () => {
  await inHome(async (home) => {
    const ev = await callTool('agent_man', { action: 'event add', text: '今天把宿主层写完了' },
      { home, now: T })
    assert.equal(typeof ev, 'string')
    assert.match(ev, /^已记下事件 e-\d{8}-\d{2}$/)

    const rule = await callTool('agent_man', {
      action: 'rule add', text: '注入超预算就整块丢', why: '半句比没有更误导',
    }, { home, now: T })
    assert.match(rule, /^已立下规矩 r-\d{8}-\d{2}$/)

    const self = await callTool('agent_man', { action: 'self append', line: '说话先给结论' },
      { home, now: T })
    assert.equal(self, '已追加到自我块')

    // 读回来：情景能查到刚记的那条，自我块里有刚追加的那一行。
    const found = await callTool('agent_man_look', { action: 'event find', query: '宿主层' },
      { home, now: T })
    assert.match(found, /找到 1 条/)
    assert.match(found, /今天把宿主层写完了/)
  })
})

test('context show 出处境屏：读的是 mind 的快照，不是宿主自己拼的一堆字', async () => {
  await inHome(async (home) => {
    const out = await callTool('agent_man_look', { action: 'context show' }, { home, now: T })
    assert.equal(typeof out, 'string')
    // 空数据目录上也要有屏：抬头带时刻，正文说清"什么都没发生"，不是空白也不是报错。
    assert.match(out, /^agent-man · 2026-11-13 15:00/)
    assert.ok(out.trim().length > 20)
  })
})

test('event find 在空数据目录上给"没有"，不是报错', async () => {
  await inHome(async (home) => {
    const out = await callTool('agent_man_look', { action: 'event find', query: '注入' }, { home, now: T })
    assert.equal(typeof out, 'string')
    assert.match(out, /^没有含「注入」的事件（读了 0 条）/)
  })
})

test('note add 走 intent 门面写成便条', async () => {
  await inHome(async (home) => {
    const out = await callTool('agent_man', {
      action: 'note add', text: '回头把回顾的预算再算一遍', trigger: '聊到注入预算',
    }, { home, now: T })
    assert.equal(typeof out, 'string')
    assert.match(out, /^已记下便条 n-\d{8}-\d{2}/)
  })
})

test('apply 在假 ctx 上不抛：挂 agent/created、注册两个工具', async () => {
  await inHome(async (home) => {
    const calls = { on: [], register: [] }
    const ctx = {
      on(name, handler) {
        calls.on.push({ name, handler })
      },
      get(name) {
        if (name === 'tools') return { register: (tool) => calls.register.push(tool) }
        return null
      },
    }
    const warnings = []
    apply(ctx, { env: { AGENT_MAN_HOME: home }, warn: (line) => warnings.push(line) })

    assert.deepEqual(calls.on.map((one) => one.name), ['agent/created'])
    assert.deepEqual(calls.register.map((one) => one.name), ['agent_man', 'agent_man_look'])
    for (const tool of calls.register) {
      assert.equal(typeof tool.description, 'string')
      assert.equal(typeof tool.handler, 'function')
      assert.equal(tool.inputSchema.type, 'object')
    }
  })
})

test('apply 的 pre-step：只对 root 的第 1 步注入一条，子代理不注入', async () => {
  await inHome(async (home) => {
    // 放一张最小的卡并切成当前：注入里的自我块得真的从 soul 门面来，不是测试自己拼的。
    const card = path.join(home, 'soul', '小满')
    fs.mkdirSync(card, { recursive: true })
    fs.writeFileSync(path.join(card, 'name.md'), '小满。叫对方"你"。\n')
    fs.writeFileSync(path.join(card, 'identity.md'), '运维出身，现在替你盯代码和线上。\n')
    fs.writeFileSync(path.join(card, 'soul.md'), '句子短。\n')
    fs.writeFileSync(path.join(card, 'dialogue.md'), '<START>\n你: 报错怎么修\n我: 把日志贴全。\n')
    fs.writeFileSync(path.join(card, 'card.json'), '{"name":"小满","knobs":{"warm":0,"drive":0,"sharp":0}}\n')
    await useSoul(home, '小满', { at: T, by: 'test' })

    const calls = { on: [], register: [] }
    const ctx = {
      on(name, handler) { calls.on.push({ name, handler }) },
      get(name) { return name === 'tools' ? { register: (tool) => calls.register.push(tool) } : null },
    }
    const warnings = []
    apply(ctx, { env: { AGENT_MAN_HOME: home }, warn: (line) => warnings.push(line) })

    const hooks = []
    const agent = { ctx: { on(name, handler, opts) { hooks.push({ name, handler, opts }) } } }
    calls.on[0].handler({ agent })
    assert.equal(hooks.length, 1)
    assert.equal(hooks[0].name, 'agent/pre-step')
    assert.deepEqual(hooks[0].opts, { prepend: true })

    const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: '现有' }] })
    const payload = {
      step: 1,
      header: { parentSession: null, origin: 'user' },
      messages: [{ role: 'user', content: [{ type: 'text', text: '继续看 docs/design.md 的注入' }] }],
    }
    const out = await hooks[0].handler(payload, next)
    assert.equal(out.kind, 'enter')
    assert.equal(out.messages.length, 2)
    const added = out.messages[0]
    assert.equal(added.role, 'user')
    assert.equal(added.source.kind, 'agent-man')
    const text = added.content[0].text
    assert.ok(cost(text) <= 1000, `注入 ${cost(text)} cost 超过总预算`)
    assert.match(text, /\[称呼\] 小满/u)
    // 情绪行是块里的最后一段：只有数字、标签与那句机械规则，不许出现第一人称感受动词。
    const blocks = text.split('\n\n')
    const mood = blocks[blocks.length - 1]
    assert.match(mood, /^v=50 e=60 t=40 r=0 · /u)
    assert.doesNotMatch(mood, /我|感到|觉得|feel/u)
    // 没有 sessionQuery：回顾这一步要明说跳过，而不是让模型以为"旧会话里什么都没有"。
    assert.ok(warnings.some((line) => line.includes('search 没接上')), warnings.join('\n'))

    const childHeader = { parentSession: 'p1', origin: 'subagent' }
    const child = await hooks[0].handler({ ...payload, header: childHeader }, next)
    assert.equal(child.messages.length, 1)
  })
})

test('apply 在坏 ctx 上安静退出，不抛', () => {
  assert.doesNotThrow(() => apply(null))
  assert.doesNotThrow(() => apply({}))
  assert.doesNotThrow(() => apply({ on() { throw new Error('宿主炸了') } }, { env: {}, warn: () => {} }))
})

test('SLOTS 的次序就是 §9 的总装次序', () => {
  assert.deepEqual([...SLOTS], ['soul', 'user', 'situation', 'recall'])
})

test('写情景顺手记欠账：记完一条 imp=2 的事，欠账就是 2 imp / 1 条', async () => {
  await inHome(async (home) => {
    await callTool('agent_man', { action: 'event add', text: '她说明天要早出门', imp: 2 },
      { home, now: T })
    const got = debt.state(home, { now: T })
    assert.equal(got.unconsolidated, 2)
    assert.equal(got.unreflected, 1)
  })
})
