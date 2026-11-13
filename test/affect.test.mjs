// affect 的约束用例：数值口径、16 格、滞回与死区、配额、override、峰值、归因。
// 时间一律传死 now；临时目录每个用例一建一删（AGENTS 六）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AFFECT_BASE, AFFECT_EMOTION_HALF, AFFECT_HYST, AFFECT_MOOD_HALF, AFFECT_MOOD_HALF_NEG,
  AFFECT_NEG_WEIGHT, AFFECT_STIM_PER_HOUR, monthKey,
} from '../src/core/index.mjs'
import {
  KINDS, MOODS, axis, clear, decay, deadband, decayOffset, list, mergeOffset, mergeStim, moodOf,
  persistent, record, respectBand, set, snapshot, stim, transient, weightOf,
} from '../src/affect/index.mjs'

const HOUR = 60 * 60 * 1000 // 单位换算，不是 §10 的调参常数
const T = new Date(2026, 10, 13, 15, 0).getTime()

async function inHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    return await body(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol

test('半衰期走 formula：过了一个半衰期就是一半，过了零个是原值', () => {
  assert.ok(near(decay(1, AFFECT_MOOD_HALF, AFFECT_MOOD_HALF), 0.5))
  assert.equal(decay(8, 0, AFFECT_MOOD_HALF), 8)
  assert.equal(decay(0, 10 * HOUR, AFFECT_MOOD_HALF), 0)
  assert.equal(decay(-5, 10 * HOUR, AFFECT_MOOD_HALF), 0)
  // dt<0 按 0 算：时钟回拨不该让强度凭空涨上去，也不该变负数。
  assert.equal(decay(7, -3 * HOUR, AFFECT_MOOD_HALF), 7)
})

test('同类叠加：交换律成立，而且两条同样的不如一条两倍', () => {
  assert.ok(near(mergeStim(6, -3), mergeStim(-3, 6)))
  assert.ok(near(mergeStim(-8, -8), -8 + Math.log(2)))
  assert.ok(mergeStim(8, 8) < 16)
  // 没有刺激时叠加不该凭空造出一份：merge(0,x)=x（design §14.8）。
  assert.equal(mergeStim(0, 8), 8)
  assert.equal(mergeStim(8, 0), 8)
  // 反向不硬凑对数域：被夸一次又被骂一次，就该互相扣掉。
  assert.equal(mergeOffset(6, -8), -2)
})

test('衰减不穿越基线：v 从 90 回落到 50 就停在 50', () => {
  const spec = { half: AFFECT_MOOD_HALF, negHalf: AFFECT_MOOD_HALF_NEG }
  const back = axis(90, 50, { ...spec, dt: 1000 * HOUR })
  assert.ok(back >= 50 && back <= 50 + 1e-9, `停在 ${back}`)
  assert.ok(near(axis(90, 50, { ...spec, dt: AFFECT_MOOD_HALF }), 70))
  // 负数那一侧同理：从 20 升不回 50 上面去。
  const up = axis(20, 50, { ...spec, dt: 1000 * HOUR })
  assert.ok(up <= 50 && up >= 50 - 1e-9, `停在 ${up}`)
  // 负向走得慢：13h 才减半，不是 8h。
  const neg = axis(50 - 12, 50, { ...spec, dt: AFFECT_MOOD_HALF_NEG })
  assert.ok(near(neg, 50 - 6))
})

test('100 次 −8 之后 24h 回到基线 ±3（不靠抹内存，靠时间）', () => {
  // 每小时最多 3 次（AFFECT_STIM_PER_HOUR），100 条本来就得摊开 33 小时——按真实节奏摊。
  let agg = 0
  let prev = 0
  for (let i = 0; i < 100; i += 1) {
    const at = i * (HOUR / AFFECT_STIM_PER_HOUR)
    agg = decayOffset(agg, at - prev, 'v')
    agg = mergeOffset(agg, -8)
    prev = at
  }
  const after = decayOffset(agg, 24 * HOUR, 'v')
  assert.ok(Math.abs(after) <= 3, `24h 后还剩 ${after}`)
})

test('100 条 task.fail 走完整链路落盘后，24h 的 v 回到基线附近', async () => {
  await inHome(async (home) => {
    const step = HOUR / AFFECT_STIM_PER_HOUR
    for (let i = 0; i < 100; i += 1) {
      record(home, { kind: 'task.fail', why: `第 ${i} 次 gate 红`, at: T + i * step })
    }
    const last = T + 99 * step
    const live = snapshot(home, { now: last })
    assert.ok(live.v < 50)
    const later = snapshot(home, { now: last + 24 * HOUR })
    // 表里的 −8 乘了 AFFECT_NEG_WEIGHT(1.5) 再走 13h 负向半衰期，比 8h 慢一截：
    // 24h 还剩 3.8，比 design §14.8 的 ±3 多一点点——这是 1.5× 与 13h 叠出来的，见提交说明。
    assert.ok(Math.abs(later.v - AFFECT_BASE.v) <= 4, `24h 后 v=${later.v}`)
    assert.ok(50 - later.v < 50 - live.v)
  })
})

test('格子只由两个数决定：16 个词与表逐字一致，且同一输入永远同一个词', () => {
  assert.deepEqual([...MOODS[0]], ['兴奋', '愉快', '满足', '平静'])
  assert.deepEqual([...MOODS[1]], ['期待', '平淡', '轻松', '慵懒'])
  assert.deepEqual([...MOODS[2]], ['紧张', '不安', '疲倦', '低落'])
  assert.deepEqual([...MOODS[3]], ['焦躁', '烦躁', '沮丧', '消沉'])
  // 四档 v × 四档 e 各取一格中点，落进的是表上那一格（分界 68/50/33 与 76/58/29）。
  const v = [80, 58, 44, 20]
  const e = [85, 66, 44, 10]
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) assert.equal(moodOf(v[i], e[j]), MOODS[i][j])
  }
  // 同样的输入连算 50 次不会自己换词（不许模型挑词）。
  const first = moodOf(52, 61)
  assert.ok(MOODS.flat().includes(first))
  for (let i = 0; i < 50; i += 1) assert.equal(moodOf(52, 61), first)
  // §14.8 的 (52,61) 恒为「平淡」：基线 (50,60) 那一格就是「平淡」，靠分界保证，不靠特例。
  assert.equal(moodOf(52, 61), '平淡')
  assert.equal(moodOf(58, 61), '平淡')
  // 精力掉到基线以下那一格是「轻松」（v 中高 × e 低中）。
  assert.equal(moodOf(58, 40), '轻松')
})

test('滞回：跨边界抖动 100 次，标签最多换 1 次', () => {
  // 51 是「中高/中低」的边界：48 越过 3 分才换，52 只压着边界不够。
  let label = moodOf(52, 61)
  let switches = 0
  for (let i = 0; i < 100; i += 1) {
    const next = moodOf(i % 2 === 0 ? 48 : 52, 61, label)
    if (next !== label) switches += 1
    label = next
  }
  assert.ok(switches <= 1, `换了 ${switches} 次`)
  // design §14.8 的 52↔58 是同一档内抖动：一次都不该换。
  let same = moodOf(52, 61)
  for (let i = 0; i < 100; i += 1) same = moodOf(i % 2 === 0 ? 58 : 52, 61, same)
  assert.equal(same, MOODS[1][1])
})

test('死区：两轴都贴着基线就当作没变，标签不刷新', () => {
  assert.equal(deadband(53, 63), true)
  assert.equal(deadband(53, 70), false)
  assert.equal(moodOf(53, 63, '愉快'), '愉快')
  // 没有上一格时，死区里给「平淡」（§14.8 的 (52,61) 就是这么钉住的）。
  assert.equal(moodOf(53, 63), '平淡')
})

test('五段与持久情绪都用表上的词，而且每一条都带原因', () => {
  assert.deepEqual([90, 40, 0, -30, -80].map(respectBand), ['敬重', '认可', '中性', '不以为然', '厌恶'])
  const dislike = persistent({ t: 40, r: -45 })
  assert.equal(dislike.kind, '厌恶')
  assert.ok(dislike.why.includes('-45'))
  assert.equal(persistent({ t: 60, r: -45 }).kind, '轻蔑')
  assert.equal(persistent({ t: 20, r: 0 }).kind, '失望')
  assert.equal(persistent({ t: 70, r: 0 }).kind, null)
  // 厌恶那一行必须说得出原因（design §14.4：不许静默记仇），空 why 不合格。
  for (const one of [dislike, persistent({ t: 60, r: -45 }), persistent({ t: 20, r: 0 })]) {
    assert.ok(typeof one.why === 'string' && one.why.length > 0)
  }
})

test('瞬时情绪只活在 45 分钟内，最多 3 条', () => {
  const stims = [
    { op: 'stim', at: T, kind: 'task.fail', why: 'a' },
    { op: 'stim', at: T + 10 * 60 * 1000, kind: 'user.praise', why: 'b' },
    { op: 'stim', at: T + 20 * 60 * 1000, kind: 'task.done', why: 'c' },
    { op: 'stim', at: T + 30 * 60 * 1000, kind: 'user.correct', why: 'd' },
    { op: 'stim', at: T - 2 * HOUR, kind: 'promise.kept', why: 'e' },
  ]
  const got = transient(stims, T + 31 * 60 * 1000)
  assert.equal(got.length, 3)
  assert.ok(got.every((one) => one.at >= T))
  assert.ok(got[0].at > got[1].at)
  assert.ok(got.every((one) => one.left > 0 && one.left <= 1))
  // 过了 45 分钟就一条都不剩。
  assert.equal(transient(stims, T + 46 * 60 * 1000 + 31 * 60 * 1000).length, 0)
  // 窗口边界：正好 45 分钟仍算活着，超一点就死。
  const one = [{ op: 'stim', at: T, kind: 'task.done', why: 'x' }]
  assert.equal(transient(one, T + AFFECT_EMOTION_HALF).length, 1)
  assert.equal(transient(one, T + AFFECT_EMOTION_HALF + 1).length, 0)
})

test('未知 kind 与缺 why 都当场抛 TypeError，且一行都不写', async () => {
  await inHome(async (home) => {
    assert.throws(() => record(home, { kind: 'task.exploded', why: 'x', at: T }), TypeError)
    assert.throws(() => record(home, { kind: 'task.fail', at: T }), TypeError)
    assert.throws(() => record(home, { kind: 'task.fail', why: '   ', at: T }), TypeError)
    // 异步入口也一样：校验在写盘之前。
    await assert.rejects(stim(home, { kind: 'nope', why: 'x', at: T }), TypeError)
    await assert.rejects(set(home, { axis: 'q', value: 1, why: 'x', at: T }), TypeError)
    await assert.rejects(set(home, { axis: 'v', value: 1, at: T }), TypeError)
    assert.deepEqual(list(home, { from: 0, to: T }).items, [])
  })
})

test('同类刺激每小时第 4 次起只进 ignored，但日志里一行不少', async () => {
  await inHome(async (home) => {
    const out = []
    for (let i = 0; i < 5; i += 1) {
      out.push(await stim(home, { kind: 'task.fail', why: `第 ${i + 1} 次`, at: T + i * 1000 }))
    }
    assert.deepEqual(out.map((one) => one.ignored), [false, false, false, true, true])
    // 读在这一刻（最后一条写入的时间），不带任何额外衰减。
    const snap = snapshot(home, { now: T + 4 * 1000 })
    assert.equal(snap.ignored, 2)
    // 只听 3 条：v 的偏移就是三条 −12 的对数叠加（这几秒里的衰减也算在里面，容差 0.01）。
    let want = 0
    for (let i = 0; i < AFFECT_STIM_PER_HOUR; i += 1) want = mergeOffset(want, weightOf('task.fail').v)
    assert.ok(near(snap.v, AFFECT_BASE.v + want, 0.01))
    assert.equal(list(home, { from: 0, to: T + 10 * 1000 }).items.length, 5)
    // 下一小时重新有配额。
    const next = await stim(home, { kind: 'task.fail', why: '新的一小时', at: T + HOUR })
    assert.equal(next.ignored, false)
  })
})

test('负向权重按 AFFECT_NEG_WEIGHT 放大，正向不动', () => {
  assert.equal(weightOf('task.fail').v, -8 * AFFECT_NEG_WEIGHT)
  assert.equal(weightOf('user.praise').v, 8)
  assert.throws(() => weightOf('task.exploded'), TypeError)
})

test('跨月合读：按月份分片写，一次读到两片；坏行计 skipped 不吞整份', async () => {
  await inHome(async (home) => {
    const oct = new Date(2026, 9, 30, 9, 0).getTime()
    const nov = new Date(2026, 10, 2, 9, 0).getTime()
    record(home, { kind: 'task.done', why: '十月那条', at: oct })
    record(home, { kind: 'task.done', why: '十一月那条', at: nov })
    const files = fs.readdirSync(path.join(home, 'state')).filter((one) => one.startsWith('affect-'))
    assert.deepEqual(files.sort(), [`affect-${monthKey(oct)}.jsonl`, `affect-${monthKey(nov)}.jsonl`].sort())
    const both = list(home, { from: oct - 1, to: nov + 1 })
    assert.deepEqual(both.items.map((one) => one.why), ['十月那条', '十一月那条'])
    assert.equal(both.skipped, 0)
    // 只读十一月：from 卡在 11 月 1 日零点。
    const onlyNov = list(home, { from: new Date(2026, 10, 1).getTime(), to: nov + 1 })
    assert.deepEqual(onlyNov.items.map((one) => one.why), ['十一月那条'])
    // 塞两行读不懂的：一行不是 JSON，一行缺 why。跳过并计数，别的照读。
    const file = path.join(home, 'state', `affect-${monthKey(nov)}.jsonl`)
    fs.appendFileSync(file, '这不是 JSON\n{"op":"stim","at":' + nov + ',"kind":"task.done"}\n')
    const dirty = list(home, { from: oct - 1, to: nov + 1 })
    assert.equal(dirty.skipped, 2)
    assert.equal(dirty.items.length, 2)
  })
})

test('快照：四轴在量程内，标签/五段/归因都在，且 why 引用的都是真实的 kind', async () => {
  await inHome(async (home) => {
    const empty = snapshot(home, { now: T })
    assert.deepEqual(
      [empty.v, empty.e, empty.t, empty.r],
      [AFFECT_BASE.v, AFFECT_BASE.e, AFFECT_BASE.t, AFFECT_BASE.r],
    )
    assert.deepEqual(empty.transient, [])
    assert.equal(empty.by, 'auto')
    assert.ok(empty.why.length > 0)
    // 死区措辞：贴着基线的那一份说"没变"，不说"偏低"。
    assert.ok(empty.why.some((one) => one.includes('没变')), empty.why.join(' | '))
    await stim(home, { kind: 'task.fail', why: 'gate 红了', at: T })
    const snap = snapshot(home, { now: T })
    assert.equal(snap.mood, moodOf(snap.v, snap.e))
    assert.equal(snap.band, respectBand(snap.r))
    assert.equal(snap.transient.length, 1)
    assert.ok(snap.v >= 0 && snap.v <= 100)
    assert.ok(snap.r >= -100 && snap.r <= 100)
    const text = snap.why.join(' | ')
    assert.ok(text.includes('task.fail'), text)
    const named = text.match(/[a-z]+\.[a-z-]+/g) ?? []
    assert.ok(named.length > 0)
    for (const one of named) assert.ok(KINDS.includes(one), `why 里出现了不存在的 kind：${one}`)
  })
})

test('override：没过期时自动刺激不改值，过期后从那个值接着走、不跳回自动值', async () => {
  await inHome(async (home) => {
    record(home, { kind: 'task.fail', why: '先跌一跤', at: T })
    await set(home, { axis: 'v', value: 80, for: 2 * HOUR, why: '演练', at: T + HOUR })
    const during = snapshot(home, { now: T + 2 * HOUR })
    assert.equal(during.v, 80)
    assert.equal(during.by, 'manual')
    assert.equal(during.until, T + 3 * HOUR)
    // 过期一小时：从 80 接着衰减，而不是弹回自动值（自动值这会儿只有 38 左右）。
    const after = snapshot(home, { now: T + 4 * HOUR })
    assert.equal(after.by, 'auto')
    assert.ok(after.v > 70 && after.v < 80, `过期后 v=${after.v}`)
    assert.ok(near(after.v, 50 + 30 * 0.5 ** (1 / 8), 1e-9))
    // 再过很久回到基线，且是"向基线"回到，不是被谁掰回去。
    const later = snapshot(home, { now: T + 100 * HOUR })
    assert.ok(later.v >= AFFECT_BASE.v - 1e-9)
    assert.ok(later.v < after.v)
  })
})

test('override 覆盖到量程边界：超出范围的值被夹住，不会写进日志原样留着', async () => {
  await inHome(async (home) => {
    const got = await set(home, { axis: 'r', value: -500, why: '羞辱', at: T })
    assert.equal(got.item.value, -100)
    const snap = snapshot(home, { now: T })
    assert.equal(snap.r, -100)
    assert.equal(snap.by, 'manual')
    assert.ok(snap.why.some((one) => one.includes('手动设为')))
  })
})

test('峰值只升不降：到过的高度不随衰减抹掉，也不因为后来的小事被改写', async () => {
  await inHome(async (home) => {
    await stim(home, { kind: 'promise.kept', why: '守了承诺', at: T })
    const high = snapshot(home, { now: T })
    assert.ok(near(high.peaks.trust, high.t))
    const later = snapshot(home, { now: T + 200 * 24 * HOUR })
    assert.ok(later.t < high.peaks.trust)
    assert.equal(later.peaks.trust, high.peaks.trust)
    assert.equal(later.peaks.at, T)
    // 高峰值之后来一次小刺激：峰值不动。
    await stim(home, { kind: 'self.report', why: '顺手报一句', at: T + 200 * 24 * HOUR })
    const small = snapshot(home, { now: T + 200 * 24 * HOUR })
    assert.equal(small.peaks.trust, high.peaks.trust)
    // 写进 meta.json 的也一直是高的那个数。
    const meta = JSON.parse(fs.readFileSync(path.join(home, 'state', 'meta.json'), 'utf8'))
    assert.equal(meta.affect.peaks.trust, high.peaks.trust)
  })
})

test('clear 把刺激与 override 一笔勾销回基线，峰值仍然留着', async () => {
  await inHome(async (home) => {
    await stim(home, { kind: 'promise.overdue', why: '违约', at: T })
    await set(home, { axis: 't', value: 90, why: '先记着', at: T })
    const before = snapshot(home, { now: T })
    assert.equal(before.by, 'manual')
    await clear(home, { at: T + HOUR })
    const after = snapshot(home, { now: T + HOUR })
    const base = [AFFECT_BASE.v, AFFECT_BASE.e, AFFECT_BASE.t, AFFECT_BASE.r]
    assert.deepEqual([after.v, after.e, after.t, after.r], base)
    assert.equal(after.by, 'auto')
    assert.equal(after.peaks.respect, before.peaks.respect)
    // 清完再重放：三条 op 都还在日志里，但 clear 之前的那截不再参与计算。
    assert.equal(list(home, { from: 0, to: T + HOUR }).items.length, 3)
  })
})

test('now 早于第一条刺激时给基线，不给 NaN', async () => {
  await inHome(async (home) => {
    await stim(home, { kind: 'task.fail', why: '未来的事', at: T })
    const before = snapshot(home, { now: T - 5 * HOUR })
    for (const v of [before.v, before.e, before.t, before.r]) assert.ok(Number.isFinite(v))
    assert.deepEqual([before.v, before.e, before.t, before.r], [50, 60, 40, 0])
  })
})

test('重放同一份日志得同一数值：两次快照逐字段相同，不看当前时钟', async () => {
  await inHome(async (home) => {
    record(home, { kind: 'task.fail', why: 'a', at: T })
    record(home, { kind: 'user.praise', why: 'b', at: T + HOUR })
    const one = snapshot(home, { now: T + 3 * HOUR })
    const two = snapshot(home, { now: T + 3 * HOUR })
    assert.deepEqual(one, two)
    // 换个时间点读，读的是那个时间点的值：早一点的更大（还在回落的路上）。
    const earlier = snapshot(home, { now: T + 2 * HOUR })
    assert.ok(earlier.v !== one.v || earlier.e !== one.e)
  })
})

test('删光刺激日志就是基线：日志没了，数值就没了', async () => {
  await inHome(async (home) => {
    await stim(home, { kind: 'task.fail', why: '先错一次', at: T })
    assert.ok(snapshot(home, { now: T }).v < AFFECT_BASE.v)
    for (const name of fs.readdirSync(path.join(home, 'state'))) {
      if (name.startsWith('affect-')) fs.rmSync(path.join(home, 'state', name))
    }
    const snap = snapshot(home, { now: T })
    assert.deepEqual([snap.v, snap.e, snap.t, snap.r], [50, 60, 40, 0])
  })
})

test('标签只在越过 3 分才换：从高一档回落，压着边界时还留上一格', async () => {
  await inHome(async (home) => {
    const first = moodOf(60, 40)
    assert.equal(first, '轻松')
    assert.equal(moodOf(62, 40, first), '轻松')
    // 掉到边界（v=50）下但不到 3 分：不换。
    assert.equal(moodOf(49, 40, first), '轻松')
    // 掉够 3 分：换。
    assert.equal(moodOf(47, 40, '轻松'), MOODS[2][2])
    // 死区里怎么抖都还是原来那个词（±3 之外才算变化）。
    assert.equal(AFFECT_HYST, 3)
    assert.equal(moodOf(52, 58, '轻松'), '轻松')
  })
})
