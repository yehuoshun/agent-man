import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SECTION_ITEMS_MAX, cost } from '../src/core/index.mjs'
import { trace as auditTrace } from '../src/audit/index.mjs'
import { build, run } from '../src/digest/index.mjs'
import { add, show } from '../src/memory/index.mjs'
import { appendJsonl, ensure, eventsFile, readJsonl, stateFile } from '../src/store/index.mjs'
import { renderDigest } from '../src/view/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 24 * 60 * 60 * 1000
// 时间一律传死（AGENTS 六）：本地时间构造，纽约时区的 CI 腿也算同一个时刻。
const NOW = new Date(2026, 10, 13, 21, 40, 0).getTime()
const QUIET = { say: () => {}, warn: () => {} }

const HOMES = []

function newHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  return dir
}

function seedEvent(home, { id, at = NOW, text = '把 recall 的 fit 跑通了' }) {
  ensure(home)
  appendJsonl(eventsFile(home, at), { id, at, text, src: { origin: 'user' } })
  return id
}

// 结论只能靠 memory 门面写：它负责发号、收口、证据解析，测试里不走捷径。
function seedFact(home, opts = {}) {
  const { key = 'recall.fit', text = 'fit 先保底再回填，贪心会把必放项挤掉', imp = 2 } = opts
  const { ids = ['e1'], at = NOW } = opts
  return add({ key, fact: text, imp, at, evidence: { ids } }, { home, now: NOW })
}

function memoryFile(home) {
  return path.join(home, 'memory.jsonl')
}

function text(file) {
  return fs.readFileSync(file, 'utf8')
}

function rows(file) {
  return text(file).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

test('预算不可协商：任何预算下 used 都不超预算，而且 used 是按字实算不是估的', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  seedEvent(home, { id: 'e2', at: NOW - 3600 * 1000, text: '读了 store 的分片命名' })
  await seedFact(home, { ids: ['e1'] })

  for (const budget of [0, 10, 40, 85, 200, 1200, 100000]) {
    const got = build({ home, now: NOW, budget })
    assert.ok(got.cost <= budget, `预算 ${budget} 却用了 ${got.cost}`)
    const assembled = [got.header, got.body].filter((part) => part !== '').join('\n\n')
    assert.equal(got.cost, cost(assembled), `预算 ${budget} 的 cost 跟那屏字对不上：用了估的数`)
    assert.equal(got.header === '', got.headerKind === 'none', '抬头形态与其文本对不上')
  }
})

test('抬头让位给条目：满抬头装不下第二条时，头降级而不是把条目挤掉', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  seedEvent(home, { id: 'e2', at: NOW - 3600 * 1000, text: '记下 digest 要落一行账' })
  await seedFact(home, { ids: ['e1'] })

  const rich = build({ home, now: NOW })
  assert.equal(rich.headerKind, 'full', '预算充裕时该给最全的抬头')
  const fullCost = cost(rich.header)
  const rowCost = rich.kept[rich.kept.length - 1].cost
  const budget = Math.ceil(fullCost + rowCost) - 1

  const tight = build({ home, now: NOW, budget })
  assert.ok(fullCost + rowCost > budget, '前提不成立：这个预算本来装得下满抬头加一条')
  assert.notEqual(tight.headerKind, 'full', '抬头没让位：花边换掉了内容')
  assert.ok(tight.kept.length >= 1, '降级之后一条都没留住，那降级就没意义')
  assert.ok(tight.cost <= budget, `降级后仍然超预算：${tight.cost} > ${budget}`)
})

test('抬头让位之后：拿 cost() 复核抬头+正文的总 cost，≤ budget 且与报出来的一致', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  seedEvent(home, { id: 'e2', at: NOW - 3600 * 1000, text: '记下 digest 要落一行账' })
  await seedFact(home, { ids: ['e1'] })

  const rich = build({ home, now: NOW })
  const fullCost = cost(rich.header)
  const rowCost = rich.kept[rich.kept.length - 1].cost
  // 从"满抬头加一条就差一点"往下退 20 个刻度：每一档都自己数一遍字，
  // 不能只信 build 报的布尔——预算这件事的真相只在 cost() 手里（AGENTS 六）。
  const top = Math.ceil(fullCost + rowCost) - 1
  let surrendered = 0
  for (let budget = top; budget > top - 20; budget -= 1) {
    const got = build({ home, now: NOW, budget })
    const total = cost([got.header, got.body].filter((part) => part !== '').join('\n\n'))
    assert.equal(got.cost, total, `预算 ${budget}：报出来的 cost 与抬头+正文对不上`)
    assert.ok(total <= budget, `预算 ${budget}：抬头让位后仍然超了 ${total} > ${budget}`)
    if (got.headerKind !== 'full') surrendered += 1
    // 让位可以丢条目，但不能丢了理由：账本与屏上都靠它（AGENTS 二·2）。
    for (const entry of got.dropped) assert.ok(entry.reason, `预算 ${budget}：丢了一条却没写原因`)
  }
  assert.ok(surrendered > 0, '这 20 档一次抬头都没让，用例没验到"让位"')
})

test('build 是读命令：连跑两次 memory.jsonl 一字节不动，seen 也不涨', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  const fact = await seedFact(home, { ids: ['e1'] })
  const before = text(memoryFile(home))

  const first = build({ home, now: NOW })
  const second = build({ home, now: NOW })

  assert.deepEqual(second.kept, first.kept)
  assert.equal(text(memoryFile(home)), before, 'build 摸过盘了')
  assert.equal(show(fact.id, { home, now: NOW }).record.seen, 0, 'build 顺手把 seen 抬了')
})

test('seen 只加在选进摘要的结论上：连跑两次涨两次，旧行只追加不改写，情景不动', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1', text: '写完了 digest 的选段' })
  const fact = await seedFact(home, { ids: ['e1'], text: '选段先排序再装，装不下才丢' })
  const factsBefore = text(memoryFile(home))
  const eventsBefore = text(eventsFile(home, NOW))

  await run({ home, now: NOW, render: renderDigest, ...QUIET })
  assert.equal(show(fact.id, { home, now: NOW }).record.seen, 1)
  await run({ home, now: NOW, render: renderDigest, ...QUIET })
  assert.equal(show(fact.id, { home, now: NOW }).record.seen, 2)

  const factsAfter = text(memoryFile(home))
  assert.ok(factsAfter.startsWith(factsBefore), '旧行被改写了：memory.jsonl 只准追加')
  assert.ok(factsAfter.length > factsBefore.length, 'seen 涨了却没有新行：账对不上')
  assert.equal(text(eventsFile(home, NOW)), eventsBefore, '情景记录被动了：情景不记复述')
})

test('装不进摘要的结论不记复述：没在屏上出现过就不算说过一次', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  const kept = await seedFact(home, { key: 'k1', ids: ['e1'], text: '短' })
  const long = await seedFact(home, {
    key: 'k2',
    ids: ['e1'],
    text: '这一条特别长，长到一个小预算绝对装不下，它必须被明确地丢掉并写清理由，而不是被悄悄截断成半句',
  })

  const got = build({ home, now: NOW, budget: 60 })
  assert.deepEqual(got.retell, got.retell.filter((id) => got.kept.some((row) => row.id === id)))
  const survived = got.retell.includes(kept.id)
  const buried = got.retell.includes(long.id)
  assert.notEqual(survived, buried, `预算 60 下应当一留一丢，实际：${got.retell.join('、')}`)

  await run({ home, now: NOW, budget: 60, render: renderDigest, ...QUIET })
  const untouched = survived ? long : kept
  assert.equal(show(untouched.id, { home, now: NOW }).record.seen, 0, '没上屏的结论被记了一次复述')
})

test('dry-run 一次盘都不摸：seen 不涨、账本不写、out 不动', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  const fact = await seedFact(home, { ids: ['e1'] })
  const before = text(memoryFile(home))
  const out = path.join(home, 'digest.md')

  const got = await run({ home, now: NOW, render: renderDigest, write: false, out, ...QUIET })

  assert.equal(got.wrote, false)
  assert.equal(text(memoryFile(home)), before, 'dry-run 动了记忆')
  assert.equal(fs.existsSync(out), false, 'dry-run 写了 out：预览让人以为已经落了一份')
  assert.equal(fs.existsSync(stateFile(home, 'trace', NOW)), false, 'dry-run 写了账本')
  assert.ok(got.warnings.some((line) => line.startsWith('! ') && line.includes('dry-run')))
  // 摘要本身还是要给出来：dry-run 只是不落，不是不算。
  assert.ok(got.text.includes(fact.id === '' ? '' : '- '), 'dry-run 什么都没算出来')
})

test('账本一次一行：kept 全是 id，dropped 每条带人话理由，去掉一个 id 就少一行账', async () => {
  const home = newHome()
  for (let i = 1; i <= 6; i += 1) {
    seedEvent(home, { id: `e${i}`, at: NOW - i * 60 * 1000, text: `第 ${i} 条：把第 ${i} 块拼上` })
  }
  await seedFact(home, { ids: ['e1'] })

  const got = await run({ home, now: NOW, budget: 150, render: renderDigest, ...QUIET })
  const ledger = readJsonl(stateFile(home, 'trace', NOW))
  assert.equal(ledger.bad, 0)
  assert.equal(ledger.items.length, 1, '跑一次只准留一行账')

  const line = ledger.items[0]
  assert.equal(line.at, NOW)
  assert.equal(line.budget, 150)
  assert.equal(line.header, got.built.headerKind, '账本记的抬头形态与屏上的不是同一个')
  assert.ok(line.kept.every((id) => typeof id === 'string' && id !== ''), '账本里有空的 kept')
  assert.ok(line.dropped.length > 0, '这个预算该丢东西，否则这条用例什么都没锁住')
  for (const entry of line.dropped) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '', '账本里有没名字的丢弃')
    assert.match(entry.reason, /[\u4e00-\u9fa5]/, `账本里写的是上游的码而不是理由：${entry.reason}`)
  }
})

test('脏行跟着计数一起报出来：坏一行不丢整份记忆，但要有一句 ! ', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1', text: '好行还在' })
  fs.appendFileSync(eventsFile(home, NOW), '{"id":"half",\n', 'utf8')

  const got = build({ home, now: NOW })
  assert.equal(got.skipped, 1, '坏行没计数')
  const bad = got.warnings.filter((line) => line.startsWith('! ') && line.includes('1 行'))
  assert.equal(bad.length, 1, got.warnings.join(' | '))
  assert.equal(got.kept.length, 1, '一行坏掉就把整份记忆丢了')
})

test('窗口只认 30 天：40 天前的结论与情景都不进这一屏', async () => {
  const home = newHome()
  const old = NOW - 40 * DAY
  seedEvent(home, { id: 'e-old', at: old, text: '上个月把 recall 写完了' })
  seedEvent(home, { id: 'e-new', at: NOW - 1000, text: '今天收尾 digest' })
  await seedFact(home, { key: 'k-old', ids: ['e-old'], at: old, text: '四十天前的结论' })

  const got = build({ home, now: NOW })
  assert.deepEqual(got.candidates, { memory: 0, event: 1 }, '窗口外的记录被选进来了')
  assert.ok(got.kept.every((row) => row.id !== 'e-old'))
})

test('同 id 多行只算一条：收口是追加副本，直接读文件会把一份记忆读成几份', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  const first = await seedFact(home, { key: 'k', ids: ['e1'], text: '先写 append 再写 assertLanded' })
  const second = await seedFact(home, { key: 'k', ids: ['e1'], text: '写完必须读回自己那一行' })

  // 三行：旧版本、旧版本的收口副本、新版本。旧行逐字不动（AGENTS 五）。
  assert.equal(rows(memoryFile(home)).length, 3, '收口应当追加而不是改写')
  const got = build({ home, now: NOW })
  assert.equal(got.candidates.memory, 1, '一条记忆被读成了几条')
  assert.deepEqual(got.retell, [second.id], `复述该记在活的那一版上，实际：${got.retell.join('、')}`)
  assert.ok(!got.retell.includes(first.id), '失效版本也被记了复述')
})

test('每段有条数上限：多出来的带"每段最多 N 条"的理由掉出去，不静默截掉', async () => {
  const home = newHome()
  for (let i = 1; i <= SECTION_ITEMS_MAX + 2; i += 1) {
    seedEvent(home, { id: `e${i}`, at: NOW - i * 60 * 1000, text: `第 ${i} 条情景` })
  }

  const got = build({ home, now: NOW })
  const section = got.sections.find((entry) => entry.name === '最近')
  assert.equal(section.items.length, SECTION_ITEMS_MAX, `一段装了 ${section.items.length} 条，超过上限`)
  const limited = got.dropped.filter((entry) => entry.code === 'limit')
  assert.equal(limited.length, 2, '超上限的两条没有进 dropped')
  for (const entry of limited) {
    assert.equal(entry.reason, `每段最多 ${SECTION_ITEMS_MAX} 条`)
    assert.ok(entry.why.startsWith('丢：'), '丢弃理由不是一句完整的话')
  }
})

test('最弱三条按 R 升序，每条都写清下场：进了摘要，或因为什么没进', async () => {
  const home = newHome()
  for (let i = 1; i <= 5; i += 1) {
    seedEvent(home, { id: `e${i}`, at: NOW - i * DAY, text: `第 ${i} 天的情景` })
  }

  const got = build({ home, now: NOW, budget: 120 })
  assert.equal(got.weakest.length, 3)
  const scores = got.weakest.map((entry) => entry.R)
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b), '最弱三条没有按 R 升序')
  for (const entry of got.weakest) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '')
    assert.ok(Number.isFinite(entry.R))
    if (entry.kept) assert.equal(entry.reason, null)
    else assert.ok(typeof entry.reason === 'string' && entry.reason !== '', '掉出去的没说理由')
  }
  assert.ok(got.weakest.some((entry) => !entry.kept), '预算 120 下该有掉出去的条目')
})

test('情景带相对时间、结论不带：结论不是事件，加个时间等于把它说回去', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1', text: '写完了 digest 的选段' })
  const factText = '选段先排序再装'
  await seedFact(home, { ids: ['e1'], text: factText })

  const got = build({ home, now: NOW })
  const facts = got.kept.filter((row) => row.section === '记住的事')
  const scenes = got.kept.filter((row) => row.section === '最近')
  assert.equal(facts.length, 1)
  assert.equal(scenes.length, 1)
  assert.equal(facts[0].text, `- ${factText}`, '结论被加上了时间或前缀变了')
  assert.ok(scenes[0].text.includes(' · '), '情景没带相对时间')
})

test('摘要走 say、警告走 warn：! 行不许混进摘要正文', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  fs.appendFileSync(eventsFile(home, NOW), 'not json\n', 'utf8')
  const said = []
  const warned = []

  await run({ home, now: NOW, render: renderDigest, say: (s) => said.push(s), warn: (s) => warned.push(s) })

  assert.equal(said.length, 1, `摘要应当一次交出去，实际 ${said.length} 次`)
  assert.ok(said[0].startsWith('# ') || said[0].startsWith('（'), '摘要没抬头也没正文')
  assert.equal(said[0].includes('! '), false, '警告混进了摘要正文：模型会把它当内容读')
  assert.ok(warned.length > 0 && warned.every((line) => line.startsWith('! ') && line.endsWith('\n')))
})

test('out 是原子覆盖写：第二遍盖掉第一遍，目录里不留临时文件', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  await seedFact(home, { ids: ['e1'] })
  const out = path.join(home, 'digest.md')

  const first = await run({ home, now: NOW, render: renderDigest, out, ...QUIET })
  assert.equal(text(out), `${first.text}\n`)
  const second = await run({ home, now: NOW, budget: 60, render: renderDigest, out, ...QUIET })
  assert.notEqual(second.text, first.text, '两次预算不同，写出来的字该不一样')
  assert.equal(text(out), `${second.text}\n`, '第二遍没盖掉第一遍')
  assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith('.tmp')), [], '留下了临时文件')
})

test('digest 不排字也不碰 view：没有 render 就报错，源码里没有一处引 view', async () => {
  const home = newHome()
  await assert.rejects(run({ home, now: NOW }), /render/, '没有 render 却不报错：它自己开始排字了')
  const dir = path.join(ROOT, 'src', 'digest')
  for (const name of fs.readdirSync(dir)) {
    assert.equal(text(path.join(dir, name)).includes('../view/'), false, `${name} 反向依赖了 view`)
  }
})

test('入口只解释一次时间与预算：字符串时间、NaN 预算一律拒绝，不猜不补', () => {
  const home = newHome()
  assert.throws(() => build({ home, now: '2026-11-13 21:40' }), /epoch ms/)
  assert.throws(() => build({ home, now: NOW, budget: Number.NaN }), /budget/)
  assert.throws(() => build({ home, now: NOW, budget: -1 }), /budget/)
  assert.throws(() => build({ home: '  ', now: NOW }), /home/)
})

test('账本只有一个读入口：digest 只写，跨月的账要读就走 audit.trace', async () => {
  const home = newHome()
  seedEvent(home, { id: 'e1' })
  const lastMonth = new Date(2026, 9, 31, 23, 0, 0).getTime()

  await run({ home, now: lastMonth, render: renderDigest, ...QUIET })
  await run({ home, now: NOW, render: renderDigest, ...QUIET })
  // 门面只剩写入口：读账是 audit 的事（design §6 的 audit/trace），两边各读一遍就会各错一遍。
  const facade = await import('../src/digest/index.mjs')
  assert.deepEqual(Object.keys(facade).sort(), ['build', 'record', 'retell', 'run'])

  const got = auditTrace({ home, now: NOW })
  assert.equal(got.items.length, 2, '跨月只读到一半的账')
  assert.ok(got.items[0].at > got.items[1].at, '账本没按时间倒着排')
  assert.equal(got.skipped, 0)
})

test('"还没巩固过"由 audit.trace 回空数组表达：digest 不再自带 never 开关', async () => {
  const home = newHome()
  assert.deepEqual(auditTrace({ home, now: NOW }).items, [], '盘上什么都没有却说巩固过')

  seedEvent(home, { id: 'e1' })
  await run({ home, now: NOW, render: renderDigest, ...QUIET })
  assert.equal(auditTrace({ home, now: NOW }).items.length, 1, '已经落过账了还说从没落过')
})

// 用例跑完把临时数据目录删掉：一次全量会开出上百个，留在系统临时目录里就是垃圾（AGENTS 六）。
test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})
