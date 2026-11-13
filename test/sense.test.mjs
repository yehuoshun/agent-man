import test from 'node:test'
import assert from 'node:assert/strict'
import { sense } from '../src/parts/index.mjs'
import { cost, LINE_OVERHEAD, PART_STDOUT_MAX } from '../src/core/index.mjs'

const part = (name) => ({ name, file: `C:/fake/agent-man-${name}` })

// 默认让每个零件都"正常答话"：describe 报契约五字段，capture 回一行。
function deps({ desc = {}, run = {} } = {}) {
  return {
    scan: () => [],
    describe: async (p) => desc[p.name] ?? { ok: true, name: p.name, desc: '', section: '环境', timeout_ms: 1000, side_effects: false },
    capture: async (p) => run[p.name] ?? { status: 'ok', code: 0, out: `${p.name} 答话`, err: '', truncated: false },
  }
}

test('零件按预算装，装不下的进 dropped 并写明是预算', async () => {
  const wide = '很'.repeat(200) // 200 cost，一行就够撑爆一个小预算
  const r = await sense({}, { budget: 100, parts: [part('a'), part('b')], deps: deps({ run: { a: { status: 'ok', out: wide, err: '', truncated: false } } }) })
  assert.deepEqual(r.lines.map((one) => one.name), ['b'])
  assert.deepEqual(r.dropped, [{ name: 'a', reason: 'budget' }])
  assert.ok(r.used + cost(wide) + LINE_OVERHEAD > r.budget)
})

test('--describe 不可用的零件只出一条警告，不拖死别的零件', async () => {
  const r = await sense({}, {
    parts: [part('bad'), part('good')],
    deps: deps({ desc: { bad: { ok: false, why: 'bad 的 --describe 崩了（退出码 1）' } } }),
  })
  assert.deepEqual(r.lines.map((one) => one.name), ['good'])
  assert.deepEqual(r.warnings, ['! bad 的 --describe 崩了（退出码 1）'])
  assert.deepEqual(r.failures.map((one) => one.name), ['bad'])
})

test('超时与起不来都算这一次没答上来，且说清是什么', async () => {
  const r = await sense({}, {
    parts: [part('slow')],
    deps: deps({ run: { slow: { status: 'timeout', code: null, out: '', err: '', truncated: false, timeout: 5000 } } }),
  })
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.failures, [{ name: 'slow', why: 'slow 超时（超过 5000ms）' }])
})

test('被截断的输出照用，但要留一条 ! 警告', async () => {
  const r = await sense({}, {
    parts: [part('loud')],
    deps: deps({ run: { loud: { status: 'ok', out: '答话', err: '', truncated: true } } }),
  })
  assert.deepEqual(r.lines.map((one) => one.text), ['答话'])
  assert.deepEqual(r.warnings, [`! loud 的输出超过 ${PART_STDOUT_MAX / 1024}KB，已截断`])
})

test('多行输出折成一行：一屏里一个零件只占一行', async () => {
  const r = await sense({}, {
    parts: [part('chatty')],
    deps: deps({ run: { chatty: { status: 'ok', out: '第一行\n\n  第二行  \n', err: '', truncated: false } } }),
  })
  assert.deepEqual(r.lines.map((one) => one.text), ['第一行 第二行'])
})

test('只在 stderr 说了话的零件不进结果，但也不静默', async () => {
  const r = await sense({}, {
    parts: [part('mute')],
    deps: deps({ run: { mute: { status: 'ok', out: '', err: '什么都没有\n', truncated: false } } }),
  })
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.warnings, ['! mute 只在 stderr 说了话，没有结果'])
})
