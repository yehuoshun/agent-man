// 编排（design §5）：选段 → 渲染 → 输出 → seen 记账 → 落账。
// 次序是刻意的：先把屏上的字落定，再记 seen，最后写账本。
// 反过来，一旦 out 写失败，账本上就会留一行"我说了"而屏幕上什么都没有——
// 账本一旦比现实乐观，它就不再是证据了。
import fs from 'node:fs'
import path from 'node:path'

import { writeAtomic } from '../store/index.mjs'

import { build, budgetOf, nowOf, requireHome } from './build.mjs'
import { retell } from './seen.mjs'
import { record } from './trace.mjs'

// run({home,now,budget,out,write,render,say,warn}) → 一次完整的巩固，返回屏上那段字与它背后的账。
// render 由调用方注入（CLI 传 view 的 renderDigest）：digest 依赖 view 是反向依赖（design §7 的方向），
// 而"怎么排字"本来就不是巩固这一层该知道的事。
export async function run(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const cap = budgetOf(opts.budget)
  const render = opts.render
  if (typeof render !== 'function') {
    throw new Error('run 需要一个 render 函数（通常是 view 门面的 renderDigest）：'
      + 'digest 只选段，把字排成什么样归 view')
  }
  const say = typeof opts.say === 'function' ? opts.say : (line) => { process.stdout.write(line) }
  const warn = typeof opts.warn === 'function' ? opts.warn : (line) => { process.stderr.write(line) }

  const built = build({ home: dir, now: at, budget: cap })
  const text = render({
    header: built.header,
    body: built.body,
    stats: { used: built.cost, budget: built.budget, kept: built.kept, dropped: built.dropped },
  })

  const dry = opts.write === false
  const target = typeof opts.out === 'string' && opts.out.trim() !== '' ? opts.out.trim() : null
  const warnings = built.warnings.slice()
  let written = null
  let seen = null
  let traced = null

  if (dry) {
    // --dry-run 一次盘都不摸：预览里写了文件、抬高了 seen，那就不叫预览了。
    warnings.push('! dry-run：只算不落——seen 没 +1，账本没写，out 没动')
    if (target !== null) {
      warnings.push('! dry-run 忽略 out：预览只交到 stdout，免得让人以为已经写了一份')
    }
  } else {
    if (target !== null) written = await writeOut(target, text)
    seen = retell({ home: dir, now: at, ids: built.retell })
    // 没记上的每一条都说出来：seen 少一次不会报错，只会让"我说过几次"慢慢变成假话。
    for (const miss of seen.skipped) warnings.push(`! ${miss.id} 没记进 seen：${miss.why}`)
    for (const miss of seen.failed) warnings.push(`! ${miss.id} 记账失败：${miss.why}`)
    traced = record({
      home: dir,
      now: at,
      budget: built.budget,
      used: built.cost,
      header: built.headerKind,
      kept: built.kept,
      dropped: built.dropped,
    })
  }

  if (target === null) say(`${text}\n`)
  for (const line of warnings) warn(`${line}\n`)

  return { text, built, seen, trace: traced, out: written, wrote: !dry, warnings }
}

// out 的目录不替你建：写到哪儿是调用方的决定，猜错地方再建一串目录，
// 比直接说"这个目录不在"难查得多。
async function writeOut(file, text) {
  const target = path.resolve(file)
  const parent = path.dirname(target)
  if (!fs.existsSync(parent)) {
    throw new Error(`out 的目录不存在：${parent}（不替你创建：写哪儿是调用方的决定）`)
  }
  await writeAtomic(target, `${text}\n`)
  return target
}
