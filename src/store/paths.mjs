import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 数据目录只有一个来源：AGENT_MAN_HOME，缺省 ~/.agent-man（design §3）。
// 空字符串当没设——Windows 上 `set X=` 会留下空值，不能让 home 变成当前目录。
export function home(env) {
  const override = env && env.AGENT_MAN_HOME
  if (typeof override === 'string' && override.trim() !== '') return override
  return path.join(os.homedir(), '.agent-man')
}

// 只建目录、不建文件：schema.json 由第一次真正写数据的调用者写，
// 免得"看一眼"就把数据目录变成 initialized（AGENTS 五：读命令不写盘）。
export function ensure(homeDir) {
  fs.mkdirSync(path.join(homeDir, 'events'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, 'state', 'ids'), { recursive: true })
  return homeDir
}

// 形参叫 homeDir 不叫 design 表里的 home：同目录还有个 home()，遮住它迟早写错。
// 分片边界就是查询边界，所以文件名只由 ts 决定；用本地时间——"她的一天"不是 UTC 的一天。
export function eventsFile(homeDir, ts) {
  const d = new Date(ts)
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
  return path.join(homeDir, 'events', name)
}

export function stateFile(homeDir, kind, ts) {
  const d = new Date(ts)
  const name = `${kind}-${d.getFullYear()}-${pad(d.getMonth() + 1)}.jsonl`
  return path.join(homeDir, 'state', name)
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}
