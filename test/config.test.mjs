import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { config } from '../src/core/index.mjs'

// 一条用例一个临时目录，收尾交给 t.after：中途断言失败也不留垃圾在 %TEMP%。
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function filePath(dir) {
  return path.join(dir, 'config.json')
}

function writeConfig(dir, body) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`
  fs.writeFileSync(filePath(dir), text, 'utf8')
  return text
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(filePath(dir), 'utf8'))
}

// 记录器：CLI 层的约定是 stdout 只放结果、stderr 只放 "! " 警告，用例直接看这两个数组。
function ctxFor(dir, extraEnv = {}) {
  const out = []
  const err = []
  return {
    out,
    err,
    ctx: {
      env: { AGENT_MAN_HOME: dir, ...extraEnv },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      now: 1763043120000,
    },
  }
}

// 同步/异步都收：抛不出东西本身就是失败，别让 assert.throws 的空返回骗过去。
function failureOf(fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') {
      return value.then(() => assert.fail('应当抛错，却安静地过去了'), (e) => e)
    }
  } catch (e) {
    return e
  }
  assert.fail('应当抛错，却安静地过去了')
}

test('没有 config.json 时一律用默认值，且 load 不写盘', (t) => {
  const dir = home(t)
  const cfg = config.load({ env: {}, homeDir: dir })
  assert.deepEqual(cfg, config.DEFAULTS, '文件不存在就该等于 DEFAULTS')
  assert.deepEqual(config.flat(cfg), config.flat(config.DEFAULTS))
  // 读配置不许有副作用：不然一次 `config show` 就能把文件凭空造出来。
  assert.deepEqual(fs.readdirSync(dir), [], 'load 在数据目录里留下了东西')
})

test('config.json 是坏 JSON 时退 2 并指出文件，不拿一半去跑', async (t) => {
  const dir = home(t)
  writeConfig(dir, '{ "inject": { "total": 1000,')
  const boom = await failureOf(() => config.load({ env: {}, homeDir: dir }))
  assert.equal(boom.code, 2, `坏文件要退 2，拿到 ${boom.code}`)
  assert.ok(boom.msg.includes(filePath(dir)), `报错里没写是哪个文件：${boom.msg}`)
  assert.ok(boom.msg.includes('一半'), `没说清"不会拿一半去跑"：${boom.msg}`)

  const { out, err, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, ['show']), 2)
  assert.deepEqual(out, [], '坏文件时 stdout 什么都不许有')
  assert.ok(err[0].startsWith('! '), `stderr 要以 "! " 开头：${err[0]}`)
})

test('config.json 顶层不是对象（数组、空文件）也算坏，退 2', async (t) => {
  const dir = home(t)
  for (const text of ['[]', '', '"x"', 'null']) {
    writeConfig(dir, text)
    const boom = await failureOf(() => config.load({ env: {}, homeDir: dir }))
    assert.equal(boom.code, 2, `顶层 ${text || '(空)'} 应当退 2`)
  }
})

test('未知配置键退 2，并且报出到底是哪个键', async (t) => {
  const dir = home(t)
  writeConfig(dir, { version: 1, inject: { total: 1000, turbo: 1 } })
  const boom = await failureOf(() => config.load({ env: {}, homeDir: dir }))
  assert.equal(boom.code, 2)
  assert.ok(boom.msg.includes('inject.turbo'), `报错里要有键名：${boom.msg}`)

  // 未知的节也一样：漏一个字母的节名不该被当成"没改过"。
  writeConfig(dir, { version: 1, injection: { total: 1000 } })
  const sec = await failureOf(() => config.load({ env: {}, homeDir: dir }))
  assert.equal(sec.code, 2)
  assert.ok(sec.msg.includes('injection'), `报错里要有节名：${sec.msg}`)
})

test('config set 值越界退 2，一个字节都不写', async (t) => {
  const dir = home(t)
  const { err, ctx } = ctxFor(dir)
  for (const [key, value] of [['parts.stdoutMax', '100'], ['recall.minKeepRatio', '1.5'],
    ['digest.budget', '100'], ['inject.total', 'abc'], ['cue.minGap', '6x']]) {
    assert.equal(await config.run(ctx, ['set', key, value]), 2, `${key}=${value} 应当退 2`)
    assert.ok(err.at(-1).includes(key), `stderr 里要有键名 ${key}：${err.at(-1)}`)
  }
  assert.equal(fs.existsSync(filePath(dir)), false, '值不合法却写出了文件')
})

test('AGENT_MAN_INJECT_TOTAL 能盖掉文件里的 inject.total', (t) => {
  const dir = home(t)
  writeConfig(dir, { version: 1, inject: { total: 1500, soul: 200 } })
  const fromFile = config.load({ env: {}, homeDir: dir })
  assert.equal(fromFile.inject.total, 1500)
  // 三层优先级：默认 1000 ← 文件 1500 ← 环境 1200，环境压在最上面。
  const fromEnv = config.load({ env: { AGENT_MAN_INJECT_TOTAL: '1200' }, homeDir: dir })
  assert.equal(fromEnv.inject.total, 1200)
  assert.equal(fromEnv.inject.soul, 200, '别的键不该被顺手改掉')
})

test('环境变量值非法时退 2，报出变量名而不是只报键名', async (t) => {
  const dir = home(t)
  const boom = await failureOf(() => config.load({
    env: { AGENT_MAN_PARTS_STDOUT_MAX: '100' }, homeDir: dir,
  }))
  assert.equal(boom.code, 2)
  assert.ok(boom.msg.includes('AGENT_MAN_PARTS_STDOUT_MAX'), `报错里要有变量名：${boom.msg}`)
})

test('config reset 把键删回默认，不把默认值抄进文件', async (t) => {
  const dir = home(t)
  const { out, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, ['set', 'inject.total', '1500']), 0)
  assert.deepEqual(readConfig(dir), { version: 1, inject: { total: 1500 } })

  assert.equal(await config.run(ctx, ['reset', 'inject.total']), 0)
  // 删掉覆盖与写入默认值对 load 是一回事，对 `git diff` 不是。
  assert.deepEqual(readConfig(dir), { version: 1 })
  assert.equal(config.load({ env: {}, homeDir: dir }).inject.total, 1000)
  assert.ok(out.join('').includes('inject.total = 1000'), out.join(''))

  assert.equal(await config.run(ctx, ['set', 'parts.failLimit', '9']), 0)
  assert.equal(await config.run(ctx, ['reset']), 0)
  assert.deepEqual(readConfig(dir), { version: 1 }, '全部重置只该留 version')
})

test('config show --json 是扁平的 30 个键，形状与 flat(load) 一致', async (t) => {
  const dir = home(t)
  const { out, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, ['show', '--json']), 0)
  const rows = JSON.parse(out.join(''))
  assert.deepEqual(Object.keys(rows), Object.keys(config.SCHEMA), '--json 的键集合就是白名单')
  assert.deepEqual(rows, config.flat(config.load({ env: {}, homeDir: dir })))
  for (const [key, value] of Object.entries(rows)) {
    const leaked = typeof value === 'object' && !Array.isArray(value)
    assert.equal(leaked, false, `${key} 是嵌套对象：--json 只出扁平键`)
  }
  assert.equal(typeof rows['cue.minGap'], 'number', '时长在 json 里是毫秒数字，不是 "6h"')
  assert.equal(rows['cue.minGap'], 21600000)
})

test('config path 指向数据目录下的 config.json', async (t) => {
  const dir = home(t)
  const { out, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, ['path']), 0)
  assert.equal(out.join(''), `${path.join(dir, 'config.json')}\n`)
  // 不给 homeDir 时认 AGENT_MAN_HOME：这条是 store/paths.mjs 的 home() 同一口径。
  const bare = path.join(dir, 'nested')
  assert.equal(await config.run({ env: { AGENT_MAN_HOME: bare }, out: (s) => out.push(s) }, ['path']), 0)
  assert.equal(out.at(-1), `${path.join(bare, 'config.json')}\n`)
})

test('set 保留文件里其它键，并按白名单顺序补 version 1', async (t) => {
  const dir = home(t)
  writeConfig(dir, { version: 1, parts: { failLimit: 5 }, inject: { total: 1500 } })
  await config.setKey(dir, 'inject.user', '80')
  assert.deepEqual(readConfig(dir), {
    version: 1,
    inject: { total: 1500, user: 80 },
    parts: { failLimit: 5 },
  })
})

test('set 写时长时存人写的原文，load 之后才是毫秒', async (t) => {
  const dir = home(t)
  await config.setKey(dir, 'cue.minGap', '45m')
  assert.equal(readConfig(dir).cue.minGap, '45m', '文件里存原文才看得出人写了什么')
  assert.equal(config.load({ env: {}, homeDir: dir }).cue.minGap, 45 * 60 * 1000)
  assert.equal(config.flat(config.load({ env: {}, homeDir: dir }))['cue.minGap'], 2700000)
})

test('时长键接受 8h / 60d / 数字 ms 三种写法', (t) => {
  const dir = home(t)
  for (const [key, text, ms] of [['moodHalf', '8h', 28800000], ['trustHalf', '60d', 5184000000],
    ['energyHalf', '600000', 600000], ['moodHalf', '90m', 5400000]]) {
    writeConfig(dir, { version: 1, affect: { [key]: text } })
    assert.equal(config.load({ env: {}, homeDir: dir }).affect[key], ms, `${text} 应当读成 ${ms}`)
  }
  writeConfig(dir, { version: 1, affect: { moodHalf: 7200000 } })
  assert.equal(config.load({ env: {}, homeDir: dir }).affect.moodHalf, 7200000, '文件里直接写数字 ms')
})

test('原子写不留 .tmp，落盘内容能被 load 原样读回', async (t) => {
  const dir = home(t)
  await config.setKey(dir, 'soul.current', 'work')
  await config.setKey(dir, 'clock.quiet', '22:30,07:30')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json'])
  const cfg = config.load({ env: {}, homeDir: dir })
  assert.equal(cfg.soul.current, 'work')
  assert.deepEqual(cfg.clock.quiet, ['22:30', '07:30'])
  // 结尾一个换行、两空格缩进：writer 改了格式，git diff 会变得不可读。
  const text = fs.readFileSync(filePath(dir), 'utf8')
  assert.ok(text.endsWith('}\n'), '文件要以换行结尾')
  assert.ok(text.includes('\n  "soul"'), '要两空格缩进')
})

test('坏文件上 set 不许覆盖别人的键', async (t) => {
  const dir = home(t)
  const before = writeConfig(dir, '{ "inject": oops }')
  const boom = await failureOf(() => config.setKey(dir, 'inject.total', '1500'))
  assert.equal(boom.code, 2)
  assert.equal(fs.readFileSync(filePath(dir), 'utf8'), before, '改不动的东西不该被冲掉')
})

test('白名单外的键在 setKey 层就拦下来，并给最近的键名', async (t) => {
  const dir = home(t)
  const boom = await failureOf(() => config.setKey(dir, 'inject.totoal', '1500'))
  assert.equal(boom.code, 2)
  assert.ok(boom.msg.includes('inject.totoal'), boom.msg)
  assert.ok(boom.msg.includes('inject.total'), `应当提示最像的键名：${boom.msg}`)
  assert.equal(fs.existsSync(filePath(dir)), false)
})

test('validate 报出范围与类型问题，但不抛、不擅自改值', () => {
  const report = config.validate({ parts: { stdoutMax: 100 }, recall: { minKeepRatio: 1.5 } })
  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map((one) => one.key).sort(), ['parts.stdoutMax', 'recall.minKeepRatio'])
  assert.ok(report.errors.every((one) => typeof one.msg === 'string' && one.msg.length > 0))
  assert.ok(Array.isArray(report.warnings))
  // 只报告：传进去的对象保持原样，别让校验顺手把值改成默认。
  const cfg = { parts: { stdoutMax: 100 } }
  config.validate(cfg)
  assert.equal(cfg.parts.stdoutMax, 100)
})

test('只改一个键不触发缺键提醒，缺一堆键才提醒（warnings 不是错误）', () => {
  const one = config.validate(config.DEFAULTS)
  assert.deepEqual(one, { ok: true, errors: [], warnings: [] })
  const partial = config.validate({ inject: { total: 1200 } })
  assert.equal(partial.ok, true, '缺键不算错：只写想改的那几条是正常写法')
  assert.ok(partial.warnings.some((w) => w.msg.includes('缺')), JSON.stringify(partial.warnings))
  // 四块之和与 total 对不上：语法没错，但大概率不是人想要的。
  assert.ok(partial.warnings.some((w) => w.key === 'inject.total'), JSON.stringify(partial.warnings))
})

test('DEFAULTS 与 load 的结果都是冻结的，改它不会污染下一份配置', (t) => {
  const dir = home(t)
  assert.equal(Object.isFrozen(config.DEFAULTS), true)
  assert.throws(() => { config.DEFAULTS.inject.total = 1 }, TypeError, '冻结对象应当拒绝赋值')
  const cfg = config.load({ env: {}, homeDir: dir })
  assert.equal(Object.isFrozen(cfg), true)
  assert.throws(() => { cfg.inject.total = 1 }, TypeError)
  // 真跑第二次：前一次的赋值若成功过，这里会看到被改的数字。
  assert.equal(config.load({ env: {}, homeDir: dir }).inject.total, 1000)
})

test('SCHEMA 覆盖 §15.2 的九节，每个默认值本身合法', () => {
  assert.deepEqual(Object.keys(config.DEFAULTS),
    ['clock', 'inject', 'digest', 'recall', 'cue', 'affect', 'soul', 'parts', 'host'])
  assert.deepEqual(Object.keys(config.flat(config.DEFAULTS)), Object.keys(config.SCHEMA))
  const report = config.validate(config.DEFAULTS)
  assert.deepEqual(report.errors, [], 'DEFAULTS 自己必须过校验：默认值写错没人会发现')
  // 每个键都要有 type 与 default：缺一个，show / set / 迁移就各有一套猜法。
  for (const [key, spec] of Object.entries(config.SCHEMA)) {
    assert.ok(spec.type, `${key} 缺 type`)
    assert.ok(Object.hasOwn(spec, 'default'), `${key} 缺 default`)
  }
})

test('config show 文本模式给被覆盖的项打 ~，stdout 里不掺警告', async (t) => {
  const dir = home(t)
  writeConfig(dir, { version: 1, inject: { total: 1500 } })
  const { out, err, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, ['show']), 0)
  const text = out.join('')
  assert.match(text, /^~ inject\.total\s+1500$/m, text)
  assert.match(text, /^ {2}inject\.soul\s+200$/m, '没改过的项前面是空格')
  assert.ok(text.includes('1 项被覆盖'), `末行要报覆盖了几项：${text}`)
  assert.equal(text.includes('! '), false, '标准输出里不许出现警告')
  assert.ok(err.every((line) => line.startsWith('! ')), `stderr 只放 ! 警告：${err.join('')}`)
})

test('config 子命令的用法错误退 2，写清楚怎么改', async (t) => {
  const dir = home(t)
  const { out, err, ctx } = ctxFor(dir)
  assert.equal(await config.run(ctx, []), 2)
  assert.equal(await config.run(ctx, ['nope']), 2)
  assert.equal(await config.run(ctx, ['get']), 2)
  assert.equal(await config.run(ctx, ['get', 'inject.total', 'x']), 2)
  assert.equal(await config.run(ctx, ['set', 'inject.total']), 2)
  assert.equal(await config.run(ctx, ['show', '--json', '-v']), 2)
  assert.deepEqual(out, [], '用法错误不该往 stdout 写东西')
  assert.ok(err.some((line) => line.includes('用法')), err.join(''))
})

test('registry 只递一个 ctx 时（argv 在 ctx 里）也能跑', async (t) => {
  const dir = home(t)
  const out = []
  const env = { AGENT_MAN_HOME: dir }
  const ctx = { env, out: (s) => out.push(s), err: () => {}, argv: ['config', 'path'] }
  assert.equal(await config.run(ctx), 0, 'registry 的 handler 形态：run({ ...ctx, argv })')
  assert.equal(out.join(''), `${path.join(dir, 'config.json')}\n`)
})

test('数据目录还不存在时 config set 顺手建目录，不甩 ENOENT 栈', async (t) => {
  // 新机器上第一条命令常常就是 config set：那时还没有人跑过 ensure()。
  const dir = path.join(home(t), '还没建出来的数据目录')
  const value = await config.setKey(dir, 'clock.dayStart', '03:00')
  assert.equal(value, '03:00')
  assert.equal(readConfig(dir).clock.dayStart, '03:00')
})

test('文件没写 version 时提醒一句，但不擅自改文件', async (t) => {
  const dir = home(t)
  const before = writeConfig(dir, { inject: { total: 1200 } })
  const warned = []
  config.load({ env: {}, homeDir: dir, warn: (msg) => warned.push(msg) })
  assert.ok(warned.some((msg) => msg.includes('version')), JSON.stringify(warned))
  assert.equal(fs.readFileSync(filePath(dir), 'utf8'), before, 'load 不许回写文件')
})
