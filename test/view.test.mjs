import assert from 'node:assert/strict'
import test from 'node:test'

import { item, list, renderDigest, renderScreen } from '../src/view/index.mjs'

// 一律断言整段字符串，不做"包含某词"的探针：这一屏是别人读的字面，
// 多一个空行、少一个缩进都会改掉它读到的东西，includes 锁不住（AGENTS 六）。
// fixture 全是字面量，时间也写成字面量——view 不碰时钟，用例没理由碰。

test('处境屏：段落按「抬头→日程→便条→最弱」排，空段整段不出现', () => {
  const full = renderScreen({
    clock: '2026-11-13 21:40',
    quiet: false,
    since: { text: '3 小时前', fresh: 2 },
    backlog: { unconsolidated: 3, overdue: 1 },
    plans: [
      { text: '陪她看牙', when: '今天 22:00', left: '还有 20 分钟', late: false },
      { text: '洗碗', when: '昨天 21:30', left: '还有 5 分钟', late: true },
    ],
    notes: [{ id: 'n-20261113-01', text: '问她头痛好点没', trigger: '她提到加班' }],
    weakest: [{ id: 'm-20261110-01', text: '她怕冷', r: 0.12, seen: 3 }],
  })
  assert.equal(
    full,
    [
      'agent-man · 2026-11-13 21:40',
      '上次开口：3 小时前（之后 2 条新记忆）',
      '积压：3 条待巩固 · 1 条过期日程',
      '',
      '日程',
      '  今天 22:00 陪她看牙（还有 20 分钟）',
      '  昨天 21:30 洗碗（已经过点了）',
      '',
      '便条',
      '  · 问她头痛好点没（等：她提到加班）',
      '',
      '最弱的三条',
      '  她怕冷 · R=0.12 · 读到过 3 次（m-20261110-01）',
    ].join('\n'),
  )

  // 三段的输入都是空数组：标题、缩进、空行一个都不许留，结尾也不能多空一行。
  const bare = renderScreen({
    clock: '2026-11-13 21:40',
    quiet: false,
    since: { text: '1 小时前', fresh: 0 },
    backlog: { unconsolidated: 0, overdue: 0 },
    plans: [],
    notes: [],
    weakest: [],
  })
  assert.equal(bare, ['agent-man · 2026-11-13 21:40', '上次开口：1 小时前'].join('\n'))
})

test('静默时段：第二行换成 ! 提示，压着的事照旧显示', () => {
  const text = renderScreen({
    clock: '2026-11-13 23:40',
    quiet: true,
    since: { text: '3 小时前', fresh: 2 },
    backlog: { unconsolidated: 1, overdue: 0 },
    plans: [],
    notes: [{ id: 'n-20261113-02', text: '问她头痛好点没', trigger: '她提到加班' }],
    weakest: [],
  })
  assert.equal(
    text,
    [
      'agent-man · 2026-11-13 23:40',
      '! 夜深了，除非她先开口，不然不主动说',
      '积压：1 条待巩固',
      '',
      '便条',
      '  · 问她头痛好点没（等：她提到加班）',
    ].join('\n'),
  )
})

test('从没开过口：写「还没开过口」，不写 null，也不省掉这一行', () => {
  const text = renderScreen({
    clock: '2026-11-13 09:05',
    quiet: false,
    since: null,
    backlog: { unconsolidated: 0, overdue: 0 },
    plans: [],
    notes: [],
    weakest: [],
  })
  assert.equal(text, ['agent-man · 2026-11-13 09:05', '上次开口：还没开过口'].join('\n'))
  assert.equal(/null|undefined/.test(text), false, `漏了占位符：${text}`)
})

test('过点的日程在括号里写「已经过点了」，不再摆倒计时', () => {
  const text = renderScreen({
    clock: '2026-11-13 22:05',
    quiet: false,
    since: { text: '10 分钟前', fresh: 1 },
    backlog: { unconsolidated: 0, overdue: 1 },
    plans: [
      { text: '陪她看牙', when: '今天 22:00', left: '还有 20 分钟', late: true },
      { text: '交房租', when: '明天 09:00', left: '还有 11 小时', late: false },
    ],
    notes: [],
    weakest: [],
  })
  assert.equal(
    text,
    [
      'agent-man · 2026-11-13 22:05',
      '上次开口：10 分钟前（之后 1 条新记忆）',
      '积压：1 条过期日程',
      '',
      '日程',
      '  今天 22:00 陪她看牙（已经过点了）',
      '  明天 09:00 交房租（还有 11 小时）',
    ].join('\n'),
  )
})

test('摘要页脚：丢条时列出条数与原因，没丢东西时直说「没丢东西」', () => {
  const body = '她怕冷：上周关窗那次她没穿外套'

  const withDrops = renderDigest({
    header: 'digest',
    body,
    stats: {
      used: 1087,
      budget: 1200,
      kept: ['m-20261113-01', 'e-20261113-02'],
      dropped: [
        { id: 'e-20261112-04', reason: 'budget' },
        { id: 'e-20261112-05', reason: 'budget' },
      ],
    },
  })
  assert.equal(
    withDrops,
    ['digest', '', body, '', '—— 用了 1087/1200 · 装下 2 条 · 丢 2 条（budget）'].join('\n'),
  )

  // 一条没丢也必须说出口：页脚只在丢条时出现，等于"没丢"和"没算"分不清。
  const clean = renderDigest({
    header: 'digest',
    body,
    stats: { used: 900, budget: 1200, kept: 2, dropped: [] },
  })
  assert.equal(clean, ['digest', '', body, '', '—— 用了 900/1200 · 装下 2 条 · 没丢东西'].join('\n'))
})

test('摘要正文为空：写「（今天没什么可巩固的）」，不留空段', () => {
  const text = renderDigest({
    header: 'digest',
    body: '',
    stats: { used: 0, budget: 1200, kept: [], dropped: [] },
  })
  assert.equal(
    text,
    ['digest', '', '（今天没什么可巩固的）', '', '—— 用了 0/1200 · 装下 0 条 · 没丢东西'].join('\n'),
  )
})

test('页脚 cost 最多一位小数：加出来的噪声不上屏', () => {
  const text = renderDigest({
    header: 'digest',
    body: '她怕冷：上周关窗那次她没穿外套',
    stats: { used: 97.0800000000001, budget: 1200.0000000000002, kept: 1, dropped: [] },
  })
  assert.equal(
    text,
    ['digest', '', '她怕冷：上周关窗那次她没穿外套', '', '—— 用了 97.1/1200 · 装下 1 条 · 没丢东西'].join(
      '\n',
    ),
  )
  // 整数不补零：1087 就是 1087，不是 1087.0（读数不是小数位表格）。
  const whole = renderDigest({
    header: 'digest',
    body: '她怕冷',
    stats: { used: 1087, budget: 1200, kept: 1, dropped: [] },
  })
  assert.equal(whole, ['digest', '', '她怕冷', '', '—— 用了 1087/1200 · 装下 1 条 · 没丢东西'].join('\n'))
})

test('records：memory 行带 [key]、rule 行带 !，便条带「等：触发」，空表写「（空）」', () => {
  assert.equal(
    list([{ id: 'm-20261113-01', when: '2026-11-13 21:32', text: '她关窗是因为冷', key: '她怕冷' }], 'memory'),
    'm-20261113-01  2026-11-13 21:32  她关窗是因为冷 [她怕冷]',
  )
  assert.equal(
    item({ id: 'r-20261113-01', when: '2026-11-13 21:32', text: '夜里十一点后不提工作' }, 'rule'),
    'r-20261113-01  2026-11-13 21:32  ! 夜里十一点后不提工作',
  )
  assert.equal(
    list([{ id: 'n-20261113-01', when: '2026-11-13 21:32', text: '问她头痛好点没', trigger: '她提到加班' }], 'note'),
    'n-20261113-01  2026-11-13 21:32  问她头痛好点没（等：她提到加班）',
  )
  // 空表不返回空字符串：那会被当成渲染坏了。
  assert.equal(list([], 'event'), '（空）')
})

test('records：多行按入参顺序逐行排；不认识的类别当场报错，不退回成普通行', () => {
  const text = list(
    [
      { id: 'e-20261113-01', when: '2026-11-13 21:32', text: '她关了窗' },
      { id: 'e-20261113-02', when: '2026-11-13 21:40', text: '她给自己倒了热水' },
    ],
    'event',
  )
  assert.equal(
    text,
    [
      'e-20261113-01  2026-11-13 21:32  她关了窗',
      'e-20261113-02  2026-11-13 21:40  她给自己倒了热水',
    ].join('\n'),
  )

  // 日程与事件同一套三列，只是正文不带记号：时间写在行首，正文不重复。
  assert.equal(
    item({ id: 'p-20261113-01', when: '今天 22:00', text: '陪她看牙' }, 'plan'),
    'p-20261113-01  今天 22:00  陪她看牙',
  )

  assert.throws(() => list([{ id: 'x-1', when: '今天', text: '?' }], 'diary'), /不认识的类别/)
})
