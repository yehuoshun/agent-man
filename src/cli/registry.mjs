import { doctor as checkData } from '../audit/index.mjs'
import { home } from '../store/index.mjs'

// 命令表只有一张：命令名 → 处理函数。命令逻辑住领域模块，这里只做取参、调用与渲染，
// 免得 CLI 层再长出一套业务（AGENTS 四）。
export const TABLE = new Map([['doctor', doctor]])

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
