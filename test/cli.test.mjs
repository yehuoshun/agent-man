import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { set as affectSet } from '../src/affect/index.mjs'
import { main } from '../src/cli/index.mjs'
import { plans } from '../src/intent/index.mjs'
import * as memory from '../src/memory/index.mjs'
import { appendJsonl, ensure, eventsFile, metaFile, readJsonl, stateFile } from '../src/store/index.mjs'

// CLI 层的用例只认命令行的进出：main(argv, { env, out, err, now }) + 记录器，
// 不 spawn 子进程（design §11）。时间传死，PATH 清空——零件直通不在这里碰真系统。
const HOMES = []

function box() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  HOMES.push(dir)
  const now = new Date(2026, 10, 14, 10, 0, 0).getTime()
  return { dir, now, env: { AGENT_MAN_HOME: dir, PATH: '' } }
}

// 假零件：这里要真跑一次才证明"零件答话真的拐进了那一屏"（design §8 的聚合模式），
// 所以这个用例是全仓唯一 spawn 子进程的 CLI 用例。正文用 ASCII——Windows 的 cmd 按
// 代码页转码，塞中文进去断言的就不是产品行为了。
function fakePart() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-part-'))
  HOMES.push(dir)
  const body = '{"name":"fake","desc":"fake part","section":"env","timeout_ms":1000,"side_effects":false}'
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'agent-man-fake.cmd'), [
      '@echo off',
      'if "%~1"=="--describe" (',
      `  echo ${body}`,
      ') else (',
      '  echo rain outside',
      ')',
      '',
    ].join('\r\n'))
  } else {
    const file = path.join(dir, 'agent-man-fake')
    fs.writeFileSync(file, ['#!/bin/sh', 'if [ "$1" = "--describe" ]; then', `  echo '${body}'`, 'else', '  echo "rain outside"', 'fi', ''].join('\n'))
    fs.chmodSync(file, 0o755)
  }
  return dir
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

test('不带参数就是处境屏：与 context show 打同一屏，退出码 0', async () => {
  const one = box()
  const bare = await cli(one, [])
  const named = await cli(one, ['context', 'show'])
  assert.equal(bare.code, 0)
  assert.equal(bare.err, '')
  assert.match(bare.out, /^agent-man · 2026-11-14 10:00/)
  assert.match(bare.out, /上次开口：还没开过口/)
  assert.equal(bare.out, named.out)
})

test('既不认识的命令也不是零件：退出码 2，并点出零件该叫什么名字', async () => {
  const one = box()
  const got = await cli(one, ['weather', '北京'])
  assert.equal(got.code, 2)
  assert.equal(got.out, '')
  assert.match(got.err, /没有这个命令，也没找到 agent-man-weather/)
})

test('--help 列出的每一项都能被命令表解析到（帮里不许有打不通的用法）', async () => {
  const one = box()
  const got = await cli(one, ['--help'])
  assert.equal(got.code, 0)
  assert.match(got.out, /agent-man audit/)
  assert.match(got.out, /退出码/)
  assert.match(got.out, /agent-man rule\s+add/)
  assert.match(got.out, /agent-man self\s+show/)
  assert.match(got.out, /agent-man context cue/)
  assert.equal(got.err, '')

  const seen = new Set()
  for (const line of got.out.split('\n')) {
    const hit = /^ {2}agent-man\s+(.+)$/.exec(line)
    if (!hit) continue
    const words = []
    for (const word of hit[1].trim().split(/\s+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(word)) break
      words.push(word)
      if (words.length === 2) break
    }
    if (words.length === 0) continue
    seen.add(words.join(' '))
    // 参数缺了可以退 2（用法错），但"没有这个命令"或"不认识的用法"说明帮助写错了。
    const tried = await cli(box(), words)
    assert.doesNotMatch(tried.err, /没有这个命令|不认识的用法/, `帮助里的 ${words.join(' ')} 打不通`)
  }
  assert.ok(seen.size >= 12, `帮助只解析出 ${seen.size} 条命令`)
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

test('context show 把零件答话摆成最后那一段：情绪够了才摆', async () => {
  const one = box()
  one.env.PATH = fakePart()
  if (process.env.ComSpec) one.env.ComSpec = process.env.ComSpec
  if (process.env.SystemRoot) one.env.SystemRoot = process.env.SystemRoot
  // AFFECT_BASE 是 v=50 e=60：先确认这个处境下不主动提。
  const quietOne = await cli(one, ['context', 'show'])
  assert.equal(quietOne.code, 0)
  assert.equal(quietOne.out.includes('建议'), false)
  assert.match(quietOne.err, /! 建议 丢：此刻 v=50 e=60/)

  await affectSet(one.dir, { axis: 'v', value: 90, why: '用例：高兴', at: one.now - 60 * 60 * 1000 })
  await affectSet(one.dir, { axis: 'e', value: 90, why: '用例：有劲', at: one.now - 60 * 60 * 1000 })
  const eager = await cli(one, ['context', 'show'])
  assert.equal(eager.code, 0)
  assert.match(eager.out, /\n\n建议\n  · rain outside（fake）\n$/)
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

test('event add 真写进当天的分片，并把欠账记上（写过就要读得回来）', async () => {
  const one = box()
  const got = await cli(one, ['event', 'add', '她说明天要早出门', '--imp', '2', '--cue', '她,出门'])
  assert.equal(got.code, 0)
  assert.equal(got.err, '')
  assert.match(got.out, /^已记下 e-\d{8}-\d{2}（imp 2，cue 她、出门）/)
  const rows = readJsonl(eventsFile(one.dir, one.now)).items
  const hit = rows.filter((row) => row.text === '她说明天要早出门')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].imp, 2)
  assert.deepEqual(hit[0].cues, ['她', '出门'])
  const meta = JSON.parse(fs.readFileSync(metaFile(one.dir), 'utf8'))
  assert.deepEqual(meta.debt, { unconsolidated: 2, unreflected: 1 })
})

test('event add --json 只回一行，id 以 e- 开头', async () => {
  const one = box()
  const got = await cli(one, ['event', 'add', '她说周末想去看展', '--json'])
  assert.equal(got.code, 0)
  const rows = got.out.trim().split('\n')
  assert.equal(rows.length, 1)
  assert.match(JSON.parse(rows[0]).id, /^e-\d{8}-\d{2}/)
})

test('event add 的 --src 写错：退出码 2，并列出三种写法', async () => {
  const one = box()
  const got = await cli(one, ['event', 'add', '她说要早睡', '--src', 'tool'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! --src 只认 user \/ tool:名字 \/ self/)
})

test('event add 空文本：退出码 2，给一行写法，且一个字都不落盘', async () => {
  const one = box()
  const got = await cli(one, ['event', 'add', '   '])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 用法：agent-man event add/)
  assert.equal(fs.existsSync(eventsFile(one.dir, one.now)), false)
})

test('context show --json 只给一个对象，clock 是钉死的那一刻', async () => {
  const one = box()
  const got = await cli(one, ['context', 'show', '--json'])
  assert.equal(got.code, 0)
  const rows = got.out.trim().split('\n')
  assert.equal(rows.length, 1)
  const scene = JSON.parse(rows[0])
  assert.equal(scene.clock, '2026-11-14 10:00')
  assert.equal(scene.quiet, false)
})

test('别名 look 与裸 agent-man 打的是同一屏（处境屏只有一条路）', async () => {
  const one = box()
  const look = await cli(one, ['look'])
  const bare = await cli(one, [])
  assert.equal(look.code, 0)
  assert.equal(look.out, bare.out)
})

test('context cue 没事由时退出码 1，但"没说出口"也要留在账本里', async () => {
  const one = box()
  const got = await cli(one, ['context', 'cue'])
  assert.equal(got.code, 1)
  assert.equal(got.out, '')
  assert.match(got.err, /^! 这会儿不说：没什么新事，也还没到开口的时候/)
  const ledger = readJsonl(stateFile(one.dir, 'judge', one.now)).items
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].said, false)
  assert.equal(ledger[0].at, one.now)
})

test('context cue 有话可说：退出码 0，判决与"上次开口"一起落地', async () => {
  const one = box()
  await plans.add(one.dir, { text: '交房租', due: one.now - 24 * 60 * 60 * 1000 })
  const got = await cli(one, ['context', 'cue'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^可以说：1 条日程过点，还没开过口/)
  const ledger = readJsonl(stateFile(one.dir, 'judge', one.now)).items
  assert.equal(ledger[0].said, true)
  const meta = JSON.parse(fs.readFileSync(metaFile(one.dir), 'utf8'))
  assert.equal(meta.lastCueAt, one.now)
})

test('context cue --peek 只看不记：账本里不多一行，水位也不动', async () => {
  const one = box()
  await plans.add(one.dir, { text: '交房租', due: one.now - 24 * 60 * 60 * 1000 })
  const got = await cli(one, ['context', 'cue', '--peek'])
  assert.equal(got.code, 0)
  assert.match(got.err, /peek：这次不记账/)
  assert.equal(fs.existsSync(stateFile(one.dir, 'judge', one.now)), false)
})

test('context cue --why 是"人要求此刻就说"：静默与间隔都不拦', async () => {
  const one = box()
  const got = await cli(one, ['context', 'cue', '--why', '她按了那个键'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^可以说：人要求此刻就说（静默与间隔都不拦）/)
  assert.match(got.err, /人要求此刻就说（--why「她按了那个键」）/)
})

test('rule add 缺 --why：退出码 2，说清没有理由的规矩不许立', async () => {
  const one = box()
  const got = await cli(one, ['rule', 'add', '晚上十点后不主动找她'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! why 必须是非空字符串/)
})

test('rule add 之后 rule ls 只有一行一条，带 ! 前缀（规矩排在记录里）', async () => {
  const one = box()
  const made = await cli(one, ['rule', 'add', '晚上十点后不主动找她', '--why', '她说过要早睡'])
  assert.equal(made.code, 0)
  assert.match(made.out, /^已立规矩 r-\d{8}-\d{2}（现在 1\/20 条在生效）/)
  const got = await cli(one, ['rule', 'ls'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^r-\d{8}-\d{2} {2}刚刚 {2}! 晚上十点后不主动找她\n$/)
})

test('rule add --supersedes：旧的当场不再生效，但行还在（--all 看得见）', async () => {
  const one = box()
  const first = await cli(one, ['rule', 'add', '晚上十点后不主动找她', '--why', '她说过要早睡'])
  const id = /r-\d{8}-\d{2}/.exec(first.out)[0]
  const second = await cli(one, ['rule', 'add', '晚上九点后不主动找她', '--why', '她改口了',
    '--supersedes', id])
  assert.equal(second.code, 0)
  assert.match(second.err, new RegExp(`旧的 ${id} 已被取代`))
  const live = await cli(one, ['rule', 'ls'])
  assert.match(live.out, /晚上九点后不主动找她/)
  assert.doesNotMatch(live.out, /晚上十点后不主动找她/)
  const all = await cli(one, ['rule', 'ls', '--all'])
  assert.match(all.out, /晚上十点后不主动找她/)
  assert.match(all.out, /晚上九点后不主动找她/)
})

test('rule ls 一条都没有时写「（空）」而不是什么都不说', async () => {
  const one = box()
  const got = await cli(one, ['rule'])
  assert.equal(got.code, 0)
  assert.equal(got.out, '（空）\n')
})

test('self append 起今天这一段，self show 原样打出来', async () => {
  const one = box()
  const added = await cli(one, ['self', 'append', '今天把线接完了'])
  assert.equal(added.code, 0)
  assert.match(added.out, /^已记进自我块（新起 2026-11-14 这一段）/)
  const got = await cli(one, ['self', 'show'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^## 2026-11-14\n/)
  assert.match(got.out, /今天把线接完了/)
})

test('self set 是整份覆盖：原来那段不在了（旧文本不保留）', async () => {
  const one = box()
  await cli(one, ['self', 'append', '今天把线接完了'])
  const got = await cli(one, ['self', 'set', '新的我'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^已覆盖自我块（/)
  const shown = await cli(one, ['self', 'show'])
  assert.equal(shown.out.trim(), '新的我')
})

test('self set 超上限：退出码 2，说清是整份覆盖、别指望截断', async () => {
  const one = box()
  const got = await cli(one, ['self', 'set', '字'.repeat(700)])
  assert.equal(got.code, 2)
  assert.match(got.err, /自我块上限是 600/)
  assert.match(got.err, /整份覆盖/)
})

test('self show 空着也给人一句"怎么开始"，不装作有内容', async () => {
  const one = box()
  const got = await cli(one, ['self', 'show'])
  assert.equal(got.code, 0)
  assert.match(got.out, /^（还没写过自我块：agent-man self append/)
})

test('context digest --due 退 2：门面不收的开关不装作生效', async () => {
  const one = box()
  const got = await cli(one, ['context', 'digest', '--due'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! --due 这一版还没接/)
})

test('affect stim --imp 退 2：刺激的权重由 kind 定，不能让人以为调过了', async () => {
  const one = box()
  const got = await cli(one, ['affect', 'stim', '被夸', '--why', '她夸我', '--imp', '2'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! 刺激的权重由 kind 定，--imp 不收/)
})

test('memory revise --from 退 2：证据跟着记忆走，不重写', async () => {
  const one = box()
  const got = await cli(one, ['memory', 'revise', 'm-1', '新的说法', '--from', 'e-1'])
  assert.equal(got.code, 2)
  assert.match(got.err, /^! --from 这一版没接/)
})

test('memory add 的 --from 不认日期区间：退 2，并指去 event id', async () => {
  const one = box()
  const got = await cli(one, ['memory', 'add', '她在找工作', '--key', '工作',
    '--from', '2026-11-01..2026-11-03'])
  assert.equal(got.code, 2)
  assert.match(got.err, /证据要写事件 id（--from 区间这一版不支持）/)
})


test('CLI 写入口的日界读配置：凌晨两点记的事落在前一天', async () => {
  const one = box()
  // 配置里的日界是 04:00（默认值），此刻是 02:00 —— 该算前一天。
  fs.writeFileSync(path.join(one.dir, 'config.json'), JSON.stringify({ clock: { dayStart: '04:00' } }))
  one.now = new Date(2026, 10, 14, 2, 0, 0).getTime()
  const got = await cli(one, ['event', 'add', '凌晨两点的事'])
  assert.equal(got.code, 0)
  assert.match(got.out, /e-20261113-01/, '号里的日期没按配置的日界算')
})

// 用例跑完把临时数据目录删掉：一次全量会开出上百个，留在系统临时目录里就是垃圾（AGENTS 六）。
test.after(() => {
  for (const dir of HOMES) fs.rmSync(dir, { recursive: true, force: true })
})
