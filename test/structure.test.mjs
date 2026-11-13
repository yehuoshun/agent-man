import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { main } from '../src/cli/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 只扫代码：Markdown 里写着 fetch 加左括号、子进程模块这些词是在讲规矩，不是在调用；
// 扫进来会让用例自己判自己（AGENTS 三）。
const CODE_EXT = new Set(['.mjs', '.js', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'tmp', 'dist', 'out'])

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/')
}

function codeFiles(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // 跳过 .git 这类点目录：里面没有我们的代码，走进去只是慢。
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      codeFiles(path.join(dir, entry.name), acc)
    } else if (CODE_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(dir, entry.name))
    }
  }
  return acc
}

// design §7 把 src/ 与 dsh/ 下面每一层都算模块目录，门面 index.mjs 是唯一的对外入口。
// 两个根不算（design 没给 src/index.mjs 这个文件）；dsh/locale/ 是文案、bin/ 是薄壳，
// 都不按模块目录要求门面。
function moduleDirs() {
  const acc = []
  const descend = (abs, base) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relDir = `${base}/${entry.name}`
      if (relDir === 'dsh/locale') continue
      acc.push(relDir)
      descend(path.join(abs, entry.name), relDir)
    }
  }
  for (const base of ['src', 'dsh']) descend(path.join(ROOT, base), base)
  return acc
}

test('src/ 与 dsh/ 下每个目录都有 index.mjs 门面，且门面之外不超过 5 个文件', () => {
  const dirs = moduleDirs()
  // 一个目录都没扫到还叫绿，等于用例根本没跑：先证明真扫到了东西。
  assert.ok(dirs.includes('src/cli') && dirs.includes('src/store'), `只扫到：${dirs.join('、')}`)
  for (const dir of dirs) {
    const entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    const files = entries.filter((e) => e.isFile()).map((e) => e.name)
    assert.ok(files.includes('index.mjs'), `${dir} 缺 index.mjs：跨目录只准 import 门面`)
    const others = files.filter((f) => f !== 'index.mjs')
    assert.ok(others.length <= 5, `${dir} 门面之外有 ${others.length} 个文件：${others.join('、')}；上限 5`)
  }
})

// 相对 import 只有两种合法形态：同目录直接引文件、跨目录引目标目录的 index.mjs。
// 深挖（../store/schema.mjs）会把"谁能读什么"藏进文件路径，门面就白立了（AGENTS 四）。
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

test('相对 import 只在同目录内直接引文件，跨目录一律指向 index.mjs', () => {
  let checked = 0
  for (const file of codeFiles()) {
    const from = rel(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPEC_RE)) {
      const spec = match[1]
      if (!spec.startsWith('.')) continue
      checked += 1
      const target = path.resolve(path.dirname(file), spec)
      assert.ok(fs.existsSync(target), `${from} 引了不存在的文件：${spec}`)
      if (path.dirname(target) !== path.dirname(file)) {
        assert.ok(spec.endsWith('/index.mjs'), `${from} 跨目录引了 ${spec}：跨目录只能指向 index.mjs`)
      }
    }
  }
  assert.ok(checked > 0, '一条相对 import 都没扫到：多半是解析器错了，用例在假绿')
})

// 这两条禁用词在用例里不写成字面量：本文件也在被扫的名单里，写全了会抓到自己。
// fetch 用正则避开左括号，子进程模块的 "node:" 前缀拼出来。
const FETCH_CALL = /\bfetch\s*\(/
const CHILD_PROCESS = ['node', 'child_process'].join(':')

test(`全仓不出现 fetch 调用；${CHILD_PROCESS} 只留给 src/parts/call.mjs`, () => {
  // M6 之前 src/parts/call.mjs 还不存在，所以下面那条豁免等于"全仓为空"。
  for (const file of codeFiles()) {
    const from = rel(file)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(FETCH_CALL.test(text), false, `${from} 里出现了 fetch 调用：本项目不联网（design §8）`)
    if (from === 'src/parts/call.mjs') continue
    assert.equal(text.includes(CHILD_PROCESS), false, `${from} 引了 ${CHILD_PROCESS}：只许在 src/parts/call.mjs`)
  }
})

// doctor 是 M0 唯一真跑的命令：验收就是"它不抛、退出码只可能是 0 或 1"。
test('doctor 在空数据目录上不抛异常，退出码只可能是 0 或 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    const out = []
    const err = []
    const code = await main(['doctor'], {
      env: { AGENT_MAN_HOME: dir },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      now: 1763043120000,
    })
    assert.ok(code === 0 || code === 1, `doctor 退出码是 ${String(code)}：只允许 0 或 1`)
    assert.ok(out.join('').includes(dir), '输出里没写数据目录路径：就看不出它查的是哪儿')
    // 空目录必须把"缺什么"说出口，而不是安静地绿（AGENTS 二·2）。
    assert.ok(err.some((line) => line.startsWith('! ')), '空目录上 doctor 应当有 ! 行')
    // 顺带锁住"读命令不写盘"：探针文件要收干净。
    assert.deepEqual(fs.readdirSync(dir), [], 'doctor 在数据目录里留下了东西')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
