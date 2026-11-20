import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { sense } from '../src/parts/index.mjs'
import { cost, LINE_OVERHEAD, PART_STDOUT_MAX } from '../src/core/index.mjs'

const part = (name) => ({ name, file: `C:/fake/agent-man-${name}` })

// 默认让每个零件都"正常答话"：describe 报契约五字段，capture 回一行。
function deps({ desc = {}, run = {} } = {}) {
  return {
    scan: () => [],
    describe: async (p) => desc[p.name] ?? {
      ok: true, name: p.name, desc: '', section: '环境', timeout_ms: 1000, side_effects: false,
    },
    capture: async (p) => run[p.name] ?? {
      status: 'ok', code: 0, out: `${p.name} 答话`, err: '', truncated: false,
    },
  }
}

test('零件按预算装，装不下的进 dropped 并写明是预算', async () => {
  const wide = '很'.repeat(200) // 200 cost，一行就够撑爆一个小预算
  const depsOf = deps({ run: { a: { status: 'ok', out: wide, err: '', truncated: false } } })
  const r = await sense({}, { budget: 100, parts: [part('a'), part('b')], deps: depsOf })
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
    deps: deps({
      run: { slow: { status: 'timeout', code: null, out: '', err: '', truncated: false, timeout: 5000 } },
    }),
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

// 下面几条锁的是"给了 deadline"这条路：注入那一侧唯一的时延保险，坏了就是首步被拖死。

// 并行只改"谁先回答"，不改"谁排前面"：次序只认零件的顺序，
// 否则同一组零件两次注入能排出两个样子，就没法商量预算花在谁身上。
test('给了 deadline 就并行问，输出顺序仍是零件的顺序', async () => {
  const descWaits = []
  let inFlight = 0
  let peak = 0
  const slow = {
    describe: async (p, o) => {
      descWaits.push(o.timeout)
      return { ok: true, name: p.name, desc: '', section: '环境', timeout_ms: 1000, side_effects: false }
    },
    capture: async (p) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(p.name === 'a' ? 30 : 1) // 靠前的答得慢：串行就会把它排第一，并行才看得出差别
      inFlight -= 1
      return { status: 'ok', code: 0, out: `${p.name} 答话`, err: '', truncated: false }
    },
  }
  const r = await sense({}, { parts: [part('a'), part('b')], deps: slow, deadline: 500 })
  assert.equal(peak, 2, '给了 deadline 应当并行问，不是一个一个等')
  assert.deepEqual(r.lines.map((one) => one.name), ['a', 'b'])
  assert.deepEqual(r.dropped, [])
  // --describe 也吃同一个期限：不许拿零件声明的 5s 去撞总的 500ms。
  assert.ok(descWaits.every((ms) => ms > 0 && ms <= 500), `describe 拿到 ${descWaits.join('/')}`)
})

test('不给 deadline 时仍然串行，顺序就是传进来的顺序', async () => {
  const descKeys = []
  let inFlight = 0
  let peak = 0
  const single = {
    describe: async (p, o) => {
      descKeys.push(Object.keys(o).join(','))
      return { ok: true, name: p.name, desc: '', section: '环境', timeout_ms: 1000, side_effects: false }
    },
    capture: async (p) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight -= 1
      return { status: 'ok', code: 0, out: `${p.name} 答话`, err: '', truncated: false }
    },
  }
  const r = await sense({}, { parts: [part('a'), part('b'), part('c')], deps: single })
  assert.equal(peak, 1, '不给 deadline 就该一个一个问（CLI 那一屏的老行为）')
  assert.deepEqual(r.lines.map((line) => line.name), ['a', 'b', 'c'])
  assert.deepEqual(descKeys, ['env', 'env', 'env'], '串行时 describe 只传 env，不带 timeout')
})

test('到 deadline 没答上来的零件记 deadline 并说出来，已答上来的照收', async () => {
  const waits = []
  const slow = {
    describe: async (p) => ({
      ok: true, name: p.name, desc: '', section: '环境', timeout_ms: 60000, side_effects: false,
    }),
    capture: async (p, o) => {
      waits.push({ name: p.name, timeout: o.timeout })
      if (p.name === 'slow') {
        // 契约是骨架到点硬杀，所以"给多少时间就睡多久（再多一点）"就是最坏情况。
        // 那个"再多一点"是必须的：睡到恰好 o.timeout 等于和 deadline 的计时器同毫秒赛跑，
        // 谁先到取决于事件循环里先排谁——CI 上实测睡赢过，慢零件"答上话了"，dropped 于是是空数组
        // （run #73，windows-latest node 24，断言在 sense.test.mjs:155）。多睡一点点，胜负就只由
        // "我们等没等"决定，不再由定时器排序决定。
        await sleep(o.timeout + 150)
        return { status: 'timeout', code: null, out: '', err: '', truncated: false, timeout: o.timeout }
      }
      return { status: 'ok', code: 0, out: '快的答话', err: '', truncated: false }
    },
  }
  const t0 = performance.now()
  const r = await sense({}, { parts: [part('slow'), part('fast')], deps: slow, deadline: 60 })
  const waited = performance.now() - t0
  // 上界不是"贴着 60ms"：假 capture 自己要睡 o.timeout + 150，总额就该落在 deadline + 那 150 附近。
  // 留 1 秒余量是给排队的（CI 上 `node --test` 一个进程里并行跑好几个文件）；真正要证明的是
  // "没等满零件声明的 60s"，不是"这台机器有多快"。
  assert.ok(waited < 1000, `总等待 ${Math.round(waited)}ms 没有收在 deadline 附近`)
  // 传给 capture 的是"剩余时间"：既不许是零件声明的 60s，也不许是短到不算数。
  const got = waits.find((one) => one.name === 'slow')
  assert.ok(got.timeout > 0 && got.timeout <= 60, `capture 拿到的 timeout 是 ${got.timeout}`)
  assert.deepEqual(r.lines.map((one) => one.name), ['fast'])
  assert.deepEqual(r.dropped, [{ name: 'slow', reason: 'deadline' }])
  assert.deepEqual(r.failures, [], '期限用完是我们没等，不该记进"零件不行"')
  assert.match(r.warnings.join('\n'), /! slow 到 60ms 的期限还没答上来/)
})

// 0 是"一个都不等"，不是"不设上限"：后一种读法会让改小配置反而更慢，
// 正是这次要拆掉的那个坑。
test('deadline 为 0 表示一个零件都不等，全记 deadline', async () => {
  const r = await sense({}, { parts: [part('a')], deps: deps(), deadline: 0 })
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.dropped, [{ name: 'a', reason: 'deadline' }])
  assert.match(r.warnings.join('\n'), /! a 到 0ms 的期限还没答上来/)
})
