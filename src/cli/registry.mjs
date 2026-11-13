import fs from 'node:fs'
import path from 'node:path'

import { VERSION, checkHome, home } from '../store/index.mjs'

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

// doctor 的职责是把"这里能不能用"讲清楚，不是把环境修好：除了写一次就删的探针文件，
// 它不碰数据。任一项不合格都落一条 "! " 行，并让退出码变成 1（design §6）。
export function doctor(ctx) {
  const dir = home(ctx.env)
  const say = (line) => ctx.out(`${line}\n`)
  const bad = []

  const state = checkHome(dir)
  say('agent-man doctor')
  say(`  数据目录   ${dir}`)
  say(`  schema     ${state.version === null ? '未初始化' : state.version}（要 ${VERSION}）`)
  if (!state.ok) bad.push(state.why)

  // 分片只数文件名：某一行坏了是 digest 与读路径的事，不该让 doctor 打不开目录。
  const shards = countShards(path.join(dir, 'events'))
  if (shards === null) {
    say('  events     0 个分片')
    bad.push(`events/ 不存在或读不动：${path.join(dir, 'events')}`)
  } else {
    say(`  events     ${shards} 个分片`)
  }

  const stateWhy = probeWritable(path.join(dir, 'state'))
  if (stateWhy) bad.push(stateWhy)
  else say('  state/     可写')

  const major = Number(process.versions.node.split('.')[0])
  say(`  node       v${process.versions.node}（主版本 ${major}）`)
  if (!(major >= 20)) bad.push(`Node ${process.versions.node} 太旧：package.json 要求 >= 20`)

  if (bad.length > 0) {
    for (const why of bad) ctx.err(`! ${why}\n`)
    ctx.err(`! ${bad.length} 项不合格：按上面的提示改，或把 AGENT_MAN_HOME 指到别处\n`)
    return 1
  }

  say('  一切就绪')
  return 0
}

function countShards(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length
  } catch {
    return null
  }
}

// 可写性必须真写一次：Windows 上 access(W_OK) 对只读目录照样报"可写"。
// 探针名带 pid，两个 doctor 同时跑也不会删到对方的文件。
function probeWritable(dir) {
  const probe = path.join(dir, `.doctor-${process.pid}.tmp`)
  try {
    fs.writeFileSync(probe, 'ok\n')
    fs.rmSync(probe, { force: true })
    return ''
  } catch (e) {
    if (e && e.code === 'ENOENT') return `state/ 不存在：${dir}`
    return `state/ 不可写：${dir}（${e && e.code ? e.code : String(e)}）`
  }
}
