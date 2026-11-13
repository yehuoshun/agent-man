import { resolve } from './registry.mjs'

// 用法写成数据：--help 与"未知命令"的提示共用一份，改命令面时只改这一处。
const USAGE = [
  'agent-man —— 给 LLM agent 的记忆、处境与克制',
  '',
  '用法：',
  '  agent-man doctor     数据目录、schema 与运行环境能不能用',
  '  agent-man config     配置在哪、现在是什么、怎么改（path|show|get|set|reset）',
  '  agent-man soul       灵魂卡：ls | use <名字> | show [名字] | check [名字] | import <卡文件>',
  '  agent-man --help     这一屏',
  '',
  '还没接上（M1–M5）：event / memory / rule / note / plan / self / context / audit',
  '设计见 docs/design.md。',
  '',
].join('\n')

// ctx 是入口唯一能看到环境的地方：env 从这里进，out/err 让用例能接住输出，
// now 让时间可注入——全链路只认数字（AGENTS 二·3）。
export async function main(argv, ctx = {}) {
  const env = ctx.env ?? process.env
  const out = ctx.out ?? ((s) => process.stdout.write(s))
  const err = ctx.err ?? ((s) => process.stderr.write(s))
  const args = Array.isArray(argv) ? argv.slice() : []
  const first = args[0]

  // 无参数是"处境屏"的位置，M5 才接。这里返回 2 而不是 0：空输出不是成功，
  // 别让脚本把"还没做"当成"看过了"。
  if (first === undefined) {
    err('! 处境屏在 M5 接入：现在还没有可显示的处境\n')
    err('! 用法见 agent-man --help\n')
    return 2
  }

  if (first === '--help' || first === '-h' || first === 'help') {
    out(USAGE)
    return 0
  }

  const found = resolve(args)
  if (!found) {
    // 插件直通（design §8）还没接，所以现在不认识的名字一律是打错了，不猜、不兜。
    err(`! 未知命令：${first}\n`)
    err('! 打 agent-man --help 看有哪些命令\n')
    return 2
  }

  const now = typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? Date.now())
  return await found.handler({ env, out, err, now, argv: args })
}
