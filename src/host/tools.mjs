// 工具层（design §9）：一个写入口、一个读入口。
// 这里只做三件事：声明 schema、校验参数、把调用翻成领域门面的一次函数调用。
// 三件不做：不 spawn 子进程、不 shell、不自己碰存储——写下去的东西必须过领域那条路，
// 否则工具就成了第二份业务与第二份真源（AGENTS 四/五）。
// 参数不合法一律返回 { ok: false, error: '…怎么改' }：不抛、不猜、不补默认值。
import { SECTION_ITEMS_MAX, clock, dayKey, oneLine } from '../core/index.mjs'
import { notes, plans } from '../intent/index.mjs'
import * as memory from '../memory/index.mjs'

// 写：只有这六项。多一项"自由文本入口"就等于绕开结论的证据要求。
export const WRITE_ACTIONS = Object.freeze([
  'event add',
  'memory add',
  'rule add',
  'note add',
  'plan add',
  'self append',
])

// 读：design §9 的 context.show / event.find / memory.show。
export const LOOK_ACTIONS = Object.freeze(['context show', 'event find', 'memory show'])

const WRITE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['action']),
  properties: Object.freeze({
    action: { type: 'string', enum: [...WRITE_ACTIONS], description: '写什么' },
    text: { type: 'string', description: 'event / rule / note / plan 的正文' },
    key: { type: 'string', description: 'memory add 的槽位名：同 key 的旧结论会被这条取代' },
    fact: { type: 'string', description: 'memory add 的结论正文（一句话，不写评价）' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'memory add 的证据：event id 数组（也收逗号分隔的一串）',
    },
    why: { type: 'string', description: 'rule add 的理由：为什么立这条规矩' },
    trigger: { type: 'string', description: 'note add 的触发线索：说到什么时该想起它' },
    due: { type: 'string', description: 'plan add 的时间点：2026-11-20 09:00 / 明天 9:00 / 3d' },
    line: { type: 'string', description: 'self append 要追加的一行' },
    imp: { type: 'integer', minimum: 0, maximum: 3, description: '重要度 0–3' },
    cues: { type: 'array', items: { type: 'string' }, description: 'event add 的线索词' },
    src: { type: 'string', description: 'event add 的来源：user / tool:<名字> / self' },
    ttl: { type: 'string', description: 'note add 的有效期：7d / 12h' },
    at: { type: 'number', description: '记录时刻（epoch ms）；不给就是当下' },
  }),
})

const LOOK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['action']),
  properties: Object.freeze({
    action: { type: 'string', enum: [...LOOK_ACTIONS], description: '看什么' },
    query: { type: 'string', description: 'event find 的字面查询（子串匹配，不做语义检索）' },
    id: { type: 'string', description: 'memory show 的记录 id 或槽位名' },
  }),
})

export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'agent_man',
    description: '把这次会话里值得留的东西写进长期记忆：事件 / 结论 / 规矩 / 便条 / 日程 / 自我块',
    inputSchema: WRITE_SCHEMA,
  }),
  Object.freeze({
    name: 'agent_man_look',
    description: '读已经记下的东西：处境屏 / 字面找事件 / 看一条结论与它的证据',
    inputSchema: LOOK_SCHEMA,
  }),
])

// 每个动作一条规则：缺哪些字段、怎么给、调哪个门面。
// 门面的名字照 design §7 写（memory/events add、memory/rules add、memory/self append）：
// v1 的 memory 门面还没这三条写入，所以拿不到就叫"还没接上"，绝不改个名字硬凑。
const WRITE_RULES = new Map([
  ['event add', {
    need: ['text'],
    hint: 'event add 要 text：一句"发生了什么"，不写评价',
    run: (a, ctx) => {
      const add = fnOf(memory, ['events', 'add'])
      if (add === null) return notWired('memory events add', '记忆车道')
      return add(ctx.home, { ...pick(a, ['text', 'imp', 'cues', 'src']), at: atOf(a, ctx) })
        .then((rec) => `已记下事件 ${labelOf(rec)}`)
    },
  }],
  ['memory add', {
    need: ['key', 'fact'],
    hint: 'memory add 要 key（槽位名）与 fact（一句结论），还要 evidence：先 event add 记下发生过的事',
    check: (a) => {
      const ids = evidenceIds(a.evidence)
      if (ids === null) return 'evidence 只能是 event id 的数组，或逗号分隔的一串 id'
      if (ids.length === 0) return 'memory add 要 evidence：至少 1 个 event id（先 event add 记下发生过的事）'
      return null
    },
    run: async (a, ctx) => {
      const out = await memory.add({
        key: a.key,
        fact: a.fact,
        imp: a.imp,
        evidence: { ids: evidenceIds(a.evidence) },
        at: atOf(a, ctx),
      }, { home: ctx.home, now: ctx.now })
      if (out.status === 'same') return `同样的结论已经在（${out.id}）：没写第二份`
      const replaced = out.replaced.length > 0 ? `，取代了 ${out.replaced.join('、')}` : ''
      return `已记下结论 ${out.id}${replaced}`
    },
  }],
  ['rule add', {
    need: ['text', 'why'],
    hint: 'rule add 要 text（什么规矩）与 why（为什么立它）：没有理由的规矩立不住',
    run: (a, ctx) => {
      const add = fnOf(memory, ['rules', 'add'])
      if (add === null) return notWired('memory rules add', '记忆车道')
      return add(ctx.home, { text: a.text, why: a.why, at: atOf(a, ctx), now: ctx.now })
        .then((rec) => `已立下规矩 ${labelOf(rec)}`)
    },
  }],
  ['note add', {
    need: ['text', 'trigger'],
    hint: 'note add 要 text（记什么）与 trigger（说到什么该想起它）',
    run: async (a, ctx) => {
      const rec = await notes.add(ctx.home, {
        text: a.text,
        trigger: a.trigger,
        ttl: a.ttl,
        now: ctx.now,
      })
      return `已记下便条 ${labelOf(rec)}：说到「${oneLine(a.trigger).trim()}」时该想起它`
    },
  }],
  ['plan add', {
    need: ['text', 'due'],
    hint: 'plan add 要 text 与 due（2026-11-20 09:00 / 明天 9:00 / 3d 都行）',
    run: async (a, ctx) => {
      const rec = await plans.add(ctx.home, { text: a.text, due: a.due, now: ctx.now })
      return `已记下日程 ${labelOf(rec)}：${stampOf(rec.due)}`
    },
  }],
  ['self append', {
    need: ['line'],
    hint: 'self append 要 line：往自我块追加一行（一行一个单位，别写成段落）',
    run: (a, ctx) => {
      const append = fnOf(memory, ['self', 'append'])
      if (append === null) return notWired('memory self append', '记忆车道')
      return append(ctx.home, oneLine(a.line).trim())
        .then(() => '已追加到自我块')
    },
  }],
])

const LOOK_RULES = new Map([
  ['context show', {
    need: [],
    hint: '',
    // 处境屏要的是 mind 算好的快照 + view 的排版，两条车道都还没合并：
    // 在这里自己拼一屏，就等于把 mind 的业务抄进宿主层。
    run: () => notWired('context show', 'mind 车道（situation.build + view.screen.render）'),
  }],
  ['event find', {
    need: ['query'],
    hint: 'event find 要 query：一句要找的字面内容（子串匹配）',
    run: (a, ctx) => {
      const needle = String(a.query).trim().toLowerCase()
      const got = memory.events(ctx.home, {})
      const hits = got.items.filter((rec) => typeof rec.text === 'string'
        && rec.text.toLowerCase().includes(needle))
      const kept = hits.slice(-SECTION_ITEMS_MAX)
      const lines = kept.map((rec) => `- ${rec.id} ${stampOf(rec.at)} ${oneLine(rec.text).trim()}`)
      const head = hits.length === 0
        ? `没有含「${String(a.query).trim()}」的事件（读了 ${got.items.length} 条）`
        : `找到 ${hits.length} 条含「${String(a.query).trim()}」的事件（读了 ${got.items.length} 条）`
      const shown = hits.length > kept.length ? `${head}，这里给最近 ${kept.length} 条：` : `${head}：`
      const bad = got.bad > 0 ? `\n! ${got.bad} 行读不出来（坏 JSON 或过不了 schema）` : ''
      return hits.length === 0 ? `${head}${bad}` : `${shown}\n${lines.join('\n')}${bad}`
    },
  }],
  ['memory show', {
    need: ['id'],
    hint: 'memory show 要 id（记录 id，或槽位名：槽位有多条活记录时会报冲突）',
    run: (a, ctx) => {
      const one = memory.show(String(a.id).trim(), { home: ctx.home, now: ctx.now })
      const rec = one.record
      if (rec === null) return `没找到「${String(a.id).trim()}」：要么 id/槽位打错了，要么它已经失效`
      const life = rec.to === null || rec.to === undefined ? '活' : `已失效（${stampOf(rec.to)} 被 ${rec.by}）`
      const found = one.evidence.map((x) => (x.found ? x.id : `${x.id}（找不到）`))
      return [
        `${rec.id} · ${rec.key} · ${stampOf(rec.at)} · ${life}`,
        `  ${oneLine(rec.fact).trim()}`,
        `  证据：${found.length > 0 ? found.join('、') : '（无）'}`,
      ].join('\n')
    },
  }],
])

const SPECS = new Map([
  ['agent_man', WRITE_RULES],
  ['agent_man_look', LOOK_RULES],
])

// callTool(name, args, { home, now, env }) → 一段字（成功）或 { ok: false, error }（不合法）
// env 暂时用不到（配置在宿主侧读完再递进来），签名照任务书留着：工具层不该自己摸环境。
export async function callTool(name, args, ctx = {}) {
  const rules = SPECS.get(name)
  if (!rules) return fail(`不认识的工具「${String(name)}」：只有 agent_man 与 agent_man_look`)
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : null
  if (input === null) {
    return fail(`参数要是对象：{"action":"note add","text":"…","trigger":"…"}；拿到的是 ${describe(args)}`)
  }

  const action = input.action
  const rule = rules.get(action)
  if (!rule) return fail(`action 只能是 ${[...rules.keys()].join(' / ')}；拿到的是 ${describe(action)}`)

  const missing = rule.need.filter((key) => !isFilled(input[key]))
  if (missing.length > 0) return fail(`${action} 缺 ${missing.join('、')}：${rule.hint}`)
  if (rule.check) {
    const bad = rule.check(input)
    if (bad) return fail(bad)
  }
  const badImp = checkImp(input.imp)
  if (badImp) return fail(badImp)

  const where = { home: ctx.home, now: Number.isFinite(ctx.now) ? ctx.now : undefined, env: ctx.env }
  if (typeof where.home !== 'string' || where.home === '') {
    return fail('没有数据目录（home）：宿主没把 home 递进来，写下去会落到不知道哪儿')
  }
  try {
    return await rule.run(input, where)
  } catch (e) {
    // 领域自己抛的话里已经写了怎么改，原样交回，不在这一层改写措辞。
    return fail(messageOf(e))
  }
}

function notWired(what, lane) {
  return fail(`${what} 还没接上：要等${lane}合并后有门面函数；现在写下去等于凭空造记录`)
}

function fail(error) {
  return { ok: false, error }
}

// 门面里按 design §7 的路径取函数：拿不到就返回 null，由调用方说"还没接上"。
function fnOf(ns, path) {
  let cur = ns
  for (const key of path) cur = cur === null || cur === undefined ? undefined : cur[key]
  return typeof cur === 'function' ? cur : null
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

function atOf(a, ctx) {
  return Number.isFinite(a.at) ? a.at : ctx.now
}

function evidenceIds(value) {
  // 没给就是"还没证据"（报缺），给了但形状不对就是"给错了"（报怎么改）——两件事不能混成一句。
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value.every((one) => typeof one === 'string' && one.trim() !== '')
      ? value.map((one) => one.trim())
      : null
  }
  if (typeof value === 'string') {
    const ids = value.split(',').map((one) => one.trim()).filter((one) => one !== '')
    return ids.length === 0 ? null : ids
  }
  return null
}

function checkImp(value) {
  if (value === undefined) return null
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    return `imp 只能是 0–3 的整数；拿到的是 ${describe(value)}`
  }
  return null
}

function isFilled(value) {
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return Number.isFinite(value)
}

function labelOf(rec) {
  return rec && typeof rec.id === 'string' ? rec.id : '（领域没给 id）'
}

function stampOf(ts) {
  if (!Number.isFinite(ts)) return ''
  return `${dayKey(ts)} ${clock(ts)}`
}

function describe(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return `「${value}」`
  if (Array.isArray(value)) return '一个数组'
  if (typeof value === 'object') return '一个对象'
  return String(value)
}

function messageOf(e) {
  return e && e.message ? e.message : String(e)
}
