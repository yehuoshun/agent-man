// 装配（design §9 / §13）：只把"已经算好的块"拼进预算——不读盘、不问钟、不认识 DSH。
// 宿主层分两半的理由就在这一行里：取数那半只有实机跑得起来，装配这半必须能被 node --test 钉住。
import { AFFECT_INJECT_COST, INJECT_BUDGET, cost } from '../core/index.mjs'

// 总装次序固定（design §9：自我 → 处境 → 旧会话回顾）。user 槽位贴在自我后面：
// §15 把它从自我里单列出来（100 cost），但 design 没写它排第几，按"称呼紧跟着身份"放第二。
export const SLOTS = Object.freeze(['soul', 'user', 'situation', 'recall'])

// 块之间空一行（§13 段首标记的习惯）。空行也吃预算（0.56），所以总量按拼好的整串算，
// 不按各块 cost 相加——两块相加漏掉的就是这个缝。
const GAP = '\n\n'

// compose({ blocks, budget }) → { text, used, budget, dropped, warnings }
// blocks: [{ name, text, budget }]，name ∈ SLOTS，budget 是这一块自己的槽位。
// 两条硬承诺：
// 1) 任何一块（超自己槽位 / 超总预算）装不下就整块丢，绝不切半句——切出来的半句比没有更坏；
// 2) used 就是 cost(text)：真跑一遍复核，不拿各块的账本求和冒充（对不上时以真跑的为准）。
export function compose({ blocks, budget } = {}) {
  const cap = finiteOr(budget, INJECT_BUDGET)
  const warnings = []
  const dropped = []
  const named = new Map()

  // 先按名字归槽：次序由 SLOTS 定，不由入参次序定。重复与不认识的都要说出口，不能安静地少一块。
  for (const one of Array.isArray(blocks) ? blocks : []) {
    const name = one && typeof one.name === 'string' ? one.name : ''
    if (!SLOTS.includes(name)) {
      warnings.push(`! 不认识的注入块「${name || '没名字'}」：只认 ${SLOTS.join(' / ')}`)
      dropped.push({ name: name || null, reason: 'unknown' })
      continue
    }
    if (named.has(name)) {
      warnings.push(`! 注入块 ${name} 给了两次：只装第一份，后面的丢掉`)
      dropped.push({ name, reason: 'duplicate' })
      continue
    }
    named.set(name, one)
  }

  const parts = []
  let text = ''
  for (const name of SLOTS) {
    const block = named.get(name)
    if (!block) continue
    // 段内不重排、不改字：只掐掉首尾空白（那是排版，不是内容）。
    const body = typeof block.text === 'string' ? block.text.replace(/^\s+/u, '').replace(/\s+$/u, '') : ''
    // 空块什么都没占：既不算丢，也不该在 dropped 里记一笔。
    if (body === '') continue

    const slot = finiteOr(block.budget, cap)
    const own = cost(body)
    if (own > slot) {
      dropped.push({ name, reason: 'budget', stage: 'slot', used: own, budget: slot })
      warnings.push(`! ${name} 块 ${round(own)} cost 超过它的槽位 ${round(slot)}：整块丢了`)
      continue
    }

    const next = parts.length === 0 ? body : `${text}${GAP}${body}`
    const total = cost(next)
    if (total > cap) {
      dropped.push({ name, reason: 'budget', stage: 'total', used: total, budget: cap })
      warnings.push(`! ${name} 块放不进总预算 ${round(cap)}（加上它要 ${round(total)}）：整块丢了`)
      continue
    }

    parts.push(body)
    text = next
  }

  return { text, used: cost(text), budget: cap, dropped, warnings }
}

// 情绪行（design §14.6）：只出数字、标签与一句机械规则，一个字都不许是"感觉"。
// 数字一律取调用方给的 snapshot（affect/state 算好的），这里只做四舍五入——
// 宿主层自己再算一遍，就等于开了第二个真源，迟早会和 affect show 对不上。
// 形状照 §14.6 的例句：`v=58 e=61 t=43 r=0 · 平淡 · 3 条刺激`，后面接一句调制规则。
export function affectLine(snapshot, opts = {}) {
  if (opts.visible === false) return ''
  const cap = finiteOr(opts.budget, AFFECT_INJECT_COST)
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : null
  if (snap === null) return ''
  const axes = AXES.map((key) => snap[key])
  // 四根轴缺一个就整行不出：半行数字比没有数字更容易被读成"就是这些值"。
  if (axes.some((one) => !Number.isFinite(one))) return ''

  const head = AXES.map((key, i) => `${key}=${Math.round(axes[i])}`).join(' ')
  const mood = typeof snap.mood === 'string' && snap.mood !== '' ? snap.mood : ''
  const stims = Array.isArray(snap.transient) ? snap.transient.length : 0
  const tags = [mood, `${stims} 条刺激`].filter((one) => one !== '').join(' · ')
  const line = tags === '' ? head : `${head} · ${tags}`
  // 一句调制规则，取 §14.5 的第二个口子：状态低就只答不问（不主动加戏）。
  const full = `${line} · v<36 或 e<26 时只答不问`
  if (cost(full) <= cap) return full
  // 规则那句装不下就只留数字：宁可少一句规则，也不超 §14.6 的 80 cost。
  if (cost(line) <= cap) return line
  return ''
}

const AXES = Object.freeze(['v', 'e', 't', 'r'])

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

// 只在警告里用：账本与上屏都按一位小数，浮点尾巴（156.08000000000004）只会让人怀疑算错了。
function round(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
}
