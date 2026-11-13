// 设计里的常数表是给人看的唯一清单；它一旦和 core/const.mjs 漂开，
// 后面每个"照设计实现"的人都会拿错数字。这里只做一件事：表里的名字必须真的存在。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as consts from '../src/core/index.mjs'

const design = readFileSync(new URL('../docs/design.md', import.meta.url), 'utf8')

function section(title) {
  const start = design.indexOf(title)
  assert.ok(start >= 0, `设计里找不到「${title}」`)
  const end = design.indexOf('\n## ', start + title.length)
  return design.slice(start, end < 0 ? design.length : end)
}

function names() {
  const block = section('## 10. 常数表')
  const code = block.slice(block.indexOf('```') + 3, block.lastIndexOf('```'))
  // 一行可能挤好几个常数（`COST_ASCII 0.28   COST_WIDE 1.0`），按"名字 后面跟值"来认。
  return [...code.matchAll(/\b([A-Z][A-Z0-9_]+)\s+[-−]?[\d∞{]/g)].map((m) => m[1])
}

test('§10 常数表里的每个名字在 core 里都有导出', () => {
  const listed = [...new Set(names())]
  assert.ok(listed.length > 40, `只解析出 ${listed.length} 个常数，解析规则大概坏了`)
  const missing = listed.filter((name) => !(name in consts))
  assert.deepEqual(missing, [], `设计里有、代码里没有：${missing.join(', ')}`)
})

test('§10 常数表没有同名两处（抄错数字最常见的方式）', () => {
  const all = names()
  const dup = all.filter((name, i) => all.indexOf(name) !== i)
  assert.deepEqual([...new Set(dup)], [], `常数表里重复出现：${dup.join(', ')}`)
})
