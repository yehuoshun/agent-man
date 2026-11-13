// 一屏的成本账：每行先记 LINE_OVERHEAD，再按 core/cost 的权重量字。
// fit 只做夹逼，不做判断——哪条更重是 rank 的结论，这里只回答"装得下多少、装不下怎么说"。
import {
  LINE_OVERHEAD, SECTION_ITEMS_MAX, SECTION_MAX, MIN_KEEP_RATIO, MIN_KEEP_COST,
  cost, cut as coreCut,
} from '../core/index.mjs'
import { atOf, idOf } from './strength.mjs'
import { guarantee } from './pick.mjs'

// 一段正文占多少预算：正文的成本 + 这一行的开销。谁都不许只数字符。
export function costOf(text) {
  return LINE_OVERHEAD + cost(asLine(text))
}

// budget 是这一行的全部额度（含行开销）——所以能写字的地方是 budget - LINE_OVERHEAD。
// 返回 ok:false 时 why 是 '丢'；切过 why 是 '截'；原样装得下 why 是 null。
export function cut(text, budget) {
  const line = asLine(text)
  const full = costOf(line)
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, text: '', cost: 0, cut: false, why: '丢', full }
  }
  if (full <= budget) return { ok: true, text: line, cost: full, cut: false, why: null, full }

  const head = coreCut(line, budget - LINE_OVERHEAD)
  const kept = costOf(head.text)
  // 三条不留的理由：切不动、切完装不下、切完只剩个开头。
  if (!head.cut || kept > budget || kept < full * MIN_KEEP_RATIO || kept < MIN_KEEP_COST) {
    return { ok: false, text: '', cost: 0, cut: false, why: '丢', full }
  }
  return { ok: true, text: head.text, cost: kept, cut: true, why: '截', full }
}

// 夹逼。两遍：
//   A 保底——每段先拿最重的一条、再拿最新的一条，只收整条，不切；
//   B 回填——按调用方给的分数序把剩下的塞进缝里，塞不下才切。
// 丢掉的每一条都进 dropped 并带 reason；放不下 ≠ 没发生。
export function fit(sections, budget) {
  const cap = Number.isFinite(budget) ? Math.max(0, budget) : 0
  const { prepared, dropped } = prepare(sections)
  const kept = new Map()
  let used = 0
  let rows = []

  for (const sec of prepared) {
    let count = 0
    for (const row of guarantee({ name: sec.name, items: sec.rows })) {
      if (count >= sec.floor || count >= sec.max) break
      const whole = costOf(row.text)
      if (used + whole > cap) continue // 整条放不下就往下试；切不切留给 B 决定
      used += whole
      kept.set(row, { row, text: row.text, cost: whole, cut: false })
      rows.push(kept.get(row))
      count += 1
    }
    sec.count = count
  }

  for (const sec of prepared) {
    for (const row of sec.rows) {
      if (kept.has(row)) continue
      if (sec.count >= sec.max) {
        dropped.push(drop(row, sec, 'limit', `这一段已经满 ${SECTION_ITEMS_MAX} 条`))
        continue
      }
      const room = cap - used
      const whole = costOf(row.text)
      if (whole <= room) {
        used += whole
        kept.set(row, { row, text: row.text, cost: whole, cut: false })
        rows.push(kept.get(row))
        sec.count += 1
        continue
      }
      const sliced = cut(row.text, room)
      if (!sliced.ok) {
        dropped.push(drop(row, sec, 'budget', `预算不够：要 ${round(whole)}，只剩 ${round(room)}，切到句末也留不住`))
        continue
      }
      used += sliced.cost
      kept.set(row, { row, text: sliced.text, cost: sliced.cost, cut: true })
      rows.push(kept.get(row))
      sec.count += 1
    }
  }

  // 输出次序与输入次序一致：段按传入顺序，段内按调用方的分数序——不受"先保底后回填"影响。
  rows.sort((a, b) => a.row.sec.order - b.row.sec.order || a.row.idx - b.row.idx)
  return {
    kept: rows.map(({ row, text, cost: c, cut: wasCut }) => ({
      id: row.id,
      section: row.sec.name,
      text,
      cost: c,
      cut: wasCut,
      truncated: wasCut,
      why: wasCut ? '截' : null,
    })),
    dropped,
    cost: used,
  }
}

function prepare(sections) {
  const list = Array.isArray(sections) ? sections : []
  const prepared = []
  const dropped = []
  const seen = new Set()

  list.forEach((section, order) => {
    const name = typeof section?.name === 'string' && section.name ? section.name : `段${order + 1}`
    const items = Array.isArray(section?.items) ? section.items : []
    if (order >= SECTION_MAX) {
      const why = `丢：一屏最多 ${SECTION_MAX} 段`
      for (const item of items) dropped.push({ id: idOf(item) || null, section: name, why, reason: 'limit' })
      return
    }
    const rows = []
    items.forEach((item, idx) => {
      const id = idOf(item)
      if (typeof id !== 'string' || id === '') {
        dropped.push({ id: null, section: name, why: '丢：记录没有 id，丢的是哪条都说不清', reason: 'invalid' })
        return
      }
      if (seen.has(id)) {
        dropped.push({ id, section: name, why: '丢：同一条记录出现了两次', reason: 'dup' })
        return
      }
      seen.add(id)
      const text = asLine(item?.text ?? item?.fact)
      if (text === '') {
        dropped.push({ id, section: name, why: '丢：记录没有正文', reason: 'invalid' })
        return
      }
      rows.push({ rec: item, id, text, at: atOf(item), idx, sec: null })
    })
    const max = capOf(section?.max)
    const sec = { name, order, rows, max, floor: Math.min(floorOf(section?.min), max), count: 0 }
    for (const row of rows) row.sec = sec
    prepared.push(sec)
  })
  return { prepared, dropped }
}

// min 是下限不是保证：预算不够时保底也会落空，落空的理由照记（总比悄悄少一条强）。
function floorOf(min) {
  if (!Number.isFinite(min)) return 2
  return Math.max(0, Math.trunc(min))
}

function capOf(max) {
  if (!Number.isFinite(max)) return SECTION_ITEMS_MAX
  return Math.min(SECTION_ITEMS_MAX, Math.max(0, Math.trunc(max)))
}

function drop(row, sec, reason, why) {
  return { id: row.id, section: sec.name, why: `丢：${why}`, reason }
}

function round(x) {
  return Math.round(x * 100) / 100
}

function asLine(s) {
  if (typeof s === 'string') return s
  return s === undefined || s === null ? '' : String(s)
}
