// 巩固（design §2）：把窗口内的情景与结论压进一个预算里，并说清每一步丢了什么。
// 这一层只读盘、一行都不写——seen 的 +1 与 trace 落账都在 run 里（design §5：读命令不写盘）。
// 结论走 memory 门面：同一个 id 在 memory.jsonl 里可能有多行（收口是追加副本），
// 直接 readJsonl 会把一条记忆读成几条（design §4 注）。
import {
  DEFAULT_WINDOW_DAYS, DIGEST_BUDGET, SECTION_ITEMS_MAX, clock, cost, dayKey,
  now as coreNow, rel,
} from '../core/index.mjs'
import { events, ls as memoryLs } from '../memory/index.mjs'
import { atOf, fit, idOf, rank, textOf } from '../recall/index.mjs'

// 天→毫秒只是单位换算，不是 §10 的常数：30 天这个数来自 core（design §5）。
const DAY_MS = 24 * 60 * 60 * 1000

// 段的次序、名字、对应的层写在一处：正文标题、抬头里的候选数、"哪条进了哪段"用的是同一份，
// 少写一份就不会出现"'记住的事'里有条情景"这种事。
const SECTIONS = [
  { name: '记住的事', kind: 'memory' },
  { name: '最近', kind: 'event' },
]

const MEMORY = SECTIONS[0].name
const TITLE = '# 我记得的事'

// 抬头的四个形态，信息从多到少（design §4 的账本里 header 记的就是这几个名字，例子里是 "full"）：
// 预算紧时先丢时刻、再丢候选明细、再丢候选数、再丢窗口，最后只剩标题。
// 第五种 "none" 不是形态而是兜底：连标题都装不下时就一个字都不写——预算不可协商。
const FORMS = ['full', 'compact', 'bare', 'title', 'none']

// 屏上那行"丢 M 条（原因…）"是给人也给模型看的，所以 reason 写成人话；
// recall 那边的码（budget/limit/…）留在 code 里，排查时还能对回上游。
const REASONS = new Map([
  ['budget', '预算不够'],
  ['limit', `每段最多 ${SECTION_ITEMS_MAX} 条`],
  ['invalid', '读不懂的行'],
  ['dup', '重复'],
])

// 抬头只写"算之前就知道的事"（窗口、候选条数、此刻）：把这些数塞进抬头会让
// "抬头成本 ← 选了哪些 ← 抬头成本"绕成闭环，而闭环里的每个数都只能是估的。
function headerOf(form, counts) {
  if (form === 'none') return ''
  if (form === 'title') return TITLE
  const scope = `${DEFAULT_WINDOW_DAYS} 天窗口`
  if (form === 'bare') return `${TITLE} · ${scope}`
  if (form === 'compact') return `${TITLE} · ${scope} · 候选 ${counts.total} 条`
  return `${TITLE} · ${scope} · 候选 结论 ${counts.memory} / 情景 ${counts.event} · ${counts.stamp}`
}

// build({home,now,budget}) → 一屏摘要的选段结果，外加"为什么少了东西"的全部理由。
// 纯读：同一个数据目录连调两次，除内存里的对象外什么都不变。
export function build(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  const cap = budgetOf(opts.budget)
  const from = at - DEFAULT_WINDOW_DAYS * DAY_MS

  const scenes = readEvents(dir, at, from)
  const facts = readConclusions(dir, at, from)

  // 先排序再选：rank 只认分数、时间、id 三段，同一批数据换台机器次序也一样（design §5）。
  const ranked = SECTIONS.map((sec) => ({
    ...sec,
    items: rank(sec.kind === 'memory' ? facts.items : scenes.items, { now: at, kind: sec.kind }),
  }))

  const lost = []
  const blocks = []
  for (const sec of ranked) {
    const rows = []
    for (const rec of sec.items) {
      const id = idOf(rec)
      const text = textOf(rec).trim()
      // 正文与 id 在写入时校验过（store/schema、memory/shape），这里再挡一次：
      // 手改过的 JSONL 不归谁管，但一条念不出名字的行不该被悄悄塞进摘要。
      if (id === '' || text === '') {
        lost.push(dropped(id, sec.name, 'invalid', '丢：记录没有 id 或正文'))
        continue
      }
      rows.push(rowOf(sec.name, sec.kind, rec, at, id, text))
    }
    if (rows.length > 0) blocks.push({ name: sec.name, rows })
  }

  const counts = {
    memory: ranked[0].items.length,
    event: ranked[1].items.length,
    total: ranked[0].items.length + ranked[1].items.length,
    stamp: `${dayKey(at)} ${clock(at)}`,
  }
  // 段骨架要占的字：只有真有条目的段才出现在正文里，这一串就是它们的标题与隔行。
  // 拿 cost() 现算而不是"大概几个字"——抬头能升到多高，取决于这里还剩多少。
  const scaffold = cost(blocks.map((block) => `## ${block.name}\n\n`).join(''))

  const picked = pick(blocks, cap, scaffold, counts)
  for (const entry of picked.fitted.dropped) {
    lost.push(dropped(entry.id, entry.section, entry.reason, entry.why))
  }

  const keptIds = new Set(picked.fitted.kept.map((row) => row.id))
  const kept = picked.fitted.kept.map(({ id, section, text, cost: used, cut }) => ({
    id, section, text, cost: used, cut,
  }))

  return {
    header: picked.header,
    headerKind: picked.form,
    body: picked.body,
    sections: blocks.map((block) => {
      const rows = kept.filter((row) => row.section === block.name)
      return {
        name: block.name,
        items: rows.map((row) => row.id),
        cost: rows.reduce((sum, row) => sum + row.cost, 0),
      }
    }),
    kept,
    dropped: lost,
    cost: picked.used,
    used: picked.used, // design §7 的旧名：同一个数，省得上游为一个数字改形状
    budget: cap,
    weakest: weakestOf(ranked, keptIds, lost),
    // 该 +1 seen 的名单：build 只列名单，落账在 run（"复述只发生在一处"，design §5）。
    retell: kept.filter((row) => row.section === MEMORY).map((row) => row.id),
    skipped: scenes.skipped + facts.skipped,
    candidates: { memory: counts.memory, event: counts.event },
    warnings: warnOf(scenes.skipped, facts.skipped),
  }
}

// 抬头从 full 往下降，降到"正文再也装不下更多条"为止：抬头是花边，条目才是内容，
// 为了留住时刻与候选数把一条结论挤掉，是拿内容换装饰。
// 每一步都是真装一遍再拿 cost() 复核整段（不做头部估算），装不下的形态直接出局。
function pick(blocks, cap, scaffold, counts) {
  const sections = blocks.map((block) => ({ name: block.name, items: block.rows }))
  let best = null
  for (const form of FORMS) {
    const header = headerOf(form, counts)
    const headCost = header === '' ? 0 : cost(header) + cost('\n\n')
    const fitted = fit(sections, Math.max(0, cap - headCost - scaffold))
    const body = compose(fitted.kept)
    const text = [header, body].filter((part) => part !== '').join('\n\n')
    const used = cost(text)
    if (used > cap) continue
    // 严格更多才算赢：平手留在更丰满的抬头（FORMS 从 full 往下降，先到先得）。
    if (best === null || fitted.kept.length > best.fitted.kept.length) {
      best = { form, header, body, fitted, used }
    }
  }
  if (best !== null) return best

  // 理论上到不了这里：'none' 不留抬头，正文又被 fit 夹在 cap 之内。
  // 真到了就是预算算错了——那就空着，宁可什么都不说，也不超预算（AGENTS 二·1）。
  const empty = {
    kept: [],
    dropped: blocks.flatMap((block) => block.rows.map((row) => ({
      id: row.id,
      section: block.name,
      reason: 'budget',
      why: '丢：预算连一个字的抬头都装不下',
    }))),
    cost: 0,
  }
  return { form: 'none', header: '', body: '', fitted: empty, used: 0 }
}

// '- ' 前缀写在正文里，不在渲染时再加：fit() 数的是这个字符串的 cost，
// 前缀留在外面就会被预算漏掉 0.56，"装得下"立刻变成一句谎话。
// 情景带相对时间（"刚刚"/"5 小时前"），结论不带：结论是去情境的，加个时间反而把它说回成事件。
function rowOf(section, kind, rec, at, id, text) {
  const when = kind === 'event' ? rel(atOf(rec), at) : ''
  return { id, section, kind, text: when === '' ? `- ${text}` : `- ${when} · ${text}` }
}

// 正文按段的固定次序拼，空段整段不出现：只留标题的空段白占标题与隔行的字。
function compose(kept) {
  const blocks = []
  for (const sec of SECTIONS) {
    const rows = kept.filter((row) => row.section === sec.name)
    if (rows.length === 0) continue
    blocks.push([`## ${sec.name}`, ...rows.map((row) => row.text)].join('\n'))
  }
  return blocks.join('\n\n')
}

// 丢掉的一条：reason 是人话标签，code 是上游的码，why 把"为什么"说成一句完整的话。
function dropped(id, section, code, why) {
  return { id, section, reason: REASONS.get(code) ?? '原因不明', code, why }
}

// "会忘"要看得见（design §5）：最弱的三条连 R 带下场一起报——
// 谁进了摘要、谁因为什么没进，都不留一个孤零零的数字。
function weakestOf(ranked, keptIds, lost) {
  const reasonOf = new Map(lost.map((entry) => [entry.id, entry.reason]))
  const pool = []
  for (const sec of ranked) {
    for (const rec of sec.items) pool.push({ rec, section: sec.name })
  }
  pool.sort((a, b) => a.rec.R - b.rec.R
    || a.rec.at - b.rec.at
    || (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0))
  return pool.slice(0, 3).map(({ rec, section }) => ({
    id: rec.id,
    section,
    text: textOf(rec),
    R: rec.R,
    seen: Number.isFinite(rec.seen) ? rec.seen : 0,
    kept: keptIds.has(rec.id),
    reason: keptIds.has(rec.id) ? null : (reasonOf.get(rec.id) ?? '原因不明'),
  }))
}

// 坏行不抛、也不装作没发生（AGENTS 五）：计数交回调用方，由它写成 "! " 行。
function warnOf(sceneBad, factBad) {
  const total = sceneBad + factBad
  if (total === 0) return []
  return [`! 跳过 ${total} 行读不懂的记录（情景 ${sceneBad} / 结论 ${factBad}）：`
    + '一行坏掉不该让整份记忆读不出来，修好它之前这几条的账是缺的']
}

// 情景与结论都只走 memory 门面：它替我们处理"按日分片跨天合读"、"同 id 多行取最新"、
// "失效版本不出现"与坏行计数。digest 自己 listShards 一遍，等于把分片规则抄第二份。
function readEvents(dir, at, from) {
  const got = events(dir, { from, to: at })
  return { items: got.items, skipped: got.bad ?? 0 }
}

// 结论只走 memory 门面：它替我们处理"同 id 多行取最新"、"失效版本不出现"与坏行计数。
// 窗口只卡下界：记录的 at 是"这条什么时候写下的"，不是"什么时候开始算数"（那是 from）。
// 发号撞了同一毫秒时 add 会把 at 往后挪 1ms，卡上界就会让刚写下的结论在摘要里消失。
function readConclusions(dir, at, from) {
  const got = memoryLs({ since: from }, { home: dir, now: at })
  return { items: got.items, skipped: got.skipped ?? 0 }
}

// home / now / budget 的解析只写这一份：run 与 build 必须同一套口径。
// 抄第二份的后果是"CLI 觉得是 1200、build 觉得是 NaN"，而 NaN 不报错，只会让预算失效。
export function requireHome(home) {
  const dir = typeof home === 'string' ? home.trim() : ''
  if (dir === '') {
    throw new Error('digest 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  }
  return dir
}

export function nowOf(now) {
  if (Number.isFinite(now)) return now
  if (now === undefined || now === null) return coreNow()
  throw new Error(`now 必须是 epoch ms 数字，拿到的是 ${String(now)}：时间只在入口解释一次（AGENTS 二·3）`)
}

export function budgetOf(budget) {
  if (budget === undefined || budget === null) return DIGEST_BUDGET
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(`budget 必须是有限非负数（cost），拿到的是 ${String(budget)}：`
      + '预算不可协商，所以这里不猜一个默认值')
  }
  return budget
}
