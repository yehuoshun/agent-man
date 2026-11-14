// dsh/ 宿主适配的用例：用一个假的 DSH 宿主把插件真装进去，走一遍生命周期（design §9）。
// 这个假宿主就是我们目前对 DSH 契约的假设：`ctx.on`、`ctx.get('tools' | 'sessionQuery')`、
// `agent/created` 里给 `agent.ctx.on / effect`。实机形状不一样时只改这里，插件那侧不该跟着动。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cost } from '../src/core/index.mjs'
import { eventAdd } from '../src/memory/index.mjs'
import { use as useSoul } from '../src/soul/index.mjs'
import { apply } from '../dsh/index.mjs'

const T = new Date(2026, 10, 14, 10, 0).getTime()
const HOMES = []

function newHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  return dir
}

test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})

// 假宿主：钩子、工具、检索三样服务都在，缺哪样由参数决定。
// 返回的 state 里留着宿主侧的记录（谁挂了什么、注册了哪些工具、喊了哪些警告），供断言用。
function fakeHost({ home, sessions = null, tools = true } = {}) {
  const state = { applied: [], hooks: [], registered: [], warnings: [], effects: 0 }
  const ctx = {
    on(name, handler) {
      state.applied.push({ name, handler })
    },
    get(name) {
      if (name === 'tools') return tools ? { register: (tool) => state.registered.push(tool) } : null
      if (name === 'sessionQuery') return sessions
      return null
    },
  }
  apply(ctx, { env: { AGENT_MAN_HOME: home }, warn: (line) => state.warnings.push(line) })

  // 模拟宿主开出一个会话：agent/created 的载荷里带 agent.ctx。
  state.openSession = () => {
    const agent = {
      ctx: {
        on(name, handler, opts) {
          state.hooks.push({ name, handler, opts })
        },
        effect(register) {
          state.effects += 1
          register()
        },
      },
    }
    const created = state.applied.find((one) => one.name === 'agent/created')
    if (created !== undefined) created.handler({ agent })
  }
  state.preStep = (payload, next) => {
    const hook = state.hooks.find((one) => one.name === 'agent/pre-step')
    return hook.handler(payload, next)
  }
  return state
}

// 假的 sessionQuery：只认"按 id 取事件、按 text 子串过滤"这两件，够 search.mjs 用就行。
function fakeSessions(rows) {
  return {
    async filterSessions() {
      return rows.map((one) => ({ header: { id: one.id } }))
    },
    async filterEvents(id, filters) {
      const want = filters.find((one) => one.kind === 'text')
      const needle = want && typeof want.text === 'string' ? want.text : ''
      return rows
        .filter((one) => one.id === id)
        .flatMap((one) => one.events)
        .filter((one) => needle !== '' && one.text.includes(needle))
    },
  }
}

const enter = async () => ({ kind: 'enter', messages: [{ role: 'user', content: '现有' }] })
const ROOT = { parentSession: null, origin: 'user', id: 's0', cwd: 'E:\\work' }

// 一张最小的卡：注入里的 [称呼] 行得真的从 soul 门面出来，不是用例自己拼的。
async function plantCard(home) {
  const card = path.join(home, 'soul', '小满')
  fs.mkdirSync(card, { recursive: true })
  fs.writeFileSync(path.join(card, 'name.md'), '小满。叫对方"你"。\n')
  fs.writeFileSync(path.join(card, 'soul.md'), '句子短。\n')
  fs.writeFileSync(path.join(card, 'card.json'), '{"name":"小满","knobs":{"warm":0,"drive":0,"sharp":0}}\n')
  await useSoul(home, '小满', { at: T, by: 'test' })
}

test('首步注入：root 第 1 步在最前插一条，自我/处境/情绪/回顾都在，总 cost 不超预算', async () => {
  const home = newHome()
  await plantCard(home)
  const sessions = fakeSessions([
    { id: 's1', events: [{ seq: 3, text: '上次说 docs/design.md 的注入按块装' }] },
  ])
  const host = fakeHost({ home, sessions })
  // 情景走工具入口写：欠账也是那条路上记的（tools 里 add 完就 bump），直接调门面不会记账。
  const write = host.registered.find((one) => one.name === 'agent_man')
  await write.handler({ action: 'event add', text: '她说明天复查眼睛', imp: 2 })
  host.openSession()

  const payload = {
    step: 1,
    header: ROOT,
    messages: [{ role: 'user', content: [{ type: 'text', text: '接着看 docs/design.md 的注入' }] }],
  }
  const out = await host.preStep(payload, enter)
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 2)

  const added = out.messages[0]
  assert.equal(added.role, 'user')
  assert.equal(added.source.kind, 'agent-man')
  const text = added.content[0].text
  assert.ok(cost(text) <= 1000, `注入 ${cost(text)} cost 超过总预算`)

  // 四块都在：自我 → 处境 → 情绪 → 回顾。
  assert.match(text, /\[称呼\] 小满/u)
  assert.match(text, /积压：2 条待巩固/u)
  assert.match(text, /^v=50 e=60 t=40 r=0 · /mu)
  assert.match(text, /来自旧会话的字面命中，不是当前会话内容/u)
  assert.match(text, /docs\/design\.md/u)
  assert.ok(text.indexOf('[称呼]') < text.indexOf('积压'), '自我块没有排在处境前面')
  // 抬头那行是给人看的屏框，注入里不许出现（同一时刻不说两遍）。
  assert.equal(text.startsWith('agent-man · '), false)
  assert.deepEqual(host.warnings, [])
})

test('只有 root 的第 1 步注入：第 2 步、子代理、被拦、被中止都不插', async () => {
  const home = newHome()
  await eventAdd({ text: '她在改预算', imp: 1 }, { home, now: T })
  const host = fakeHost({ home })
  host.openSession()
  const messages = [{ role: 'user', content: '继续' }]

  const second = await host.preStep({ step: 2, header: ROOT, messages }, enter)
  assert.equal(second.messages.length, 1)

  const child = await host.preStep(
    { step: 1, header: { parentSession: 'p1', origin: 'subagent' }, messages },
    enter,
  )
  assert.equal(child.messages.length, 1)

  const seeded = await host.preStep(
    { step: 1, header: { ...ROOT, isSeeded: true }, messages },
    enter,
  )
  assert.equal(seeded.messages.length, 1)

  const deep = await host.preStep(
    { step: 1, header: { ...ROOT, delegationDepth: 1 }, messages },
    enter,
  )
  assert.equal(deep.messages.length, 1)

  const blocked = await host.preStep({ step: 1, header: ROOT, messages }, async () => ({
    kind: 'block',
    messages: [],
  }))
  assert.equal(blocked.kind, 'block')

  const aborted = await host.preStep(
    { step: 1, header: ROOT, messages, signal: { aborted: true } },
    enter,
  )
  assert.equal(aborted.messages.length, 1)

  // 宿主没给 header：宁可不注入，也不能把主会话的自我块塞进子代理。
  const headerless = await host.preStep({ step: 1, messages }, enter)
  assert.equal(headerless.messages.length, 1)
})

test('两个工具按宿主给的形状注册，handler 真写盘、真出处境屏', async () => {
  const home = newHome()
  const host = fakeHost({ home })
  assert.deepEqual(host.registered.map((one) => one.name), ['agent_man', 'agent_man_look'])
  for (const tool of host.registered) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(typeof tool.description, 'string')
  }

  const write = host.registered.find((one) => one.name === 'agent_man')
  const wrote = await write.handler({ action: 'event add', text: '她说明天复查眼睛', imp: 2 })
  assert.equal(typeof wrote, 'string')
  assert.match(wrote, /^已记下事件 e-\d{8}-\d{2}/u)

  const look = host.registered.find((one) => one.name === 'agent_man_look')
  const screen = await look.handler({ action: 'context show' })
  assert.match(screen, /^agent-man · /u)
  // 处境屏只报"有几条待巩固"，不逐条列情景：写进去的那条要靠 event find 读回来。
  assert.match(screen, /积压：2 条待巩固/u)
  const found = await look.handler({ action: 'event find', query: '复查' })
  assert.match(found, /复查眼睛/u)

  // 参数不合形状时给一句能照着改的话，不抛，也不交对象给宿主（宿主不知道该拿它怎么办）。
  const bad = await write.handler({ action: 'event add' })
  assert.equal(typeof bad, 'string')
  assert.match(bad, /^! event add 缺 text/u)
})

test('宿主不给 tools 服务：只警告一句，注入照旧', async () => {
  const home = newHome()
  await eventAdd({ text: '她在改预算', imp: 1 }, { home, now: T })
  const host = fakeHost({ home, tools: false })
  assert.equal(host.registered.length, 0)
  assert.ok(host.warnings.some((line) => line.includes('工具没注册')), host.warnings.join('\n'))

  host.openSession()
  const out = await host.preStep(
    { step: 1, header: ROOT, messages: [{ role: 'user', content: '在吗' }] },
    enter,
  )
  assert.equal(out.messages.length, 2)
})

test('sessionQuery 在但检索抛错：只少回顾这一块，处境与情绪照旧', async () => {
  const home = newHome()
  const sessions = {
    async filterSessions() {
      throw new Error('库锁住了')
    },
    async filterEvents() {
      return []
    },
  }
  const host = fakeHost({ home, sessions })
  const write = host.registered.find((one) => one.name === 'agent_man')
  await write.handler({ action: 'event add', text: '她在改预算', imp: 2 })
  host.openSession()
  const out = await host.preStep(
    { step: 1, header: ROOT, messages: [{ role: 'user', content: '看 docs/design.md' }] },
    enter,
  )
  const text = out.messages[0].content[0].text
  assert.match(text, /积压：2 条待巩固/u)
  assert.doesNotMatch(text, /来自旧会话/u)
  assert.ok(host.warnings.some((line) => line.includes('旧会话检索失败')), host.warnings.join('\n'))
})

test('effect 有就用：注册挂在作用域里，且只挂一次', async () => {
  const home = newHome()
  const host = fakeHost({ home })
  host.openSession()
  assert.equal(host.effects, 1)
  assert.equal(host.hooks.length, 1)
  assert.deepEqual(host.hooks[0].opts, { prepend: true })
})

test('注入里的任何一块坏了都不许挡路：处境算不出来也照样注入别的', async () => {
  const home = newHome()
  // 数据目录里放一个同名文件，让 ensure/situation 读不出来（真实场景是盘坏了或权限没了）。
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'events'), 'not a dir')
  const host = fakeHost({ home })
  host.openSession()
  const out = await host.preStep(
    { step: 1, header: ROOT, messages: [{ role: 'user', content: '在吗' }] },
    enter,
  )
  assert.equal(out.kind, 'enter')
  assert.ok(Array.isArray(out.messages))
  assert.ok(host.warnings.some((line) => line.startsWith('! ')), host.warnings.join('\n'))
})
