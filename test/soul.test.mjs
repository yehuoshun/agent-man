// soul 的用例只钉 design §13 与 §13.1 的几条硬承诺：
// 换卡不动记忆、四栏与示范缺了就拒、超槽位只警告、推断标记不占预算、
// 装不下就整组丢并记账、名字是路径安全的一部分。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cost } from '../src/core/index.mjs'
import { build, check, current, dir, importCard, list, read, stripMarks, use } from '../src/soul/index.mjs'

// 时间一律传死（AGENTS 六）：本地 2026-11-13 15:00。
// 用本地构造函数而不是 '+08:00' 字符串——CI 有纽约时区腿。
const T = new Date(2026, 10, 13, 15, 0).getTime()

async function inHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))
  try {
    return await body(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// 一张"什么都不缺"的卡：四栏齐全、两组示范各有来有回、旋钮都在范围内、带 source。
const BASE = {
  'name.md': '小满。自称"我"，叫对方"你"。\n',
  'identity.md': '我是小满，做运维出身，现在替你盯代码和线上。\n',
  'soul.md': '句子短。先结论，再一句理由。\n不铺垫、不总结。\n',
  'dialogue.md': '<START>\n你: 这个报错怎么修\n我: 把日志第 12 行贴全。\n'
    + '<START>\n你: 你上次说的方案跑不通\n我: 跑不通的是哪一步。\n',
  'card.json': '{"name":"小满","knobs":{"warm":-1,"drive":0,"sharp":1},"source":"手写示例"}\n',
}

function writeCard(home, name, files) {
  const abs = path.join(home, 'soul', name)
  fs.mkdirSync(abs, { recursive: true })
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(abs, file), body)
  return abs
}

// 整棵目录的 sha256（键是相对的 POSIX 路径）：用来锁"切换前后逐字节相同"。
function hashes(root) {
  const out = {}
  const walk = (abs, prefix) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(root, '')
  return out
}

function raw(dirPath, file) {
  return fs.readFileSync(path.join(dirPath, file), 'utf8')
}

test('切换灵魂只写指针：记忆、事件、自我块、情绪日志逐字节不变', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', BASE)
    writeCard(home, '正经', { ...BASE, 'name.md': '正经。\n' })
    fs.mkdirSync(path.join(home, 'events'), { recursive: true })
    fs.mkdirSync(path.join(home, 'state'), { recursive: true })
    const wallet = {
      'memory.jsonl': '{"id":"m1","text":"用户在做 agent-man","at":1}\n',
      'events/2026-11-13.jsonl': '{"id":"e1","text":"跑了 node --test","at":2}\n',
      'self.md': '# 自我\n我写的是零依赖工具。\n',
      'state/affect-2026-11.jsonl': '{"at":3,"joy":0.2}\n',
    }
    for (const [file, body] of Object.entries(wallet)) fs.writeFileSync(path.join(home, file), body)
    const before = hashes(home)

    await use(home, '小满', { at: T, by: 'cli' })
    await use(home, '正经', { at: T, by: 'cli' })

    const after = hashes(home)
    for (const file of Object.keys(wallet)) {
      assert.equal(after[file], before[file], `${file} 被换卡改动了：记忆共用、人设不共用`)
    }
    assert.equal(current(home).name, '正经')
    assert.equal(current(home).at, T)
    assert.equal(current(home).by, 'cli')
  })
})

test('四栏缺哪一栏就拒绝，并且点名缺的是哪一栏', async () => {
  await inHome(async (home) => {
    const good = check(home, '小满') // 先确认这套样例本身是过的
    writeCard(home, '小满', BASE)
    const ok = check(home, '小满')
    assert.deepEqual(ok.errors, [])
    assert.equal(ok.ok, true)

    for (const miss of ['name.md', 'identity.md', 'soul.md', 'dialogue.md']) {
      const files = { ...BASE }
      delete files[miss]
      // 每栏用一个独立的卡名：同一个目录会留下上一轮的栏，缺栏就测不出来了。
      const who = `缺${miss.replace('.md', '')}`
      writeCard(home, who, files)
      const got = check(home, who)
      assert.equal(got.ok, false, `缺 ${miss} 却过了校验`)
      assert.ok(got.errors.some((text) => text.includes(miss)), `errors 没点名 ${miss}`)
    }
    assert.equal(good.ok, false) // 目录还不存在时也只是"不 ok"，不抛
  })
})

test('示范对话少于两组、或有组只有一方说话，都拒绝', async () => {
  await inHome(async (home) => {
    writeCard(home, '一组', { ...BASE, 'dialogue.md': '<START>\n你: 在吗\n我: 在。\n' })
    const one = check(home, '一组')
    assert.equal(one.ok, false)
    assert.ok(one.errors.some((text) => text.includes('两组')))

    writeCard(home, '独白', {
      ...BASE,
      'dialogue.md': '<START>\n你: 在吗\n我: 在。\n<START>\n我: 我先说一句。\n我: 再说一句。\n',
    })
    const solo = check(home, '独白')
    assert.equal(solo.ok, false)
    assert.ok(solo.errors.some((text) => text.includes('第 2 组')))
  })
})

test('超槽位只给警告不拒绝：卡文件可以比槽位长', async () => {
  await inHome(async (home) => {
    writeCard(home, '长', { ...BASE, 'identity.md': `${'我'.repeat(130)}\n` })
    const got = check(home, '长')
    assert.equal(got.ok, true, '超槽位不该让 check 拒绝')
    assert.equal(got.errors.length, 0)
    assert.ok(got.warnings.some((text) => text.includes('identity.md')))
    // 注入时它照样被装到装不下为止，而不是整栏不算。
    const block = build(home, { name: '长', now: T })
    assert.ok(block.used <= block.cost)
  })
})

test('推断标记只留痕不占注入预算：带不带 <!-- inferred --> 成本一样', async () => {
  await inHome(async (home) => {
    writeCard(home, '带标记', { ...BASE, 'soul.md': '句子短。<!-- inferred -->\n' })
    writeCard(home, '没标记', { ...BASE, 'soul.md': '句子短。\n' })

    const marked = build(home, { name: '带标记', now: T })
    const plain = build(home, { name: '没标记', now: T })
    assert.equal(marked.used, plain.used, '注释被算进了预算')
    assert.equal(marked.used, cost(marked.lines.join('\n')))
    assert.ok(marked.lines.every((line) => !line.includes('inferred')), '标记漏进了注入')
    assert.deepEqual(marked.inferred, [{ file: 'soul.md', section: '第 1 段' }])

    const got = check(home, '带标记')
    assert.equal(got.ok, true)
    assert.equal(got.inferred.length, 1)
    assert.equal(got.inferred[0].field, 'soul.第 1 段')
  })
})

test('剥离注释的原文原样返回，标记不再出现在文本里', () => {
  const got = stripMarks('第一句\n第二句<!-- inferred -->\n')
  assert.equal(got.text, '第一句\n第二句\n')
  assert.deepEqual(got.inferred, ['第二句'])
})

test('装不下的示范整组丢掉并记 dropped，不截半句', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', BASE)
    const full = build(home, { name: '小满', budget: 9999, now: T })
    const at = full.lines.findIndex((line) => line.startsWith('[示范] '))
    assert.ok(at > 0, '一组示范都没装上，样例卡不对')

    // 预算刚好够到第一组结束：第二组整组进 dropped。
    const budget = cost(full.lines.slice(0, at + 1).join('\n'))
    const tight = build(home, { name: '小满', budget, now: T })
    assert.equal(tight.lines[at], full.lines[at], '留下的那组被截了半句')
    assert.deepEqual(tight.dropped, [{ file: 'dialogue.md', section: '第 2 组', reason: 'budget' }])
    assert.equal(tight.cost, budget)
    assert.ok(tight.used <= budget)
  })
})

test('总成本永不超预算：放不下就明确地丢', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', BASE)
    const block = build(home, { name: '小满', budget: 30, now: T })
    assert.ok(block.used <= 30, `超了预算：${block.used}`)
    assert.equal(block.used, cost(block.lines.join('\n')))
    assert.ok(block.dropped.length > 0)
    assert.ok(block.dropped.every((one) => one.reason === 'budget'))
  })
})

test('切到不存在的灵魂报错，指针一动不动', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', BASE)
    await assert.rejects(use(home, '没这个', { at: T, by: 'cli' }), /没有这个灵魂/)
    assert.deepEqual(current(home), { name: 'default', at: null, by: 'builtin' })

    await use(home, '小满', { at: T, by: 'cli' })
    await assert.rejects(use(home, '也没这个', { at: T, by: 'cli' }), /没有这个灵魂/)
    assert.equal(current(home).name, '小满')
  })
})

test('导入 CCv2 只把该给模型看的搬进栏，creator_notes 只存档', async () => {
  await inHome(async (home) => {
    const cc = {
      spec: 'chara_card_v2',
      data: {
        name: '测试卡',
        description: '我是测试卡，只会复述。',
        personality: '话少。',
        mes_example: '<START>\n{{char}}: 在。\n{{user}}: 你好\n<START>\n{{user}}: 再说一遍\n{{char}}: 在。',
        creator_notes: '作者备注：这句绝不该进注入',
        tags: ['测试'],
        creator: 'someone',
        character_version: '1.2',
        scenario: '在终端里等你。',
        character_book: {
          entries: [{ keys: ['缓存'], content: '上了缓存就要想失效。', constant: false, insertion_order: 5 }],
        },
      },
    }
    const file = path.join(home, 'cc.json')
    fs.writeFileSync(file, JSON.stringify(cc))
    const got = await importCard(home, file)

    assert.equal(got.name, '测试卡')
    const card = read(home, '测试卡')
    assert.equal(card.identity, '我是测试卡，只会复述。')
    assert.ok(card.soul.includes('话少。'))
    assert.deepEqual(card.knobs, { warm: 0, drive: 0, sharp: 0 })
    assert.ok(card.lore.some((one) => one.constant === true), '场景该成为一条常驻往事')
    assert.ok(card.lore.some((one) => one.keys.includes('缓存')))

    const stored = JSON.parse(raw(got.dir, 'card.json'))
    assert.equal(stored.creator_notes, '作者备注：这句绝不该进注入')
    assert.equal(stored.character_version, '1.2')

    const block = build(home, { name: '测试卡', budget: 9999, now: T })
    assert.ok(!block.lines.join('\n').includes('作者备注'), 'creator_notes 漏进了注入')
    assert.ok(block.lines.some((line) => line.includes('缓存')))
  })
})

test('名字是路径的一部分：空、斜杠、点点、超长都算参数错误', async () => {
  await inHome(async (home) => {
    for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..', 'x'.repeat(33)]) {
      assert.throws(() => dir(home, bad), TypeError, `dir 放过了 ${JSON.stringify(bad)}`)
    }
    assert.throws(() => list(undefined), /数据目录/)
    assert.ok(dir(home, '小满').endsWith(path.join('soul', '小满')))

    await assert.rejects(use(home, 'a/b', { at: T, by: 'cli' }), TypeError)
    const cc = path.join(home, 'cc.json')
    fs.writeFileSync(cc, JSON.stringify({ data: { name: 'a/b', description: 'x' } }))
    await assert.rejects(importCard(home, cc), TypeError)
    assert.deepEqual(list(home), [])
  })
})

test('没有指针时当前灵魂是内置的 default，且没人会去建这个目录', async () => {
  await inHome(async (home) => {
    assert.deepEqual(current(home), { name: 'default', at: null, by: 'builtin' })
    assert.deepEqual(list(home), [])
    assert.equal(fs.existsSync(path.join(home, 'soul')), false)
  })
})

test('灵魂列表按名字码位序排，不按 locale', async () => {
  await inHome(async (home) => {
    for (const name of ['阿蓝', 'Zed', 'bob']) writeCard(home, name, BASE)
    const names = list(home).map((one) => one.name)
    // 码位序：'Z'(0x5A) < 'b'(0x62) < '阿'(0x963F)
    assert.deepEqual(names, ['Zed', 'bob', '阿蓝'])
    assert.ok(list(home).every((one) => one.size > 0))
  })
})

test('读卡与校验都不写盘', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', BASE)
    const before = hashes(home)
    read(home, '小满')
    check(home, '小满')
    build(home, { name: '小满', now: T })
    assert.deepEqual(hashes(home), before)
  })
})

test('往事装填：常驻的先上，其余按 order 降序', async () => {
  await inHome(async (home) => {
    const lore = [
      { id: 'l-01', keys: [], constant: true, order: 0, share: 1, text: '常驻的事' },
      { id: 'l-02', keys: ['x'], constant: false, order: 1, share: 1, text: '低序的事' },
      { id: 'l-03', keys: ['y'], constant: false, order: 5, share: 1, text: '高序的事' },
    ]
    writeCard(home, '小满', { ...BASE, 'lore.jsonl': lore.map((one) => JSON.stringify(one)).join('\n') })
    const block = build(home, { name: '小满', budget: 9999, now: T })
    const at = (text) => block.lines.findIndex((line) => line.includes(text))
    assert.ok(at('常驻的事') >= 0)
    assert.ok(at('常驻的事') < at('高序的事'), '常驻往事该排在按 key 触发的之前')
    assert.ok(at('高序的事') < at('低序的事'), 'order 降序没生效')
    assert.ok(block.lines[at('常驻的事')].startsWith('[往事] '))
  })
})

test('{{char}} 展开成这张卡的名字，{{user}} 展开成"你"', async () => {
  await inHome(async (home) => {
    writeCard(home, '小满', { ...BASE, 'soul.md': '{{char}} 说话短，叫对方 {{user}}。\n' })
    const block = build(home, { name: '小满', now: T })
    const said = block.lines.find((line) => line.startsWith('[说话] '))
    assert.ok(said.includes('小满 说话短'), said)
    assert.ok(said.includes('叫对方 你'), said)
    assert.ok(!said.includes('{{'))
  })
})
