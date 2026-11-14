// DSH 宿主适配（design §9）：首步注入 + 两个工具。
// 这一层只做四件事：读配置、挂生命周期、把取数结果递给 src/host、发警告。
// 业务判断一件都不许写在这里——装什么块由 src/host 决定，写什么由领域门面决定。
import { randomUUID } from 'node:crypto'

import { snapshot as affectSnapshot } from '../src/affect/index.mjs'
import { config, now as nowTs } from '../src/core/index.mjs'
import { affectLine, callTool, compose, recall, TOOLS } from '../src/host/index.mjs'
import { situation } from '../src/mind/index.mjs'
import { renderScreen } from '../src/view/index.mjs'
import { build as buildSoul, current as currentSoul } from '../src/soul/index.mjs'
import { home as homeOf } from '../src/store/index.mjs'
import { extractNeedles, lastUserText, makeSearch } from './search.mjs'

// apply(ctx, options)：options.env / options.warn 只为测试与宿主留口子。
// DSH 没给 logger 的公开形状，警告先走 console.error 的一行 `! …`（与 CLI 的措辞一致）。
export function apply(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') return
  const opts = options && typeof options === 'object' ? options : {}
  // dsh/ 不在结构用例的 process.env 扫描范围内（那条用例只扫 src/），但仍然是"碰环境"的那一半。
  const env = opts.env ?? process.env
  const warn = typeof opts.warn === 'function' ? opts.warn : (line) => console.error(line)

  let cfg = null
  let homeDir = ''
  try {
    cfg = config.load({ env, warn })
    homeDir = homeOf(env)
  } catch (e) {
    // 配置坏了就整层不启用：拿默认值硬跑比不跑更坏（人改了配置却看不出没生效）。
    warn(`! 宿主层这次不启用（${messageOf(e)}）：先修配置或数据目录`)
    return
  }

  const deps = { cfg, homeDir, env, warn, ctx }
  registerTools(deps)

  try {
    ctx.on('agent/created', ({ agent } = {}) => {
      const agentCtx = agent && agent.ctx ? agent.ctx : null
      if (!agentCtx || typeof agentCtx.on !== 'function') return
      const register = () => agentCtx.on('agent/pre-step',
        (payload, next) => preStep(deps, agent, payload, next), { prepend: true })
      // effect 有就挂进作用域（会话结束自动卸），没有就直接注册：两种都得能跑。
      if (typeof agentCtx.effect === 'function') agentCtx.effect(register)
      else register()
    })
  } catch (e) {
    warn(`! 首步注入没挂上（${messageOf(e)}）：这次会话不会注入，工具仍在`)
  }
}

// pre-step：先让宿主算完它的决定（next），再判断要不要在开头插一条。
// 任何异常都不许漏出去——注入失败最多是"这次没注入"，绝不能让会话开不起来。
async function preStep(deps, agent, payload, next) {
  const decision = await next()
  try {
    if (!payload || payload.step !== 1) return decision
    if (payload.signal && payload.signal.aborted) return decision
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const header = headerOf(payload, agent)
    if (!isRoot(header)) return decision

    const at = nowTs()
    const userText = lastUserText(payload.messages) || lastUserText(decision.messages)
    const built = await buildInjection(deps, { header, userText, at })
    for (const line of built.warnings) deps.warn(line)
    if (built.text === '') return decision
    return { ...decision, messages: [injectionMessage(built.text), ...decision.messages] }
  } catch (e) {
    deps.warn(`! 首步注入失败（${messageOf(e)}）：这次不注入`)
    return decision
  }
}

// 取数 + 装配：唯一一处把"环境里的东西"变成"块"的地方。
async function buildInjection(deps, { header, userText, at }) {
  const { cfg, homeDir } = deps
  const warnings = []

  let soul = ''
  // 名字必须由调用方给（soul/inject.build 没有"取当前卡"的默认值），所以先问指针。
  // 指针说"builtin"就是没导入过卡：那是正常状态，注入空着、不报警（空着比编一张假卡诚实）。
  const cur = currentSoul(homeDir)
  if (cur && cur.by !== 'builtin' && typeof cur.name === 'string') {
    try {
      const got = buildSoul(homeDir, { name: cur.name, budget: cfg.inject.soul })
      soul = Array.isArray(got.lines) ? got.lines.join('\n') : ''
    } catch (e) {
      // 指针指着卡但读不出来才是问题：卡坏了或删了，说一句，别让会话以为灵魂还在。
      warnings.push(`! 灵魂卡 ${cur.name} 没读出来（${messageOf(e)}）：这次自我块空着`)
    }
  }

  // 处境块 = 处境正文 + 情绪行（§13）。正文交给 mind 与 view，宿主只负责拼：
  // 抬头那一行是给人看的屏框（"agent-man · 2026-11-13 15:00"），注入里用不上——
  // 时刻已经在正文里说过一次，再说一遍就是花模型的钱复读。
  const situation = situationBlock(deps, at, warnings)

  let recalled = ''
  try {
    const search = searchFor(deps, { header, userText })
    const got = await recall({ search, now: at, budget: cfg.inject.recall })
    recalled = got.text
    for (const line of got.warnings) warnings.push(line)
  } catch (e) {
    warnings.push(`! 旧会话回顾失败（${messageOf(e)}）：这次不回顾`)
  }

  // user 槽位（§15.2 的 100 cost）暂时没有上游：称呼已经由灵魂卡出在 [称呼] 行里，
  // 再在这里编一段画像就是第二份灵魂。空着，等真有画像来源再接。
  const blocks = [
    { name: 'soul', text: soul, budget: cfg.inject.soul },
    { name: 'user', text: '', budget: cfg.inject.user },
    { name: 'situation', text: situation, budget: cfg.inject.situation },
    { name: 'recall', text: recalled, budget: cfg.inject.recall },
  ]
  const out = compose({ blocks, budget: cfg.inject.total })
  for (const line of out.warnings) warnings.push(line)
  return { text: out.text, warnings }
}

function situationBlock(deps, at, warnings) {
  const { cfg, homeDir } = deps
  const parts = []
  try {
    const scene = situation(homeDir, { now: at, cfg })
    const body = renderScreen(scene)
      .split('\n')
      .filter((line, i) => !(i === 0 && line.startsWith('agent-man')))
      .join('\n')
      .trim()
    if (body !== '') parts.push(body)
  } catch (e) {
    // 处境读不出来不该让整个注入消失：灵魂与回顾照发，只少了这一块，并说清为什么。
    warnings.push(`! 处境没算出来（${messageOf(e)}）：这次不带处境`)
  }
  const mood = moodLine(deps, at, warnings)
  if (mood !== '') parts.push(mood)
  return parts.join('\n\n')
}

// 情绪行：数字只从 affect 的快照里取，宿主这一层连加法都不做（§14.6 的口径）。
function moodLine(deps, at, warnings) {
  const { cfg, homeDir } = deps
  try {
    const snap = affectSnapshot(homeDir, { now: at })
    return affectLine(snap, { visible: cfg.affect.visible, budget: cfg.inject.situation })
  } catch (e) {
    warnings.push(`! 情绪快照没读出来（${messageOf(e)}）：这次不带情绪行`)
    return ''
  }
}

// 旧会话回顾的取数：拿不到 sessionQuery、或者这一句里没有可搜的串，就交 null 给 recall
// （它会明确报"没接上"，而不是让模型以为"旧会话里什么都没有"）。
function searchFor(deps, { header, userText }) {
  const sessionQuery = typeof deps.ctx.get === 'function' ? deps.ctx.get('sessionQuery') : null
  const needles = extractNeedles(userText)
  return makeSearch(sessionQuery, {
    needles,
    cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
    exclude: header && typeof header.id === 'string' ? header.id : '',
  })
}

// 两个工具：注册 API 只按任务书给的形状写（ctx.get('tools')?.register?.({name, description,
// inputSchema, handler})）。真实形状没文档，所以这里对"没有 tools 服务"只警告、不猜别名。
function registerTools(deps) {
  const { cfg, homeDir, env, warn, ctx } = deps
  if (cfg.host && cfg.host.tools === false) return
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
  if (!tools || typeof tools.register !== 'function') {
    warn('! 工具没注册：宿主没提供 ctx.get("tools").register（API 形状待定，见交付说明）')
    return
  }
  for (const tool of TOOLS) {
    try {
      tools.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        handler: async (args) => toolText(await callTool(tool.name, args, { home: homeDir, now: nowTs(), env })),
      })
    } catch (e) {
      warn(`! 工具 ${tool.name} 没注册上（${messageOf(e)}）：模型这轮看不到它`)
    }
  }
}

// 工具的返回值该长什么样，DSH 没有公开形状。这一版一律交纯文本：模型读得懂，宿主也不用猜。
// 实机若要求 { content: [{ type: 'text', text }] } 之类，只改这一个函数，业务侧不动。
function toolText(out) {
  if (typeof out === 'string') return out
  if (out && typeof out === 'object' && typeof out.error === 'string') return `! ${out.error}`
  return `! 工具没给出可读结果：${JSON.stringify(out)}`
}

// root 判断照旧实现（code\dsh-agent-man\index.mjs）：root 才注入，子代理不共享记忆。
// 拿不到 header 就不注入——宁可不注入，也不能把主会话的自我块塞进子代理。
function isRoot(header) {
  if (!header || typeof header !== 'object') return false
  const depth = header.delegationDepth
  return header.parentSession == null
    && header.origin !== 'subagent'
    && (depth == null || depth === 0)
    && header.isSeeded !== true
}

// header 出现的位置随宿主版本变：几处常见位置都认，找不到就算了（isRoot 会拒绝）。
function headerOf(payload, agent) {
  const spots = [
    payload && payload.session && payload.session.header,
    payload && payload.header,
    agent && agent.session && agent.session.header,
    agent && agent.header,
  ]
  for (const one of spots) if (one && typeof one === 'object') return one
  return null
}

// 注入消息照旧实现的形状：role=user + source 标记，好让人从 session log 看出这条是谁塞的。
function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-man', version: 1 },
  }
}

function messageOf(e) {
  return e && e.message ? e.message : String(e)
}
