import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { SELF_MAX, cost } from '../src/core/index.mjs'
import { appendSelf, readSelf, setSelf } from '../src/memory/index.mjs'

const DAY = 24 * 60 * 60 * 1000
// 时间用例一律传死 now（AGENTS 六）：`## 日期` 用的是本地日期，纽约时区腿也成立。
const NOW = new Date(2026, 10, 13, 21, 40, 0).getTime()

const HOMES = []

function newHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  return dir
}

function selfPath(home) {
  return path.join(home, 'self.md')
}

test('还没有自我块时读出来是空文本，不抛也不顺手建文件', () => {
  const home = newHome()
  const read = readSelf(home)
  assert.equal(read.text, '')
  assert.equal(read.cost, 0)
  assert.equal(read.updatedAt, null)
  assert.equal(read.over, false)
  assert.deepEqual(fs.readdirSync(home), [], '读不在别人的数据目录里建东西')
})

test('setSelf 是整份覆盖：第二次写的把第一次整份换掉', async () => {
  const home = newHome()
  await setSelf(home, '我是替人记事的那一层', { now: NOW })
  await setSelf(home, '我只是记事的那一层', { now: NOW })
  assert.equal(fs.readFileSync(selfPath(home), 'utf8'), '我只是记事的那一层\n')
})

test('setSelf 的 cost 用 core 的 cost 真算，读回来与返回的一致', async () => {
  const home = newHome()
  const text = '她怕冷，所以窗总是关着'
  const written = await setSelf(home, text, { now: NOW })
  assert.equal(written.cost, cost(`${text}\n`))
  const read = readSelf(home)
  assert.equal(read.cost, written.cost)
  assert.equal(read.text, `${text}\n`)
  assert.ok(Number.isFinite(read.updatedAt), 'updatedAt 取文件的 mtime，不能是空')
})

test('setSelf 超 SELF_MAX：拒绝，旧内容一个字都不动', async () => {
  const home = newHome()
  await setSelf(home, '原来的自我块', { now: NOW })
  const before = fs.readFileSync(selfPath(home), 'utf8')
  const huge = '长'.repeat(SELF_MAX + 20)
  assert.ok(cost(huge) > SELF_MAX)
  await assert.rejects(() => setSelf(home, huge, { now: NOW }), new RegExp(`上限是 ${SELF_MAX}`))
  assert.equal(fs.readFileSync(selfPath(home), 'utf8'), before)
})

test('setSelf 只收字符串：给别的就拒绝，不替人 JSON 化', async () => {
  const home = newHome()
  await assert.rejects(() => setSelf(home, { text: '对象不行' }, { now: NOW }), /需要字符串文本/)
  await assert.rejects(() => setSelf(home, null, { now: NOW }), /需要字符串文本/)
})

test('self.md 一律写成 LF：CRLF 进来也不留 \\r', async () => {
  const home = newHome()
  await setSelf(home, '第一行\r\n第二行', { now: NOW })
  const raw = fs.readFileSync(selfPath(home), 'utf8')
  assert.ok(!raw.includes('\r'))
  assert.equal(raw, '第一行\n第二行\n')
})

test('appendSelf 段首自动加 ## 日期，日期由传入的 now 算', async () => {
  const home = newHome()
  await appendSelf(home, '今天开始记自我块', { now: NOW })
  assert.equal(fs.readFileSync(selfPath(home), 'utf8'), '## 2026-11-13\n今天开始记自我块\n')
})

test('同一天再追加一段：不重复加同一个日期标题', async () => {
  const home = newHome()
  await appendSelf(home, '早上写的', { now: NOW })
  await appendSelf(home, '晚上补的', { now: NOW + 60 * 60 * 1000 })
  const text = fs.readFileSync(selfPath(home), 'utf8')
  assert.equal(text, '## 2026-11-13\n早上写的\n\n晚上补的\n')
  assert.equal(text.split('## 2026-11-13').length - 1, 1, '一天只该有一个日期标题')
})

test('换一天追加：另起一个日期标题', async () => {
  const home = newHome()
  await appendSelf(home, '昨天写的', { now: NOW })
  await appendSelf(home, '今天写的', { now: NOW + DAY })
  const text = fs.readFileSync(selfPath(home), 'utf8')
  assert.equal(text, '## 2026-11-13\n昨天写的\n\n## 2026-11-14\n今天写的\n')
})

test('追加后超预算：拒绝，文件停在追加前', async () => {
  const home = newHome()
  await setSelf(home, '字'.repeat(SELF_MAX - 50), { now: NOW })
  const before = fs.readFileSync(selfPath(home), 'utf8')
  await assert.rejects(
    () => appendSelf(home, '字'.repeat(60), { now: NOW }),
    new RegExp(`上限是 ${SELF_MAX}`),
  )
  assert.equal(fs.readFileSync(selfPath(home), 'utf8'), before)
})

test('appendSelf 的段落是空白：拒绝，不留下只有日期的空标题', async () => {
  const home = newHome()
  await assert.rejects(() => appendSelf(home, '   \n  ', { now: NOW }), /段落是空的/)
  assert.ok(!fs.existsSync(selfPath(home)))
})

test('写到自我块走原子写：落盘后目录里不留 .tmp', async () => {
  const home = newHome()
  await setSelf(home, '一份完整的自我块', { now: NOW })
  await appendSelf(home, '再加一段', { now: NOW })
  const leftovers = fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('缺 home：明确报错，不往当前工作目录写自我块', async () => {
  await assert.rejects(() => setSelf(undefined, '文本', { now: NOW }), /需要一个数据目录/)
  assert.throws(() => readSelf(''), /需要一个数据目录/)
})

test('日界跟着配置走：dayStart 04:00 时凌晨两点写的那段归前一天', async () => {
  const home = newHome()
  const late = new Date(2026, 10, 14, 2, 0, 0).getTime()
  // 默认日界（00:00）：凌晨两点已经是 14 号。
  await appendSelf(home, '凌晨两点写的', { now: late })
  assert.match(readSelf(home).text, /^## 2026-11-14$/m)
  // 配了 04:00 日界：同一时刻还在"上一个夜里"，该归 13 号。
  fs.rmSync(selfPath(home))
  const got = await appendSelf(home, '凌晨两点写的', { now: late, dayStart: '04:00' })
  assert.equal(got.header, '## 2026-11-13')
  assert.match(readSelf(home).text, /^## 2026-11-13$/m)
})
// 用例跑完把临时数据目录删掉：一次全量会开出上百个，留在系统临时目录里就是垃圾（AGENTS 六）。
test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})
