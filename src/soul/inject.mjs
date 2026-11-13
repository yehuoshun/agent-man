// 预算注入（design §13）：把一张卡装进一屏提示里，装不下就明确地丢。
// 三条承诺在这里落地：
// 1. 装下的总 cost 永不超 budget，也不超各自槽位——放不下就丢，并记进 dropped；
// 2. 不截半句：单位是"一段 / 一条往事 / 一组示范"，要么整条进，要么整条丢；
// 3. `<!-- inferred -->` 标记在读卡时已经剥掉，所以 cost() 量到的字里没有注释（§13.1）。
//
// 顺序照任务书：identity → soul（name 计入 soul 槽位，design §13 的表）→
// lore 里 constant:true 的 → 其余 lore 按 order 降序 → dialogue（从第一组起，丢后面的组）。
import {
  SOUL_DIALOGUE_MAX,
  SOUL_IDENTITY_MAX,
  SOUL_INJECT_COST,
  SOUL_SOUL_MAX,
  cost,
  oneLine,
} from '../core/index.mjs'

import { groups, load } from './card.mjs'

const SEP = '\n'

// 每栏的抬头。一栏只给第一个被留下的单位加抬头——后面几行接着读，不必反复自报家门。
// `[示范]` 是例外：每一组示范单独成行，各自带抬头，丢了一组也读得下去。
const TAG = {
  name: '[称呼] ',
  identity: '[身份] ',
  soul: '[说话] ',
  lore: '[往事] ',
  dialogue: '[示范] ',
}

// 槽位是"一屏里最多给这一栏多少"，不是文件上限（design §13）。
// name 与 soul 共用一个槽位——名字与说话方式本来就该一起被压缩（表里写"计入 soul"）。
// lore 没有自己的槽位，它只跟总预算竞争，用剩下的额度。
const SLOT = {
  identity: SOUL_IDENTITY_MAX,
  soul: SOUL_SOUL_MAX,
  dialogue: SOUL_DIALOGUE_MAX,
  lore: Number.POSITIVE_INFINITY,
}

export function build(home, opts = {}) {
  // 卡不存在就抛：注入一个空块比报错更坏——上层会以为"这个灵魂没有内容"。
  const card = load(home, opts.name)
  const budget = budgetOf(opts.budget)
  // now 留着不动：注入块里没有随时间变的字（时间只影响处境与记忆，那边各自解释）。
  const plan = planOf(card, markSetOf(card))

  const lines = []
  const slots = { identity: [], soul: [], dialogue: [], lore: [] }
  const tagged = new Set()
  const dropped = []
  const inferred = []

  for (const unit of plan) {
    // 前缀算在 cost 里（它就是注入的字），所以先定成最终那一行，再判装不装得下。
    const head = tagged.has(unit.col) ? '' : TAG[unit.col]
    const line = head + unit.text
    const slotLines = slots[unit.slot].concat(line)
    const totalLines = lines.concat(line)

    // 真跑 cost() 复核，不用"估算的累加"：预算是对外承诺，量的必须是最后那份字。
    if (cost(slotLines.join(SEP)) > SLOT[unit.slot] || cost(totalLines.join(SEP)) > budget) {
      dropped.push({ file: unit.file, section: unit.section, reason: 'budget' })
      // dialogue 是最后一段：一组装不下，说明额度已经用完，后面的组不必再试（"丢后面的组"）。
      if (unit.slot === 'dialogue') break
      continue
    }

    slots[unit.slot] = slotLines
    lines.push(line)
    tagged.add(unit.col)
    if (unit.inferred) inferred.push({ file: unit.file, section: unit.section })
  }

  return {
    lines,
    // cost 报的是"这一屏的预算"，不是"用了多少"：调用方拿两个数才知道还剩多少余地。
    cost: budget,
    used: cost(lines.join(SEP)),
    dropped,
    inferred,
    knobs: { ...card.knobs },
  }
}

// 单位清单：一个单位 = 一行 = 一段 / 一条往事 / 一组示范。顺序就是装填顺序。
function planOf(card, marks) {
  const plan = []
  for (const [i, text] of card.cols.identity.paragraphs.entries()) {
    plan.push(unit(card, marks, 'identity', 'identity', `第 ${i + 1} 段`, text))
  }
  // 名字先说"怎么称呼"，再说"怎么说话"：同一句回答里，称呼比语气更靠前。
  for (const [i, text] of card.cols.name.paragraphs.entries()) {
    plan.push(unit(card, marks, 'name', 'soul', `第 ${i + 1} 段`, text))
  }
  for (const [i, text] of card.cols.soul.paragraphs.entries()) {
    plan.push(unit(card, marks, 'soul', 'soul', `第 ${i + 1} 段`, text))
  }

  const lore = card.lore.slice()
  // 常驻条目先装：它们是"永远成立"的前提，剩下的额度才轮到按 key 触发的往事。
  // 组内也按 order 降序（同 order 保持文件里的先后），排序只认数字差。
  const constant = lore.filter((item) => item.constant).sort(byOrder)
  const keyed = lore.filter((item) => !item.constant).sort(byOrder)
  for (const item of constant.concat(keyed)) {
    plan.push({
      col: 'lore',
      slot: 'lore',
      file: 'lore.jsonl',
      section: item.id,
      text: oneLine(expand(item.text, card.name), 0),
      inferred: false,
    })
  }

  for (const group of groups(card.dialogue)) {
    plan.push({
      col: 'dialogue',
      slot: 'dialogue',
      file: 'dialogue.md',
      section: `第 ${group.index} 组`,
      text: demoLine(group, card.name),
      inferred: false,
    })
  }
  return plan
}

function unit(card, marks, col, slot, section, text) {
  return {
    col,
    slot,
    file: `${col}.md`,
    section,
    text: expand(text, card.name),
    inferred: marks.has(`${col}.${section}`),
  }
}

// 一组示范压成一行：轮次之间用 ' → ' 连（docs/soul-example.md §2 的形态）。
// 旁白（没有角色前缀的行）原样放进序列，不硬塞一个"你/我"。
function demoLine(group, name) {
  const turns = group.turns.map((turn) => {
    const text = expand(turn.text, name)
    if (turn.role === 'user') return `你: ${text}`
    if (turn.role === 'char') return `我: ${text}`
    return text
  })
  return turns.join(' → ')
}

// 卡里的占位符要展开：`{{char}}` 是这个灵魂的名字，`{{user}}` 是"你"。
// 卡文件因此可以是可移植的（从别处抄来的卡不必先把占位符改掉）。
function expand(text, name) {
  return String(text)
    .replace(/\{\{\s*char\s*\}\}/gi, name)
    .replace(/\{\{\s*user\s*\}\}/gi, '你')
}

// 哪些段落是推断来的：标记在 paragraphs 里已经清掉，只剩"第 N 段"这类锚点，
// 所以在这儿比锚点，装进去的那些才报出去（没进注入的推断不必念）。
function markSetOf(card) {
  const out = new Set()
  for (const col of ['name', 'identity', 'soul']) {
    for (const mark of card.cols[col].inferred) out.add(`${col}.${mark.section}`)
  }
  return out
}

function byOrder(a, b) {
  return b.order - a.order
}

function budgetOf(value) {
  // 缺省取核心常数（design §10）：本地不许抄数字。
  if (!Number.isFinite(value) || value < 0) return SOUL_INJECT_COST
  return value
}
