import { doctor as checkData } from '../audit/index.mjs'
import { config } from '../core/index.mjs'
import * as soulCards from '../soul/index.mjs'
import { home } from '../store/index.mjs'

// 命令表只有一张：命令名 → 处理函数。命令逻辑住领域模块，这里只做取参、调用与渲染，
// 免得 CLI 层再长出一套业务（AGENTS 四）。
// config 自己有渲染（它要打 `~` 提示"这是默认值不是文件里写的"），所以原样递 ctx，不再包一层。
export const TABLE = new Map([
  ['doctor', doctor],
  ['config', (ctx) => config.run(ctx)],
  ['soul', soul],
])

// 两词命令（"memory add"）先按最长匹配试一次，M3 往里加条目时不用改这个函数。
export function resolve(argv) {
  const args = Array.isArray(argv) ? argv : []
  const two = args.slice(0, 2).join(' ')
  if (TABLE.has(two)) return { name: two, handler: TABLE.get(two) }
  if (TABLE.has(args[0])) return { name: args[0], handler: TABLE.get(args[0]) }
  return null
}

// doctor 分两半：七项只读自检住 src/audit/doctor.mjs（它绝不写盘），渲染与退出码在这里。
// 不合格是"这份数据还不能用"，不是"命令打错了"——所以退 1，不退 2（design §6）。
export function doctor(ctx) {
  const dir = home(ctx.env)
  const result = checkData({ home: dir, ctx })

  ctx.out('agent-man doctor\n')
  ctx.out(`  数据目录   ${dir}\n`)
  for (const one of result.checks) {
    ctx.out(`  ${one.ok ? 'ok' : '!!'} ${one.name}  ${one.detail}\n`)
  }

  if (!result.ok) {
    const bad = result.checks.filter((one) => !one.ok).length
    ctx.err(`! ${bad} 项不合格：按上面的提示改，或把 AGENT_MAN_HOME 指到别处\n`)
    return 1
  }
  ctx.out('  一切就绪\n')
  return 0
}

// 灵魂（design §13）：ls / use / show / check / import。卡怎么解析、怎么装进预算都在 src/soul，
// 这里只把结果排成屏。退出码：说不清就是 2；"卡不成立"也是 2（那不是成功，只是有话说）。
async function soul(ctx) {
  const args = ctx.argv.slice(1)
  const sub = args[0]
  const arg = args[1]
  const dir = home(ctx.env)
  try {
    if (sub === 'ls') return soulLs(ctx, dir)
    if (sub === 'use') return await soulUse(ctx, dir, arg)
    if (sub === 'show') return soulShow(ctx, dir, arg)
    if (sub === 'check') return soulCheck(ctx, dir, arg)
    if (sub === 'import') return await soulImport(ctx, dir, arg)
  } catch (e) {
    ctx.err(`! ${e && e.message ? e.message : e}\n`)
    return 2
  }
  ctx.err('! 用法：agent-man soul ls | use <名字> | show [名字] | check [名字] | import <卡文件.json>\n')
  return 2
}

function soulLs(ctx, dir) {
  const items = soulCards.list(dir)
  const now = soulCards.current(dir)
  if (items.length === 0) {
    ctx.out('（还没有灵魂卡：agent-man soul import <卡文件.json>）\n')
    return 0
  }
  for (const one of items) {
    ctx.out(`${one.name === now.name ? '*' : ' '} ${one.name}  ${one.size} B\n`)
  }
  const note = now.by === 'builtin' ? '（内置，没有卡）' : ''
  ctx.out(`当前：${now.name}${note}\n`)
  return 0
}

async function soulUse(ctx, dir, name) {
  if (!name) {
    ctx.err('! 用法：agent-man soul use <名字>\n')
    return 2
  }
  const rec = await soulCards.use(dir, name, { at: ctx.now, by: 'cli' })
  ctx.out(`已切到 ${rec.name}（记忆与事件一个字节没动）\n`)
  return 0
}

// 名字缺省就取当前那张；一张卡都没导入过时 pickName 会把人引到 import，而不是打"没有这个灵魂：default"。
function soulShow(ctx, dir, name) {
  const wanted = pickName(ctx, dir, name)
  if (wanted === null) return 2
  const view = soulCards.build(dir, { name: wanted })
  const k = view.knobs
  ctx.out(`灵魂：${wanted}  旋钮 warm ${sign(k.warm)} / drive ${sign(k.drive)} / sharp ${sign(k.sharp)}\n`)
  ctx.out(`注入 ${tenth(view.used)}/${tenth(view.cost)}：\n`)
  for (const line of view.lines) ctx.out(`  ${line}\n`)
  if (view.dropped.length > 0) {
    ctx.out(`装不下 ${view.dropped.length} 段（槽位与总预算 ${view.cost}）：\n`)
    for (const one of view.dropped) ctx.out(`  ${one.file} ${one.section}\n`)
  }
  if (view.inferred.length > 0) {
    ctx.out(`~ ${view.inferred.length} 处推断：改前先跟人确认（docs/soul-card.md 的规矩）\n`)
  }
  return 0
}

function soulCheck(ctx, dir, name) {
  const wanted = pickName(ctx, dir, name)
  if (wanted === null) return 2
  const result = soulCards.check(dir, wanted)
  for (const one of result.errors) ctx.err(`! ${one}\n`)
  for (const one of result.warnings) ctx.err(one.startsWith('! ') ? `${one}\n` : `! ${one}\n`)
  if (result.inferred.length > 0) {
    ctx.out(`~ ${result.inferred.length} 处推断待确认（soul show 里带 ~ 的段）\n`)
  }
  if (!result.ok) {
    ctx.err(`! 这张卡还不成立（${result.errors.length} 处）：按上面的提示改\n`)
    return 2
  }
  ctx.out(`ok ${wanted}\n`)
  return 0
}

async function soulImport(ctx, dir, file) {
  if (!file) {
    ctx.err('! 用法：agent-man soul import <卡文件.json（角色卡规范 V2 或 V1）>\n')
    return 2
  }
  const result = await soulCards.importCard(dir, file)
  ctx.out(`已导入 ${result.name}（${result.files.length} 个文件，往事 ${result.lore} 条）\n`)
  if (result.source) ctx.out(`来源：${result.source}\n`)
  ctx.out(`下一步：agent-man soul check ${result.name}\n`)
  return 0
}

function sign(value) {
  const n = Number.isFinite(value) ? value : 0
  return n > 0 ? `+${n}` : String(n)
}

// 预算按一位小数上屏：`cost()` 是浮点累加，156.08000000000004 这种尾巴只该留在账本里。
function tenth(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
}

// 没说名字就取当前那张。当前是内置 default（还没 import 过任何卡）时别拿"没有这个灵魂：default"
// 糊人——那句话像是卡被人删了，实际是"你还没导入过"。
function pickName(ctx, dir, name) {
  if (name) return name
  const now = soulCards.current(dir)
  if (now.by === 'builtin') {
    ctx.err('! 还没有灵魂卡：agent-man soul import <卡文件.json>\n')
    return null
  }
  return now.name
}
