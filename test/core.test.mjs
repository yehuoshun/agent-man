import assert from 'node:assert/strict'
import test from 'node:test'

import { clock, cost, cut, dayKey, jaccard, oneLine, parseWhen, rel, tokens } from '../src/core/index.mjs'

// 成本是浮点累加（0.28 不是二进制精确数），比较一律给容差；
// 断言"不超预算"时必须真跑 cost()，不能只信 cut() 返回的布尔（AGENTS 六）。
function near(actual, expected) {
  return Math.abs(actual - expected) < 1e-9
}

test('半角按 0.28 计、全角与 emoji 按 1 计：混排时不能把汉字当半个', () => {
  assert.ok(near(cost('abc'), 0.84), `三个半角是 0.84，实际 ${cost('abc')}`)
  assert.equal(cost('中文'), 2)
  // emoji 是代理对，字符串长度 2、成本必须是 1：按 UTF-16 单元算会凭空翻倍。
  assert.equal('🙂'.length, 2)
  assert.equal(cost('🙂'), 1)
  assert.equal(cost('中文🙂'), 3)
  assert.equal(cost(''), 0)
})

test('预算够时原样返回，不动刀', () => {
  const r = cut('她关了窗。', 10)
  assert.equal(r.text, '她关了窗。')
  assert.equal(r.cut, false)
})

test('放不下时先切在句末，而不是切在半句话上', () => {
  // 预算 6 只装得下"她关了窗。然"，句末在预算内且是最靠后的边界。
  const r = cut('她关了窗。然后去睡了，很久很久。', 6)
  assert.equal(r.text, '她关了窗。')
  assert.equal(r.cut, true)
})

test('句末之后还有逗号时切在更靠后的逗号：不为了句号白扔一半预算', () => {
  const r = cut('她关了窗。然后去睡了，很久很久。', 11)
  assert.equal(r.text, '她关了窗。然后去睡了，')
  assert.equal(r.cut, true)
})

test('一个标点都没有就硬切，且切完真的没超预算', () => {
  const text = '她关了窗然后去睡了很久很久才回来'
  for (const budget of [0, 1, 5, 8.5, 15]) {
    const r = cut(text, budget)
    assert.equal(r.cut, true)
    assert.ok(cost(r.text) <= budget, `budget=${budget} 切出 ${cost(r.text)}：超了就是超了`)
    assert.ok(text.startsWith(r.text), '切出来的必须是原文前缀，不能是重新拼的句子')
  }
  assert.equal(cut(text, 0).text, '')
  assert.equal(cut(text, 16).cut, false, '刚好装得下也算放得下')
})

test('换行折成空格；超长截断并补省略号，结果不超 max', () => {
  assert.equal(oneLine('她关了窗\n然后去睡了', 20), '她关了窗 然后去睡了')
  assert.equal(oneLine('a\r\nb', 10), 'a b')
  const long = oneLine('她把窗户关上了', 4)
  assert.equal(long, '她把窗…')
  assert.equal(Array.from(long).length, 4)
  assert.equal(oneLine('短', 10), '短')
})

test('dayStart=4 时凌晨 3 点算前一天，4 点才算当天', () => {
  const three = new Date(2026, 10, 13, 3, 0).getTime()
  const four = new Date(2026, 10, 13, 4, 0).getTime()
  assert.equal(dayKey(three, { dayStart: 4 }), '2026-11-12')
  assert.equal(dayKey(four, { dayStart: 4 }), '2026-11-13')
  // 默认日界是零点：同一个凌晨 3 点就是 13 号。
  assert.equal(dayKey(three), '2026-11-13')
  assert.equal(dayKey(new Date(2026, 0, 1, 23, 59).getTime()), '2026-01-01')
})

test('跨过半夜要先判日历日：说"昨天 22:10"，绝不出现"27 小时前"', () => {
  const nowAt = new Date(2026, 10, 13, 1, 40).getTime()
  const lastNight = new Date(2026, 10, 12, 22, 10).getTime()
  const said = rel(lastNight, nowAt)
  assert.equal(said, '昨天 22:10')
  assert.equal(/小时前/.test(said), false, `跨天不该报小时数，拿到 ${said}`)

  // 27 小时这种最刺眼的数：越过两次半天边界也只能说昨天。
  const late = new Date(2026, 10, 13, 23, 0).getTime()
  const old = new Date(2026, 10, 12, 20, 0).getTime()
  assert.equal(rel(old, late), '昨天 20:00')
})

test('同一天内按分钟、小时递进；不到一分钟说"刚刚"', () => {
  const nowAt = new Date(2026, 10, 13, 15, 0).getTime()
  assert.equal(rel(nowAt - 30 * 1000, nowAt), '刚刚')
  assert.equal(rel(nowAt - 12 * 60 * 1000, nowAt), '12 分钟前')
  assert.equal(rel(nowAt - 3 * 3600 * 1000, nowAt), '3 小时前')
})

test('超过 30 天报日期，30 天以内还数天数', () => {
  const nowAt = new Date(2026, 10, 13, 15, 0).getTime()
  assert.equal(rel(nowAt - 3 * 86400000, nowAt), '3 天前')
  assert.equal(rel(nowAt - 31 * 86400000, nowAt), '2026-10-13')
  assert.equal(clock(new Date(2026, 10, 13, 22, 10).getTime()), '22:10')
})

test('未来的点给钟点，不说"负 3 小时前"', () => {
  const nowAt = new Date(2026, 10, 13, 15, 0).getTime()
  assert.equal(rel(nowAt + 3 * 3600 * 1000, nowAt), '18:00')
  assert.equal(rel(new Date(2026, 10, 14, 9, 0).getTime(), nowAt), '明天 09:00')
})

test('各种写法都能一次解释成 epoch ms（本地时间，不写死时区）', () => {
  const nowAt = new Date(2026, 10, 13, 1, 40).getTime()
  assert.equal(parseWhen('2026-11-13 21:40', nowAt), new Date(2026, 10, 13, 21, 40).getTime())
  assert.equal(parseWhen('2026-11-13', nowAt), new Date(2026, 10, 13, 0, 0).getTime())
  // 只给钟点就是"今天的这个点"，即使已经过去——过期要不要说，是上层的事。
  assert.equal(parseWhen('21:40', nowAt), new Date(2026, 10, 13, 21, 40).getTime())
  assert.equal(parseWhen('明天 9:00', nowAt), new Date(2026, 10, 14, 9, 0).getTime())
  assert.equal(parseWhen('后天 9:00', nowAt), new Date(2026, 10, 15, 9, 0).getTime())
  assert.equal(parseWhen('明天', nowAt), new Date(2026, 10, 14, 0, 0).getTime())
  assert.equal(parseWhen('3d', nowAt), nowAt + 3 * 86400000)
  assert.equal(parseWhen('12h', nowAt), nowAt + 12 * 3600000)
  assert.equal(parseWhen('30m', nowAt), nowAt + 30 * 60000)
})

test('解析不了返回 null 而不抛：调用方要能把它变成"退出码 2 + 怎么改"', () => {
  const nowAt = new Date(2026, 10, 13, 1, 40).getTime()
  for (const bad of ['昨晚', '明天下午', '', '   ', '2026-02-30', '2026-13-01', '25:00', '3w', null, undefined, 42]) {
    assert.equal(parseWhen(bad, nowAt), null, `${String(bad)} 不该被解析出时间`)
  }
})

test('中文按二元组、英文按词，停用字不留在结果里', () => {
  assert.deepEqual(tokens('她关了窗户'), ['她关', '关了', '了窗', '窗户'])
  assert.deepEqual(tokens('The clock is broken'), ['clock', 'broken'])
  // 全是停用字就等于没有线索：与其给个"假的有"，不如给空。
  assert.deepEqual(tokens('的'), [])
  assert.deepEqual(tokens('，。！'), [])
})

test('同义改写查不到是设计选择，不是等待修复的 bug', () => {
  // 没有嵌入，只有"字面线索"（design §2 诚实放弃）：两句话意思一样、用字不同，
  // Jaccard 就是 0。这条用例存在的意义是把这个行为钉住——
  // 哪天有人"顺手加个同义词表"，先看到这条用例，再决定要不要改设计。
  assert.equal(jaccard('她把窗户关了', '窗子关上了'), 0)
  // 用字相同就一定查得到，这才是这套检索真正承诺的东西。
  assert.equal(jaccard('夜里十一点后不提工作', '夜里十一点后不提工作'), 1)
})

test('两边都空时相似度为 0：给 1 会让空记录排到最前', () => {
  assert.equal(jaccard('', ''), 0)
  assert.equal(jaccard([], []), 0)
  assert.equal(jaccard('关了窗', ''), 0)
  assert.ok(near(jaccard(['关了'], ['关了', '窗户']), 1 / 2))
})
