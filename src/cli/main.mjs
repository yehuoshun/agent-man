// CLI 门面：认出命令行长什么样、把参数交给 registry、把退出码交回去。
// 这里不判断业务（该不该说话、分数怎么算、记忆怎么改都在领域模块里），也不读写任何数据。
import { plugin, resolve } from './registry.mjs'

// 帮助只列**已经接上**的命令：写了却打不通的用法，比不写更误导人。
// rule / self / context cue 要等 mind、rules 两条车道合并，接上那天再往这里加一行。
const USAGE = [
  'agent-man —— 会话之外的那一层：记忆、处境、该不该开口',
  '',
  '  agent-man                        处境屏（≡ context show，只读）',
  '  agent-man event  add "…" [--imp 0-3] [--cue 她,加班] [--src user|tool:名字|self]',
  '  agent-man event  ls | find [--since …] [--until …] [--all] [--limit N]',
  '  agent-man memory add "<事实>" --key <槽位> --from <事件id,…> [--imp 0-3]',
  '  agent-man memory ls | find | show <id|槽位> | revise <id> "<新事实>"',
  '  agent-man note   add "<话>" --trigger "<什么时候>" [--ttl 7d]  ·  note ls | take <id>',
  '  agent-man plan   add "<事>" --at "<什么时候>"  ·  plan done <id>  ·  plan ls',
  '  agent-man affect show | set <标签|数值> [--for 2h] [--why "…"] | clear | why | stim <kind>',
  '  agent-man context show | digest [--budget 1200] [--due] [--out 文件] | sense',
  '  agent-man audit  trace [--limit N] | timeline [--limit N] [--all] | orphan',
  '  agent-man soul   ls | use <名字> | show | check | import <卡文件>',
  '  agent-man config  path | show | get <a.b> | set <a.b> <值> | reset [<a.b>]',
  '  agent-man doctor',
  '  agent-man <其它名字> …            PATH 上的 agent-man-<名字>（插件直通）',
  '',
  '读命令都支持 --json；stdout 只放结果，stderr 只放 "! " 开头的警告。',
  '退出码：0 有话/成功 · 1 不说或数据不合格 · 2 用法或数据错。',
]

// 时间只在这里定一次（design §5）：之后的每一步都只认这个数字，
// 不再有人偷偷问 Date.now()，用例传死 now 就能把"今天"钉住。
function clockOf(ctx) {
  return typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? Date.now())
}

export async function main(argv, ctx = {}) {
  const env = ctx.env ?? process.env
  const out = ctx.out ?? ((line) => process.stdout.write(line))
  const err = ctx.err ?? ((line) => process.stderr.write(line))
  const args = Array.isArray(argv) ? argv.slice() : []
  const now = clockOf(ctx)

  // 帮助先于一切：`agent-man memory add --help` 也该看到用法，而不是"参数错"。
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    out(`${USAGE.join('\n')}\n`)
    return 0
  }

  // 不带参就是处境屏（design §6）：不另造一条"什么都没给"的分支。
  const found = args.length === 0 ? resolve(['context', 'show']) : resolve(args)
  if (!found) {
    if (args[0].startsWith('--')) {
      err(`! 不认识的开关：${args[0]}（打 agent-man --help 看有哪些命令）\n`)
      return 2
    }
    return await plugin(args[0], args.slice(1), { env, out, err, now })
  }
  return await found.handler({ env, out, err, now, argv: args, name: found.name, rest: found.args })
}
