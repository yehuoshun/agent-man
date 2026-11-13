import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scan, describe, capture, passthrough, bump, blocked } from '../src/parts/index.mjs'

const WIN = process.platform === 'win32'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))

// 造一个零件。Windows 上 PATH 里的零件只有 .exe/.cmd/.bat/无后缀，.exe 造不出来，所以用 .cmd；
// 其它平台用无后缀 + x 位（有后缀的 scan 不认，没 x 位的它也跳过）。
// 正文只放 ASCII：cmd.exe 按自己的代码页读批处理文件，写进去的汉字会被换掉，
// 要造汉字就在 JS 里用码点拼。
function makePart(dir, name, js, { mode = 0o755 } = {}) {
  if (WIN) {
    const file = path.join(dir, `agent-man-${name}.cmd`)
    fs.writeFileSync(file, `@node -e "${js}"\r\n`, 'utf8')
    return file
  }
  const file = path.join(dir, `agent-man-${name}`)
  fs.writeFileSync(file, `#!/usr/bin/env node\n${js}\n`, 'utf8')
  fs.chmodSync(file, mode)
  return file
}

// 零件给 --describe 的自报体。.cmd 那层用双引号包着整段 JS，所以对象里只能写单引号。
const says = (src) => `console.log(JSON.stringify(${src}))`

const winOnly = (why) => (WIN ? {} : { skip: why })
const posixOnly = (why) => (WIN ? { skip: why } : {})

// ---------------------------------------------------------------- 扫描

test('Windows 上 PATH 里的 agent-man-<名字>.cmd 算零件，同名 .exe 更靠前', winOnly('POSIX 不认 .cmd'), () => {
  const dir = tmp()
  const cmd = path.join(dir, 'agent-man-weather.cmd')
  const exe = path.join(dir, 'agent-man-weather.exe')
  fs.writeFileSync(cmd, '@node -e "process.exit(0)"\r\n', 'utf8')
  fs.writeFileSync(exe, '', 'utf8')
  assert.deepEqual(scan({ PATH: dir }), [{ name: 'weather', file: exe }])
  fs.unlinkSync(exe)
  assert.deepEqual(scan({ PATH: dir }), [{ name: 'weather', file: cmd }])
})

test('POSIX 上没 x 位的同名文件不算零件，补上 x 位才出现', posixOnly('Windows 没有可执行位'), () => {
  const dir = tmp()
  const file = makePart(dir, 'weather', 'process.exit(0)', { mode: 0o644 })
  assert.deepEqual(scan({ PATH: dir }), [])
  fs.chmodSync(file, 0o755)
  assert.deepEqual(scan({ PATH: dir }), [{ name: 'weather', file }])
})

test('扫描认 PATH 与 Path 两种拼法，按名字排序，同名只留靠前的目录', () => {
  const a = tmp()
  const b = tmp()
  const zulu = makePart(a, 'zulu', 'process.exit(0)')
  const alpha = makePart(b, 'alpha', 'process.exit(0)')
  makePart(b, 'zulu', 'process.exit(0)') // 重名：靠后的目录不该赢
  fs.mkdirSync(path.join(a, 'agent-man-notafile')) // 同名目录不算零件
  assert.deepEqual(scan({ Path: [a, b].join(path.delimiter) }), [
    { name: 'alpha', file: alpha },
    { name: 'zulu', file: zulu },
  ])
})

// ---------------------------------------------------------------- describe

test('describe 只在 --describe 给出五个字段齐全的 JSON 时 ok', async () => {
  const dir = tmp()
  const fields = "{name:'weather',desc:'glance',section:'env',timeout_ms:3000,side_effects:false}"
  const file = makePart(dir, 'weather', says(fields))
  const d = await describe({ name: 'weather', file })
  assert.equal(d.ok, true)
  assert.deepEqual(
    [d.name, d.desc, d.section, d.timeout_ms, d.side_effects],
    ['weather', 'glance', 'env', 3000, false],
  )
})

test('describe 拿到不是 JSON 的输出时返回 ok:false 而不是抛', async () => {
  const dir = tmp()
  const file = makePart(dir, 'broken', "console.log('not json')")
  const d = await describe({ name: 'broken', file })
  assert.equal(d.ok, false)
  assert.match(d.why, /不是 JSON/)
})

test('describe 碰上被截断的 --describe 说"截断"，不把责任推给零件的格式', async () => {
  const dir = tmp()
  const js = says("{name:'big',desc:'x'.repeat(9000),section:'s',timeout_ms:1000,side_effects:[]}")
  const d = await describe({ name: 'big', file: makePart(dir, 'big', js) })
  assert.equal(d.ok, false)
  assert.match(d.why, /截断/)
  assert.doesNotMatch(d.why, /不是 JSON/)
})

test('describe 缺字段时返回 ok:false 并说缺哪个', async () => {
  const dir = tmp()
  const file = makePart(dir, 'half', says("{name:'half',desc:'x',section:'y'}"))
  const d = await describe({ name: 'half', file })
  assert.equal(d.ok, false)
  assert.match(d.why, /timeout_ms/)
})

test('describe 把零件自己报的 timeout_ms 夹在 30 秒上限内，原值留档', async () => {
  const dir = tmp()
  const fields = "{name:'endless',desc:'x',section:'y',timeout_ms:999999,side_effects:true}"
  const d = await describe({ name: 'endless', file: makePart(dir, 'endless', says(fields)) })
  assert.deepEqual([d.ok, d.timeout_ms, d.declared_timeout_ms], [true, 30000, 999999])
})

test('describe 碰上一个起不来的零件也返回 ok:false', async () => {
  const d = await describe({ name: 'ghost', file: path.join(tmp(), 'agent-man-ghost') })
  assert.equal(d.ok, false)
})

// ---------------------------------------------------------------- capture

test('capture 超过 timeout 就杀掉零件，返回 status:timeout', async () => {
  const dir = tmp()
  const file = makePart(dir, 'slow', 'setTimeout(() => {}, 5000)')
  const t0 = Date.now()
  const r = await capture({ name: 'slow', file }, { timeout: 300 })
  const waited = Date.now() - t0
  assert.equal(r.status, 'timeout')
  assert.equal(r.code, null) // 没有退出码这回事，不编一个出来
  assert.ok(waited < 3000, `超时没有硬杀：等了 ${waited}ms`)
})

test('超时在 Windows 上连 cmd.exe 的孙子进程一起杀', winOnly('POSIX 上 .cmd 不是可执行文件'), async () => {
  const dir = tmp()
  const marker = path.join(dir, 'alive.txt').split(path.sep).join('/')
  const js = `setTimeout(() => { require('fs').appendFileSync('${marker}', 'x') }, 1200)`
  const r = await capture({ name: 'escapee', file: makePart(dir, 'escapee', js) }, { timeout: 300 })
  assert.equal(r.status, 'timeout')
  await new Promise((res) => setTimeout(res, 1400)) // 等到它本该写文件的时刻
  assert.equal(fs.existsSync(marker), false, '孙子进程活到了 1.2 秒：只杀了 cmd.exe')
})

test('超时杀树不靠 PATH：PATH 清空后照样按时收手', winOnly('POSIX 走 child.kill'), async () => {
  const dir = tmp()
  // PATH 里只有空目录：cmd.exe 靠 ComSpec 的绝对路径照旧起得来，PATH 里没有 taskkill。
  const empty = path.join(dir, 'empty-path')
  fs.mkdirSync(empty)
  const file = path.join(dir, 'agent-man-hang.cmd')
  // 零件自己也得用绝对路径，否则 cmd.exe 也找不到 node。
  fs.writeFileSync(file, `@${process.execPath} -e "setTimeout(() => {}, 1500)"\r\n`, 'utf8')
  const env = { ...process.env, PATH: empty, Path: empty, ComSpec: process.env.ComSpec }
  const t0 = Date.now()
  const r = await capture({ name: 'hang', file }, { timeout: 300, env })
  assert.equal(r.status, 'timeout')
  assert.ok(Date.now() - t0 < 3000, `PATH 里没有 taskkill 就卡住了：等了 ${Date.now() - t0}ms`)
})

test('capture 的截断落在 UTF-8 边界上，不切出半个汉字', async () => {
  const dir = tmp()
  // 汉 = U+6C49；用码点拼，免得 .cmd 里的汉字被 cmd 的代码页换掉
  const js = 'process.stdout.write(String.fromCharCode(0x6c49).repeat(4000))'
  const r = await capture({ name: 'flood', file: makePart(dir, 'flood', js) }, { limit: 8192 })
  assert.equal(r.status, 'ok')
  assert.equal(r.truncated, true)
  assert.ok(Buffer.byteLength(r.out) <= 8192, `超出上限：${Buffer.byteLength(r.out)}`)
  // 8192 字节装得下 2730 个汉字（8190 字节），第 2731 个只有 2 字节——整字丢掉
  assert.equal(r.out, String.fromCharCode(0x6c49).repeat(2730))
})

test('capture 把 64/75/69 分别折成 usage/timeout/missing，其它非零码才是 crash', async () => {
  const dir = tmp()
  const exits = (code) =>
    capture({ name: `x${code}`, file: makePart(dir, `x${code}`, `process.exit(${code})`) })
  const u = await exits(64)
  assert.deepEqual([u.status, u.code], ['usage', 64]) // 参数错不能算"零件崩了"
  const a = await exits(75)
  assert.deepEqual([a.status, a.code], ['timeout', 75])
  const b = await exits(69)
  assert.deepEqual([b.status, b.code], ['missing', 69])
  const c = await exits(3)
  assert.deepEqual([c.status, c.code], ['crash', 3])
  const d = await exits(0)
  assert.deepEqual([d.status, d.code], ['ok', 0])
})

test('capture 把调用方要的超时夹在 30 秒上限内，不许零件把调用方拴住', async () => {
  const dir = tmp()
  const file = makePart(dir, 'quick', 'process.exit(0)')
  const r = await capture({ name: 'quick', file }, { timeout: 10 * 60 * 1000 })
  assert.deepEqual([r.status, r.timeout], ['ok', 30000])
})

test('capture 拿到 0 / NaN / 负的超时退回默认 5 秒，不当成"立刻超时"', async () => {
  const dir = tmp()
  const file = makePart(dir, 'quick2', 'process.exit(0)')
  for (const given of [0, NaN, -1, undefined]) {
    const r = await capture({ name: 'quick2', file }, { timeout: given })
    assert.equal(r.timeout, 5000, `timeout=${String(given)} 没退回默认值`)
  }
})

test('参数里有 %名字% 时拒收，算调用方的参数错(usage)，不算零件缺了', winOnly('cmd 展开只发生在 Windows'), async () => {
  const dir = tmp()
  const file = makePart(dir, 'echoit', 'console.log(process.argv.slice(2).join())')
  const r = await capture({ name: 'echoit', file }, { args: ['%PATH%'] })
  assert.deepEqual([r.status, r.why], ['usage', '不安全的参数'])
  assert.throws(() => passthrough({ name: 'echoit', file }, ['%PATH%']), /不安全的展开/)
})

test('子串与替换语法也拦：%PATH:~0,5% 与 %COMSPEC:cmd=zzz% 一样会被 cmd 换掉', winOnly('cmd 展开只发生在 Windows'), async () => {
  const dir = tmp()
  const file = makePart(dir, 'echoit2', 'console.log(process.argv.slice(2).join())')
  for (const arg of ['%PATH:~0,5%', '%COMSPEC:cmd=zzz%', '%OS:Windows=xyz%']) {
    const r = await capture({ name: 'echoit2', file }, { args: [arg] })
    assert.deepEqual([r.status, r.why], ['usage', '不安全的参数'], `${arg} 没被拦下`)
  }
})

test('单个 % 不算展开：50% off 50% 这类参数不误拦', winOnly('cmd 展开只发生在 Windows'), async () => {
  const dir = tmp()
  const file = makePart(dir, 'echoit3', `console.log('ok')`)
  for (const arg of ['50%', '50% off 50%', '100%%', '%NOPE']) {
    const r = await capture({ name: 'echoit3', file }, { args: [arg] })
    assert.equal(r.status, 'ok', `${arg} 被误拦：${r.why ?? ''}`)
  }
})

test('capture 碰上一个不存在的文件返回 missing，不抛', async () => {
  const r = await capture({ name: 'ghost', file: path.join(tmp(), 'agent-man-ghost') }, {})
  assert.equal(r.status, 'missing')
})

test('passthrough 把零件的退出码原样交回', () => {
  const dir = tmp()
  const file = makePart(dir, 'seven', 'process.exit(7)')
  assert.equal(passthrough({ name: 'seven', file }, []), 7)
})

// ---------------------------------------------------------------- 失败计数

test('bump 第三次失败把 until 设成 Infinity，blocked 据此判定', () => {
  const start = { fail: 0, until: null }
  const one = bump(start)
  assert.deepEqual(one, { fail: 1, until: null })
  assert.equal(blocked(one, 1000), false)
  const two = bump(one)
  assert.deepEqual(two, { fail: 2, until: null })
  assert.equal(blocked(two, 1000), false)
  const three = bump(two)
  assert.deepEqual(three, { fail: 3, until: Infinity })
  assert.equal(blocked(three, 1000), true)
  assert.deepEqual(bump(three), { fail: 4, until: Infinity }) // 冷却之后还失败，也还是冷却着
  assert.deepEqual(start, { fail: 0, until: null }) // 入参不被改写
})

test('blocked 认时间冷却，也认"下一次会话"哨兵', () => {
  assert.equal(blocked({ fail: 1, until: 5000 }, 4000), true)
  assert.equal(blocked({ fail: 1, until: 5000 }, 5000), false) // 到点就解除
  assert.equal(blocked({ fail: 1, until: null }, 5000), false)
  assert.equal(blocked({ fail: 1, until: Infinity }, 5000), true)
  assert.equal(blocked(undefined, 5000), false)
})

test('冷却到下一次会话的哨兵过一遍 JSON 也不许解除(Infinity 落盘后是 null)', () => {
  const three = bump(bump(bump({ fail: 0, until: null })))
  const persisted = JSON.parse(JSON.stringify(three))
  assert.deepEqual(persisted, { fail: 3, until: null }) // JSON 里没有 Infinity
  assert.equal(blocked(persisted, 1000), true)
})

test('会话开始清零之后冷却真的解除，两次失败不算冷却', () => {
  assert.equal(blocked({ fail: 0, until: null }, 1000), false)
  const two = JSON.parse(JSON.stringify(bump(bump({ fail: 0, until: null }))))
  assert.deepEqual(two, { fail: 2, until: null })
  assert.equal(blocked(two, 1000), false)
})
