import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { main } from '../src/cli/index.mjs'
import * as memory from '../src/memory/index.mjs'
import { appendJsonl, ensure, eventsFile } from '../src/store/index.mjs'

// CLI 层的用例只认命令行的进出：main(argv, { env, out, err, now }) + 记录器，
// 不 spawn 子进程（design §11）。时间传死，PATH 清空——零件直通不在这里碰真系统。
function box() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  const now = new Date(2026, 10, 14, 10, 0, 0).getTime()
  return { dir, now, env: { AGENT_MAN_HOME: dir, PATH: '' } }
}

async function cli(boxOne, argv) {
  const out = []
  const err = []
  const code = await main(argv, {
    env: boxOne.env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => boxOne.now,
  })
  return { code, out: out.join(''), err: err.join('') }
}

function seed(boxOne, entries) {
  ensure(boxOne.dir)
  for (const one of entries) {
    appendJsonl(eventsFile(boxOne.dir, one.at), { ...one, src: { origin: 'user' } })
  }
}

test('不带参数就是处境屏：mind 还没合并时退出码 2，并说清是没接上而不是今天没事', async () => {
  const one = box()
  const got = await cli(one, [])
  assert.equal(got.code, 2)
  assert.equal(got.out, '')
  assert.match(got.err, /^! 处境还没接上：mind 车道在合并中/)
})

test('既不认识的命令也不是零件：退出码 2，并点出零件该叫什么名字', async () => {
  const one = box()
  const got = await cli(one, ['weather', '北京'])
  assert.equal(got.code, 2)
  assert.equal(got.out, '')
  assert.match(got.err, /没有这个命令，也没找到 agent-man-weather/)
})

test('--help 只列已经接上的命令，正文进 stdout，退出码 0', async () => {
  const one = box()
  const got = await cli(one, ['--help'])
  assert.equal(got.code, 0)
  assert.match(got.out, /agent-man audit/)
  assert.match(got.out, /退出码/)
  assert.doesNotMatch(got.out, /rule/)
  assert.equal(got.err, '')
})

test('event ls：窗口内的按时间倒序一行一条，窗口外的不出现', async () => {
  const one = box()
  seed(one, [
    { id: 'e-1', at: one.now - 3 * 60 * 60 * 1000, text: '她在改简历' },
    { id: 'e-2', at: one.now - 60 * 60 * 1000, text: '她说今晚加班' },
    { id: 'e-3', at: one.now - 40 * 24 * 60 * 60 * 1000, text: '很久以前的事' },
  ])
  const got = await cli(one, ['event', 'ls'])
  assert.equal(got.code, 0)
  const rows = got.out.trim().split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[0], /e-2 .*她说今晚加班/)
  assert.match(rows[1], /e-1 .*她在改简历/)
  assert.doesNotMatch(got.out, /很久以前的事/)
})

test('event ls --all：连 30 天窗口外的一起列出来', async () => {
  const one = box()
  seed(one, [
    { id: 'e-1', at: one.now - 60 * 60 * 1000, text: '今天的事' },
    { id: 'e-2', at: one.now - 40 * 24 * 60 * 60 * 1000, text: '很久以前的事' },
  ])
  const got = await cli(one, ['event', 'ls', '--all'])
  assert.equal(got.code, 0)
  assert.match(got.out, /很久以前的事/)
  assert.match(got.out, /今天的事/)
})

test('event ls --limit 截断时用 "! " 说清还有几条没列', async () => {
  const one = box()
  seed(one, [
    { id: 'e-1', at: one.now - 3000, text: '一' },
    { id: 'e-2', at: one.now - 2000, text: '二' },
    { id: 'e-3', at: one.now - 1000, text: '三' },
  ])
  const got = await cli(one, ['event', 'ls', '--limit', '1'])
  assert.equal(got.code, 0)
  assert.equal(got.out.trim().split('\n').length, 1)
  assert.match(got.out, /e-3/)
  assert.match(got.err, /^! 只列了最近 1 条，还有 2 条没列/)
})

test('event find 只在正文里找词：找到就列，找不到写「（空）」而不是空屏', async () => {
  const one = box()
  seed(one, [
    { id: 'e-1', at: one.now - 1000, text: '她说今晚加班' },
    { id: 'e-2', at: one.now - 2000, text: '她在改简历' },
  ])
  const hit = await cli(one, ['event', 'find', '加班'])
  assert.equal(hit.code, 0)
  assert.match(hit.out, /e-1/)
  assert.doesNotMatch(hit.out, /改简历/)
  const miss = await cli(one, ['event', 'find', '考试'])
  assert.equal(miss.code, 0)
  assert.equal(miss.out.trim(), '（空）')
})

test('event ls --json：stdout 只有一行 JSON，坏行只走 stderr', async () => {
  const one = box()
  seed(one, [{ id: 'e-1', at: one.now - 1000, text: '她说今晚加班' }])
  fs.appendFileSync(eventsFile(one.dir, one.now), 'not json\n', 'utf8')
  const got = await cli(one, ['event', 'ls', '--json'])
  assert.equal(got.code, 0)
  const parsed = JSON.parse(got.out)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].text, '她说今晚加班')
  assert.match(got.err, /^! 跳过 1 行读不懂的事件/)
})

test('memory add 拿事件当证据：记下后 memory ls 能看见', async () => {
  const one = box()
  seed(one, [{ id: 'e-1', at: one.now - 60 * 60 * 1000, text: '她说今晚加班' }])
  const added = await cli(one, ['memory', 'add', '她加班到十点', '--key', '她·作息', '--from', 'e-1'])
  assert.equal(added.code, 0)
  assert.match(added.out, /已记下 m-/)
  const listed = await cli(one, ['memory', 'ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.out, /她加班到十点 \[她·作息\]/)
})

test('memory add 的证据对不上真事件：退出码 2，并说清先 event add', async () => {
  const one = box()
  const got = await cli(one, ['memory', 'add', '她加班到十点', '--key', '她·作息', '--from', 'e-ghost'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 证据解析不到任何真实事件/)
})

test('memory show 摆出证据在不在；查不到的 id 退出码 1 而不是 0', async () => {
  const one = box()
  seed(one, [{ id: 'e-1', at: one.now - 60 * 60 * 1000, text: '她说今晚加班' }])
  await cli(one, ['memory', 'add', '她加班到十点', '--key', '她·作息', '--from', 'e-1'])
  const got = await cli(one, ['memory', 'show', '她·作息'])
  assert.equal(got.code, 0)
  assert.match(got.out, /她加班到十点 \[她·作息\]/)
  assert.match(got.out, /证据 {2}e-1 {2}在/)
  const miss = await cli(one, ['memory', 'show', 'm-19700101-01'])
  assert.equal(miss.code, 1)
  assert.match(miss.err, /^! 没有这条结论/)
})

test('note add 与 note ls：触发条件写在行里，ttl 与 id 都记下来', async () => {
  const one = box()
  const added = await cli(one, ['note', 'add', '记得带伞', '--trigger', '她出门前', '--ttl', '7d'])
  assert.equal(added.code, 0)
  assert.match(added.out, /已留下 n-/)
  const listed = await cli(one, ['note', 'ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.out, /记得带伞（等：她出门前）/)
})

test('note take 递出一次就关闭：第二次退出码 2 而不是再递一遍', async () => {
  const one = box()
  const added = await cli(one, ['note', 'add', '记得带伞', '--trigger', '出门', '--json'])
  const id = JSON.parse(added.out).id
  const first = await cli(one, ['note', 'take', id])
  assert.equal(first.code, 0)
  assert.match(first.out, /已递出/)
  const again = await cli(one, ['note', 'take', id])
  assert.equal(again.code, 2)
  assert.match(again.err, /^! 这条便条已经关闭过/)
})

test('plan add 缺 --at：退出码 2，并说清日程一定要到期时间', async () => {
  const one = box()
  const got = await cli(one, ['plan', 'add', '去体检'])
  assert.equal(got.code, 2)
  assert.match(got.err, /plan add 要给 --at/)
})

test('plan add 认得「明天 9:00」，plan done 打勾后重复打勾退出码 2', async () => {
  const one = box()
  const added = await cli(one, ['plan', 'add', '去体检', '--at', '明天 9:00', '--json'])
  assert.equal(added.code, 0)
  const made = JSON.parse(added.out)
  assert.equal(made.due, new Date(2026, 10, 15, 9, 0, 0).getTime())
  const done = await cli(one, ['plan', 'done', made.id])
  assert.equal(done.code, 0)
  assert.match(done.out, /已打勾/)
  const again = await cli(one, ['plan', 'done', made.id])
  assert.equal(again.code, 2)
  assert.match(again.err, /已经 done 过/)
})

test('plan ls 把过点的排在前面并标「已晚」', async () => {
  const one = box()
  await cli(one, ['plan', 'add', '交房租', '--at', '2026-11-13 09:00'])
  await cli(one, ['plan', 'add', '去体检', '--at', '2026-11-20 09:00'])
  const got = await cli(one, ['plan', 'ls'])
  assert.equal(got.code, 0)
  const rows = got.out.trim().split('\n')
  assert.match(rows[0], /交房租/)
  assert.match(rows[0], /已晚/)
  assert.match(rows[1], /去体检/)
  assert.doesNotMatch(rows[1], /已晚/)
})

test('context digest --dry-run：只在 stdout 出一份摘要，stderr 说清没落盘', async () => {
  const one = box()
  seed(one, [{ id: 'e-1', at: one.now - 60 * 60 * 1000, text: '她说今晚加班' }])
  const got = await cli(one, ['context', 'digest', '--dry-run'])
  assert.equal(got.code, 0)
  assert.match(got.out, /—— 用了/)
  assert.match(got.err, /dry-run：只算不落/)
  const stateDir = path.join(one.dir, 'state')
  const traces = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.startsWith('trace-')) : []
  assert.deepEqual(traces, [], 'dry-run 写了账本')
})

test('context digest --json：正文与警告一起交出来，stdout 只有一行 JSON', async () => {
  const one = box()
  const got = await cli(one, ['context', 'digest', '--dry-run', '--json'])
  assert.equal(got.code, 0)
  const parsed = JSON.parse(got.out)
  assert.equal(typeof parsed.text, 'string')
  assert.ok(parsed.warnings.length > 0)
})

test('context sense 在 PATH 上没有零件时写「没有可用的零件」，不假装有声', async () => {
  const one = box()
  const got = await cli(one, ['context', 'sense'])
  assert.equal(got.code, 0)
  assert.match(got.out, /（没有可用的零件/)
})

test('audit timeline 在空目录上也有话说：窗口内什么都没发生', async () => {
  const one = box()
  const got = await cli(one, ['audit', 'timeline'])
  assert.equal(got.code, 0)
  assert.match(got.out, /什么都没发生/)
})

test('audit orphan 发现证据不见了：退出码 1，并点出缺哪几条证据', async () => {
  const one = box()
  seed(one, [{ id: 'e-1', at: one.now - 60 * 60 * 1000, text: '她说今晚加班' }])
  const made = await memory.add({
    key: '她·作息',
    fact: '她加班到十点',
    evidence: { ids: ['e-1'] },
    at: one.now - 60 * 60 * 1000,
  }, { home: one.dir, now: one.now })
  appendJsonl(path.join(one.dir, 'memory.jsonl'), {
    ...made.record,
    id: 'm-19700101-97',
    evidence: { ids: ['e-ghost'] },
  })
  const got = await cli(one, ['audit', 'orphan'])
  assert.equal(got.code, 1)
  assert.match(got.out, /缺证据：e-ghost/)
  assert.match(got.err, /^! 有孤立的结论/)
})

test('affect show 只印数字、标签与刺激条数', async () => {
  const one = box()
  const got = await cli(one, ['affect', 'show'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^v=\d+ e=\d+ t=\d+ r=\d+ · \S+ · \d+ 条刺激/)
})

test('affect set 缺 --why：退出码 2，改了什么为什么改都要写清', async () => {
  const one = box()
  const got = await cli(one, ['affect', 'set', '愉悦', '60'])
  assert.equal(got.code, 2)
  assert.match(got.err, /override 必须带 why/)
})

test('affect set 之后 affect why 把理由摆出来，值落在快照里', async () => {
  const one = box()
  const set = await cli(one, ['affect', 'set', '愉悦', '60', '--why', '她夸了我一句', '--for', '2h'])
  assert.equal(set.code, 0)
  const shown = await cli(one, ['affect', 'show', '--json'])
  assert.equal(JSON.parse(shown.out).v, 60)
  const why = await cli(one, ['affect', 'why'])
  assert.equal(why.code, 0)
  assert.match(why.out, /她夸了我一句|愉悦/)
})

test('affect stim 不认得 kind：退出码 2，并列出认得的写法', async () => {
  const one = box()
  const got = await cli(one, ['affect', 'stim', '莫名其妙', '--why', '说不清'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 未知的刺激 kind/)
})

test('打错的开关不会被悄悄忽略：--jsno 当场退出码 2', async () => {
  const one = box()
  const got = await cli(one, ['audit', 'trace', '--jsno'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 不认识的开关：--jsno/)
})

test('别名走同一条路：remember 缺参数时给的是 memory add 的用法', async () => {
  const one = box()
  const got = await cli(one, ['remember'])
  assert.equal(got.code, 2)
  assert.match(got.err, /用法：agent-man memory add/)
})

test('resource 后面跟了不认识的动作用退出码 2，不退回成 ls', async () => {
  const one = box()
  const got = await cli(one, ['memory', 'bogus'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 不认识的用法：「bogus」/)
})

test('doctor 的渲染与退出码没被这次接线动过', async () => {
  const one = box()
  const got = await cli(one, ['doctor'])
  assert.match(got.out, /^agent-man doctor\n {2}数据目录 {3}/)
  assert.ok(got.code === 0 || got.code === 1)
})
