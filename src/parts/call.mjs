// 零件调用：全仓唯一允许 import node:child_process 的地方（AGENTS §四）。
// 两种模式：直通（stdio 全交给零件、退出码原样交回）与捕获（硬超时、截断、退出码归一）。
// 契约见 docs/design.md §8，Windows 上的引号与 %名字% 结论见 docs/decisions.md §32。
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const WIN = process.platform === 'win32'

// 与 design.md §10 同值。core 门面还没落地，先在本目录声明；落地后改成 import ../core/index.mjs。
// 全目录只在这里写一遍数：discover.mjs 从这里 import，免得两处 5000 各自漂移。
export const PART_TIMEOUT = 5000
export const PART_TIMEOUT_MAX = 30000
export const PART_STDOUT_MAX = 8192

// Windows 的 cmd 会把 %名字% 换成环境变量，包在引号里也照换，^% 和 %% 更错（§32 实测四种写法）。
// 所以命中就拒绝，不猜着转义：悄悄改掉调用方给的字符串，比让它看到一句"不安全的参数"危险得多。
const ENV_EXPANSION = /%[A-Za-z_][A-Za-z0-9_]*%/

function unsafeArg(args) {
  if (!WIN) return null
  for (const a of args) if (ENV_EXPANSION.test(a)) return a
  return null
}

// `.cmd`/`.bat` 不能直接 CreateProcess（EINVAL），只能借 cmd.exe；而 Node 默认会给自己传的
// 参数再包一层引号，所以必须 windowsVerbatimArguments：自己拼行、自己加引号。整行外面还要再
// 包一层引号，否则路径里有空格时 /s 会把首尾引号当成外层的、把路径切成两半。
// 这两种写法都实测过，见 docs/decisions.md §32。
function commandOf(file, args, env) {
  const ext = path.extname(file).toLowerCase()
  if (WIN && (ext === '.cmd' || ext === '.bat')) {
    const q = (x) => (/[\s"&|<>^]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)
    const line = [q(file), ...args.map(q)].join(' ')
    return { cmd: env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  return { cmd: file, argv: args, verbatim: false }
}

// 超时要立刻收手，不能等零件自己结束。Windows 上真正的零件是 cmd.exe 的孙子进程：
// child.kill() 只终止 cmd.exe，零件会活下来接着跑（实测：杀掉之后它照样写文件），
// "超时"就成了嘴上说说。taskkill /t 才是整棵树，而且必须在 cmd.exe 还活着的时候发。
// 但 taskkill 是外部程序：它可能根本不在（PATH 被改过、被安全软件挡下），也可能跑起来
// 却办不成事（权限不足、pid 已经没了）。原来这条路径是 fire-and-forget，spawn 出来的
// ChildProcess 没人听它的 'error'，ENOENT 一到就是未处理的 'error' 事件，把整个进程
// 带走——超时保护自己成了崩溃点，还连带丢掉这次调用的结果。两种失败都退回 child.kill()，
// 少杀一棵子树也强过留一个没人管的进程。
function killTree(child) {
  if (!child?.pid) return
  const lastResort = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已经自己退了：不是错误，结果由 close 决定，这里不抢答。
    }
  }
  if (!WIN) return lastResort()
  let killer = null
  try {
    killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    return lastResort()
  }
  if (!killer) return lastResort()
  killer.on('error', lastResort)
  // 退出码非 0 说明它没办成（进程没了、权限不足）：cmd.exe 至少得死。
  killer.on('close', (code) => {
    if (code !== 0) lastResort()
  })
}

// 不主动断开管道的话，万一有孙子进程还攥着写端，我们的句柄不关、事件循环不退出。
function dropPipes(child) {
  try {
    child?.stdout?.destroy()
    child?.stderr?.destroy()
  } catch {}
}

// 截断按 UTF-8 字符边界收尾：把末尾半个多字节字符整个丢掉。
// 不这么做，out 尾部会是一个 U+FFFD，8KB 的预算就花在一个读不出来的方块上。
function trimPartial(buf) {
  let i = buf.length - 1
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) i-- // 跳过续字节，找到最后一个字符的首字节
  if (i < 0) return buf
  const lead = buf[i]
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buf.length - i >= need ? buf : buf.subarray(0, i)
}

// 一个上限固定的字节水槽：超过上限就丢，并记下"丢过"。丢的只是预算外的部分，
// 所以只标 truncated，不假装还完整。
function sink(cap) {
  const chunks = []
  let size = 0
  let over = false
  return {
    push(chunk) {
      if (size >= cap) {
        over = true
        return
      }
      const room = cap - size
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        over = true
      } else {
        chunks.push(chunk)
      }
      size += Math.min(chunk.length, room)
    },
    text() {
      const buf = Buffer.concat(chunks)
      return (over ? trimPartial(buf) : buf).toString('utf8')
    },
    get over() {
      return over
    },
  }
}

// 上限要夹在真正计时的地方，不能只夹 --describe 回包里那个数：§8 说的是"骨架强制超时"，
// 那对零件自己报的数、对调用方随手给的数都得成立。0 / NaN / 负数不当成"立刻超时"，
// 退回默认值——1ms 的超时是个没人想要的答案。
function deadline(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return PART_TIMEOUT
  return Math.min(ms, PART_TIMEOUT_MAX)
}

// 契约（§8）的四个退出码各自成一个 status：0 成功、64 参数错、69 依赖缺失、75 超时。
// 64 必须单独站出来——参数错是调用方写错了参数，§8 里"摘掉能力/连续失败冷却"针对的是
// 崩溃、超时、缺失这三类；把参数错折成 crash 或 missing，等于让人写错三次参数就把一个
// 好零件白白冷却掉，屏上还会多一行"这个能力不可用"的假降级说明。
function classify(code) {
  if (code === 0) return 'ok'
  if (code === 64) return 'usage'
  if (code === 75) return 'timeout'
  if (code === 69) return 'missing'
  return 'crash'
}

// 直通：stdio 全 inherit，退出码原样交回。参数不安全时抛（本函数只回一个数字，没有
// 第二个口子说明为什么），由 CLI 转成用法错误。
export function passthrough(part, args = [], env = process.env) {
  const argv = [...args].map(String)
  const bad = unsafeArg(argv)
  if (bad) throw new Error(`零件参数里有不安全的展开 ${bad}：Windows 上 cmd 会把它换成环境变量`)
  const { cmd, argv: line, verbatim } = commandOf(part.file, argv, env)
  const r = spawnSync(cmd, line, {
    stdio: 'inherit',
    env,
    windowsVerbatimArguments: verbatim,
    windowsHide: true,
  })
  if (r.error) {
    const who = part.name ?? path.basename(part.file)
    throw new Error(`零件 ${who} 起不来：${r.error.code ?? r.error.message}`)
  }
  // 被信号打断拿不到退出码，统一按 128 记（§32）；空退出码对调用方没有意义。
  return r.signal ? 128 : (r.status ?? 1)
}

// 捕获：返回 {status, code, out, err, truncated, timeout}，永不抛。timeout 是实际生效的期限
// （夹过上限之后的），调用方和 whyNot 都该按这个数说，而不是按它请求的那个数说。
// status 只有五个值：ok / usage（参数错）/ timeout / missing / crash。上游要照 §8 决定
// 摘不摘这个能力，就得看得出这五者的区别。
// 异步是因为超时必须在计时到点那一刻杀树——spawnSync 的超时杀掉 cmd.exe 之后就轮不到
// 我们动手了，孙子进程会漏网（见 killTree 的注释）。
// 第三个参数 env 是 design §7 的写法，{env} 是调用方更顺手的写法，两个都收。
export function capture(part, opts = {}, legacyEnv) {
  const o = opts ?? {}
  const env = o.env ?? legacyEnv ?? process.env
  const args = (Array.isArray(o.args) ? o.args : []).map(String)
  const timeout = deadline(o.timeout)
  const limit = Number.isFinite(o.limit) && o.limit >= 0 ? o.limit : PART_STDOUT_MAX
  const out = sink(limit)
  const err = sink(limit)

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (patch) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        status: 'crash',
        code: null,
        out: out.text(),
        err: err.text(),
        truncated: out.over || err.over,
        timeout,
        ...patch,
      })
    }

    try {
      if (!part?.file) return finish({ status: 'missing', why: '没有可执行文件' })
      // 参数不安全也是调用方的错（同 64），不是零件没装：报 usage，别让它进冷却计数。
      if (unsafeArg(args)) return finish({ status: 'usage', why: '不安全的参数' })
      const { cmd, argv, verbatim } = commandOf(part.file, args, env)
      const child = spawn(cmd, argv, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: verbatim,
        windowsHide: true,
      })
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      child.on('error', (e) => {
        // 起不来（ENOENT/EACCES）算"缺失"：零件没装或没 x 位，不是它崩了。
        const missing = e.code === 'ENOENT' || e.code === 'EACCES'
        finish({ status: missing ? 'missing' : 'crash', why: `起不来：${e.code ?? e.message}` })
      })
      child.on('close', (code, signal) => {
        const c = signal ? 128 : (code ?? 128)
        const patch = { status: classify(c), code: c }
        if (signal) patch.why = `被信号 ${signal} 打断`
        finish(patch)
      })
      timer = setTimeout(() => {
        killTree(child)
        dropPipes(child)
        // code 留空：没有退出码这回事，编一个 124 出来只会和真退出码混在一起。
        finish({ status: 'timeout', code: null })
      }, timeout)
    } catch (e) {
      finish({ status: 'crash', why: String(e?.message ?? e) })
    }
  })
}
