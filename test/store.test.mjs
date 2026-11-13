import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  VERSION, appendJsonl, assertLanded, checkHome, claim, ensure, eventsFile, home,
  listShards, readJson, readJsonl, stateFile, validate, writeAtomic,
} from '../src/store/index.mjs'

// 数据目录一律现开现用：用例之间不共享盘上状态，也就没有"顺序依赖"这回事。
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
}

const names = (files) => files.map((f) => path.basename(f))

test('home 只认 AGENT_MAN_HOME，空值不算设过', () => {
  assert.equal(home({ AGENT_MAN_HOME: 'D:\\somewhere' }), 'D:\\somewhere')
  assert.ok(home({}).endsWith('.agent-man'))
  // Windows 上 `set AGENT_MAN_HOME=` 会留个空串，那不能让数据落进当前目录。
  assert.ok(home({ AGENT_MAN_HOME: '   ' }).endsWith('.agent-man'))
})

test('追加后读得回同一行；文件里已有别人的行时仍按 id 认自己那行', () => {
  const dir = tempDir()
  ensure(dir)
  const ts = new Date(2026, 10, 13, 21, 40).getTime()
  const file = eventsFile(dir, ts)
  const first = { id: 'e-20261113-01', at: ts, text: '她关了窗' }
  const second = { id: 'e-20261113-02', at: ts + 1000, text: '她把灯关了' }

  appendJsonl(file, first)
  const before = fs.readFileSync(file, 'utf8')
  appendJsonl(file, second)

  // 旧行永不改写：第二行只能接在后面，不能整份重写。
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(before))
  const back = readJsonl(file)
  assert.deepEqual(back.items.map((r) => r.id), [first.id, second.id])
  assert.equal(back.bad, 0)

  // 第一行已经不是最后一行了，还得认得出：只看末尾的实现会在这里蒙混过关。
  assert.doesNotThrow(() => assertLanded(file, first))
  assert.throws(() => assertLanded(file, { id: 'e-20261113-99' }), /没有落盘/)
})

test('两行并发追加都落盘，读回两行都在', async () => {
  const dir = tempDir()
  ensure(dir)
  const ts = new Date(2026, 10, 13, 21, 40).getTime()
  const file = eventsFile(dir, ts)
  const recs = [
    { id: 'e-a', at: ts, text: '甲' },
    { id: 'e-b', at: ts + 1, text: '乙' },
  ]
  await Promise.all(recs.map(async (rec) => appendJsonl(file, rec)))
  assert.deepEqual(readJsonl(file).items.map((r) => r.id), ['e-a', 'e-b'])
})

test('坏行跳过并计数，空行不算记录，没有的分片当空读', () => {
  const dir = tempDir()
  ensure(dir)
  const ts = new Date(2026, 10, 13, 21, 40).getTime()
  const file = eventsFile(dir, ts)
  appendJsonl(file, { id: 'e-1', at: ts, text: '一' })
  appendJsonl(file, { id: 'e-2', at: ts, text: '二' })
  fs.appendFileSync(file, 'not json\n')
  fs.appendFileSync(file, 'null\n')
  fs.appendFileSync(file, '\n')

  const back = readJsonl(file)
  assert.deepEqual(back.items.map((r) => r.id), ['e-1', 'e-2'])
  // "not json" 与单行 "null" 都不是记录：一个 JSON 合法不代表读得出字段。
  assert.equal(back.bad, 2)
  assert.deepEqual(readJsonl(eventsFile(dir, new Date(1999, 0, 1).getTime())), { items: [], bad: 0 })
})

test('writeAtomic 覆盖写不留 .tmp，读到的永远是整份新内容', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'meta.json')
  await writeAtomic(file, '{"a":1}\n')
  await writeAtomic(file, '{"a":2}\n')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n')
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
})

test('readJson 分得清"还没写过"（null）与"写坏了"（__bad）', () => {
  const dir = tempDir()
  assert.equal(readJson(path.join(dir, 'meta.json')), null)
  fs.writeFileSync(path.join(dir, 'meta.json'), '{oops')
  assert.deepEqual(readJson(path.join(dir, 'meta.json')), { __bad: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"a":1}')
  assert.deepEqual(readJson(path.join(dir, 'meta.json')), { a: 1 })
})

test('ensure 建齐目录、写 schema.json，且重复调用幂等不覆盖', () => {
  const dir = tempDir()
  ensure(dir)
  const schema = path.join(dir, 'schema.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(schema, 'utf8')), { version: VERSION })
  assert.ok(fs.statSync(path.join(dir, 'events')).isDirectory())
  assert.ok(fs.statSync(path.join(dir, 'state', 'ids')).isDirectory())

  // 已经初始化过的目录再调一次：不能把 schema.json 重写成"干净"的样子。
  fs.writeFileSync(schema, `{"version":${VERSION},"note":"人工加的"}\n`)
  ensure(dir)
  assert.match(fs.readFileSync(schema, 'utf8'), /人工加的/)
})

test('claim 并发 20 个不重号，序号从 1 连续排到 20', async () => {
  const dir = tempDir()
  ensure(dir)
  const ids = await Promise.all(Array.from({ length: 20 }, () => claim(dir, 'e')))
  assert.equal(new Set(ids).size, 20)
  for (const id of ids) assert.match(id, /^e-\d{8}-\d{2,}$/)
  // 没重号且没跳号：说明真在往后抢，而不是各自算各自的。
  const seqs = ids.map((id) => Number(id.split('-')[2])).sort((a, b) => a - b)
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1))

  const mixed = await Promise.all([claim(dir, 'n'), claim(dir, 'm')])
  assert.match(mixed[0], /^n-\d{8}-\d{2,}$/)
  assert.match(mixed[1], /^m-\d{8}-\d{2,}$/)
  await assert.rejects(claim(dir, 'x'), /前缀/)
})

test('listShards 按自然日/自然月粗筛，结果按时间升序', () => {
  const dir = tempDir()
  ensure(dir)
  const days = [
    new Date(2026, 10, 14, 10, 0).getTime(),
    new Date(2026, 10, 12, 10, 0).getTime(),
    new Date(2026, 10, 13, 10, 0).getTime(),
  ]
  // 故意乱序写入：排序不能靠"文件系统给的顺序"。
  for (const ts of days) appendJsonl(eventsFile(dir, ts), { id: `e-${ts}`, at: ts })

  assert.deepEqual(names(listShards(dir, 'events')), [
    '2026-11-12.jsonl', '2026-11-13.jsonl', '2026-11-14.jsonl',
  ])
  assert.deepEqual(names(listShards(dir, 'events', { from: days[2] })), [
    '2026-11-13.jsonl', '2026-11-14.jsonl',
  ])
  const endOfTwelfth = new Date(2026, 10, 12, 23, 59).getTime()
  assert.deepEqual(names(listShards(dir, 'events', { to: endOfTwelfth })), ['2026-11-12.jsonl'])
  assert.deepEqual(names(listShards(dir, 'events', { from: days[2], to: days[2] })), ['2026-11-13.jsonl'])

  for (const ts of [new Date(2026, 9, 5).getTime(), new Date(2026, 10, 5).getTime()]) {
    appendJsonl(stateFile(dir, 'notes', ts), { id: 'n-1', at: ts, op: 'add', text: 'x' })
  }
  assert.deepEqual(names(listShards(dir, 'notes')), ['notes-2026-10.jsonl', 'notes-2026-11.jsonl'])
  assert.deepEqual(names(listShards(dir, 'notes', { from: new Date(2026, 10, 1).getTime() })), [
    'notes-2026-11.jsonl',
  ])
  assert.deepEqual(names(listShards(dir, 'notes', { to: new Date(2026, 9, 31, 23, 59).getTime() })), [
    'notes-2026-10.jsonl',
  ])
  assert.deepEqual(listShards(dir, 'judge'), [])
  assert.throws(() => listShards(dir, 'zzz'), /未知的分片类型/)
})

test('eventsFile 的日界只能由 dayStart 决定，stateFile 按月', () => {
  const dir = tempDir()
  const three = new Date(2026, 10, 13, 3, 0).getTime()
  assert.equal(path.basename(eventsFile(dir, three)), '2026-11-13.jsonl')
  // 凌晨 3 点、日界 4 点：算前一天，和 core/time 的 dayKey 同一口径。
  assert.equal(path.basename(eventsFile(dir, three, { dayStart: 4 })), '2026-11-12.jsonl')
  assert.equal(path.basename(stateFile(dir, 'judge', three)), 'judge-2026-11.jsonl')
})

test('validate 每条拒绝路径都返回 errors 而不抛', () => {
  const at = new Date(2026, 10, 13, 21, 40).getTime()
  const good = { id: 'e-1', at, text: '她关了窗', src: { origin: 'user' } }
  assert.deepEqual(validate('events', good), { ok: true, errors: [] })

  const bad = [
    ['events', { ...good, src: undefined }, /src/],
    ['events', { ...good, src: { origin: 'plugin' } }, /origin/],
    ['events', { ...good, src: { origin: 'tool' } }, /ref/],
    ['events', { ...good, at: '2026-11-13' }, /at/],
    ['events', { ...good, text: '   ' }, /text/],
    ['events', { id: '', at, text: 'x', src: { origin: 'self' } }, /id/],
    ['memory', { id: 'm-1', at, fact: '她夜里不睡', evidence: { ids: ['e-1'] } }, /key/],
    ['memory', { id: 'm-1', at, fact: '她夜里不睡', key: 'slept', evidence: { ids: [] } }, /evidence/],
    ['memory', { id: 'm-1', at, fact: 'x', key: 'k', evidence: { ids: 'e-1' } }, /evidence/],
    ['memory', { id: 'm-1', at, fact: 'x', key: 'k', evidence: { ids: ['e-1'], from: 'x' } }, /from/],
    ['notes', { id: 'n-1', at, text: 'x', op: 'remove' }, /op/],
    ['plans', { id: 'p-1', at, text: '' , op: 'add' }, /text/],
    ['zzz', { id: 'z-1', at, text: 'x' }, /未知的记录类型/],
    ['events', null, /对象/],
    ['events', [], /对象/],
  ]

  for (const [kind, obj, pattern] of bad) {
    let result
    assert.doesNotThrow(() => {
      result = validate(kind, obj)
    }, `${kind} 的坏记录不该抛`)
    assert.equal(result.ok, false, `${kind} 的坏记录必须判不合法`)
    assert.ok(result.errors.length > 0)
    if (pattern) assert.match(result.errors.join(' / '), pattern)
  }
})

test('checkHome 只读：缺目录与缺 schema.json 都说清原因，且不写盘', () => {
  const dir = tempDir()
  const empty = checkHome(dir)
  assert.equal(empty.exists, true)
  assert.equal(empty.ok, false)
  assert.match(empty.why, /schema\.json/)
  assert.deepEqual(fs.readdirSync(dir), [], 'doctor 是读命令，不许顺带初始化')

  const missing = checkHome(path.join(dir, 'nope'))
  assert.equal(missing.exists, false)
  assert.equal(missing.ok, false)

  ensure(dir)
  const ok = checkHome(dir)
  assert.equal(ok.ok, true)
  assert.equal(ok.version, VERSION)
  assert.equal(ok.home, dir)
  assert.equal(ok.why, '')

  fs.writeFileSync(path.join(dir, 'schema.json'), '{"version":2}\n')
  const old = checkHome(dir)
  assert.equal(old.ok, false)
  assert.equal(old.version, 2)
  assert.match(old.why, /2/)

  fs.writeFileSync(path.join(dir, 'schema.json'), '{oops')
  assert.match(checkHome(dir).why, /schema\.json/)
})
