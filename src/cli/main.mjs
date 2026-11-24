// CLI 门面：认出命令行长什么样、把参数交给 registry、把退出码交回去。
// 这里不判断业务（该不该说话、分数怎么算、记忆怎么改都在领域模块里），也不读写任何数据。
import { plugin, resolve } from './registry.mjs'

// 帮助只列**已经接上**的命令：写了却打不通的用法，比不写更误导人。
// 用例 `--help 列出的每一项都能被 registry 解析到` 锁着这一点；另一条用例锁"不漏项"：
// 8 个别名、裸资源 = ls、每个读命令认的开关、§16 里明确退 2 的那几个开关，都得在这儿有一行。
const USAGE = [
  'agent-man —— 会话之外的那一层：记忆、处境、该不该开口',
  '',
  '  agent-man                        处境屏（≡ context show，只读）',
  '  agent-man event  add "<发生了什么>" [--imp 0-3] [--cue 她,加班] [--src user|tool:名字|self] [--at …]',
  '  agent-man event  ls | find [--since …] [--until …] [--all] [--limit N]',
  '  agent-man memory add "<事实>" --key <槽位> --from <事件id,…> [--imp 0-3] [--at …]',
  '  agent-man memory ls | find [--key 槽位] [--since …] [--until …] [--all] [--live]',
  '  agent-man memory show <id|槽位> | revise <id> "<新事实>" [--imp 0-3]      （查不到退 1）',
  '  agent-man rule   add "<规矩>" --why "<为什么>" [--supersedes r-…]  ·  rule ls [--all]',
  '  agent-man note   add "<话>" --trigger "<什么时候>" [--ttl 7d] [--at …]  ·  note ls | take|drop <id>',
  '  agent-man plan   add "<事>" --at "<什么时候>"  ·  plan done|drop <id>  ·  plan ls',
  '  agent-man self   show [--all] | set "<整份文本>" | append "<一段话>"',
  '  agent-man affect show [--no-mood] · why [--no-mood] · clear',
  '  agent-man affect set <轴> <数值> [--until …] [--at …] [--why "…"]',
  '  agent-man affect stim <kind> [--why "…"] [--at …]                       情绪只记刺激，不记台词',
  '  agent-man context show | digest [--budget 1200] [--out 文件] [--dry-run] | sense [--budget N]',
  '  agent-man context cue [--min-gap 6h] [--peek] [--why "…"]   此刻要不要开口（不说退 1）',
  '  agent-man audit  trace [--limit N] | timeline [--limit N] [--all] | orphan',
  '  agent-man soul   ls | use <名字> | show [名字] | check [名字] | import <卡文件>',
  '  agent-man config  path | show | get <a.b> | set <a.b> <值> | reset [<a.b>]',
  '  agent-man doctor',
  '  agent-man <其它名字> …            PATH 上的 agent-man-<名字>（零件直通）',
  '',
  '资源不带动作就是 ls：agent-man event ≡ event ls（memory / note / plan / rule / soul 同理）。',
  '别名：log=event add · remember=memory add · leave=note add · digest=context digest',
  '      cue=context cue · find=event find · show=memory show · look=context show',
  '读命令都支持 --json（恰好一行）；stdout 只放结果，stderr 只放 "! " 开头的警告。',
  '零件只能写情景层：event add --src tool:<名字>；结论 / 规矩 / 自我块归本体，零件反调退 2。',
  '还没接：context digest --due · affect stim --imp · memory add|revise --from 日期..日期 · self set --id',
  '        ——给了会退 2，不装作生效。',
  '退出码：0 有话/成功 · 1 不说 / 查不到 / 数据不合格 · 2 用法或数据错。',
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
  // 只给开关也算"没给命令"——`agent-man --json` 就是 `context show --json`；
  // 开关本身合不合法由那条命令自己判，不在这里预先否掉（打错照样退 2，理由更具体）。
  const bare = args.length === 0 || args[0].startsWith('--')
  const found = bare ? resolve(['context', 'show', ...args]) : resolve(args)
  if (!found) {
    if (args.length === 0 || args[0].startsWith('--')) {
      err('! 认不出这条命令（打 agent-man --help 看有哪些命令）\n')
      return 2
    }
    return await plugin(args[0], args.slice(1), { env, out, err, now })
  }
  return await found.handler({ env, out, err, now, argv: args, name: found.name, rest: found.args })
}
