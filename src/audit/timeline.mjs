// audit timeline（design §6）：情景、结论、规矩、便条、日程按 at 现读现排成一条线。
// 不落盘、不建索引（design §11 的 read-only 账本语义）：每次调用都从分片现读，
// 因为多一份时间线就等于多一份真源（AGENTS 一·不做）——错开一次就再也对不上。
import path from 'node:path'

import { DEFAULT_WINDOW_DAYS, now as coreNow } from '../core/index.mjs'
import * as intent from '../intent/index.mjs'
import * as memory from '../memory/index.mjs'
import { listShards, readJsonl, validate } from '../store/index.mjs'

// 天→毫秒只是单位换算，不是 §10 那种调参常数；30 天这个数只从 core 取。
const DAY_MS = 24 * 60 * 60 * 1000

export function timeline({ home, now, limit, all } = {}) {
  const dir = dataHome(home)
  const base = Number.isFinite(now) ? now : coreNow()
  const full = all === true
  const since = full ? null : base - DEFAULT_WINDOW_DAYS * DAY_MS
  const cap = capOf(limit)
  const entries = []
  let skipped = 0

  // 窗口只有这一个地方说了算：五类记忆走同一条闸。分片按 from 预筛是为了少读文件，
  // 真正决定"进不进来"的是这里。
  const add = (at, kind, id, text) => {
    if (since !== null && at < since) return
    entries.push({ at, kind, id, text })
  }

  // 情景：事件分片按月（design §3），跨月一起读；形状不合法的行读不出正文，计入 skipped。
  const from = since === null ? {} : { from: since }
  for (const file of listShards(dir, 'events', from)) {
    const { items, bad } = readJsonl(file)
    skipped += bad
    for (const rec of items) {
      if (!validate('events', rec).ok) {
        skipped += 1
        continue
      }
      add(rec.at, 'event', rec.id, rec.text)
    }
  }

  // 结论：失效的版本也在时间里留过一笔（to/by 是事后写的，at 没变），所以拿全量含失效。
  // "同一 key 收口成哪条"是 memory 的判断（design §4），这里不重算，只按 id 逐条摆上去。
  const conclusions = memory.ls({ all: true }, { home: dir, now: base })
  skipped += conclusions.skipped
  for (const rec of conclusions.items) add(rec.at, 'memory', rec.id, rec.fact)

  // 规矩没有分片（design §3）：一个文件读到底。旧行永不改写，被 supersedes 的那条照样
  // 留在时间线上——它确实在某天被定下过，把它藏起来才是编故事。
  const rules = readJsonl(path.join(dir, 'rules.jsonl'))
  skipped += rules.bad
  for (const rec of rules.items) {
    if (!validate('rules', rec).ok) {
      skipped += 1
      continue
    }
    add(rec.at, 'rule', rec.id, rec.text)
  }

  // 便条与日程"现在还剩什么"是 intent 折叠出来的（design §4 的 op 流水账）：
  // 这里不重算 take/drop，否则同一条便条会在两个地方有两种活法。
  const notes = intent.notes.list(dir, { now: base })
  skipped += notes.bad
  for (const one of notes.items) add(one.at, 'note', one.id, one.text)

  const plans = intent.plans.list(dir, { now: base })
  skipped += plans.bad
  for (const one of plans.items) add(one.at, 'plan', one.id, one.text)

  // 只认 b.at - a.at 的数字差（AGENTS 五）；同一毫秒按 kind 再按 id 收口，
  // 保证同一份数据读两次给出一模一样的顺序（时间线抖一下，读的人就会以为记忆变了）。
  entries.sort((a, b) => b.at - a.at || byText(a.kind, b.kind) || byText(a.id, b.id))
  const total = entries.length
  return {
    items: cap === null ? entries : entries.slice(0, cap),
    total,
    limit: cap,
    since,
    all: full,
    skipped,
  }
}

function byText(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// limit 缺省就是不截（时间线的条数由窗口决定，不另设一个隐藏上限）。
function capOf(value) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`timeline 的 limit 只能是非负整数，拿到 ${String(value)}（不给就是不截断）`)
  }
  return value
}

function dataHome(home) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('timeline 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  }
  return home.trim()
}
