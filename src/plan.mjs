import { dayKey } from './time.mjs'

/**
 * 日程的纯逻辑：记下一件事、什么时候、划掉。
 *
 * 和递话一样是流水账（add / done 各一行），不覆盖写：
 * "这件事做过了"和"这件事没做"是两件事，抹掉前一行就说不清它什么时候被划掉的。
 *
 * 和便条的区别：便条是给"我"的备忘，条件成立才看；日程是给"我们"的安排，时间到了就该提。
 * 所以这里只认绝对时间（epoch ms），不认"--when 她提到加班时"那种自然语言条件。
 */

const DAY = 24 * 3600e3

export function makePlan(input, { now = Date.now(), existing = [], dayStart = 0 } = {}) {
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('安排什么？例：agent-man plan "陪她去看牙" --at "2026-11-14 09:30"')
  const at = Number(input.at)
  if (!Number.isFinite(at)) throw new Error('这条安排没有时间：--at "2026-11-14 09:30"')

  // 序号按"哪天的第几条"发，和便条同一套：人能读、能拿来划掉。
  const day = dayKey(at, { dayStart })
  const sameDay = existing.filter((r) => r.op === 'add' && dayKey(r.at, { dayStart }) === day)
  const id = `${day}-p${String(sameDay.length + 1).padStart(2, '0')}`
  return { op: 'add', id, at, text, addedAt: now }
}

/** 还没划掉的。划掉过的 id 不再出现。 */
export function pendingPlans(records) {
  const gone = new Set(records.filter((r) => r.op === 'done').map((r) => r.id))
  return records.filter((r) => r.op === 'add' && !gone.has(r.id))
}

/** 接下来的安排：从今往后最多看几天（过点的也留着，标出来比装作没有好）。 */
export function upcoming(records, { now, days = 7 } = {}) {
  const until = now + days * DAY
  return pendingPlans(records)
    .filter((r) => r.at <= until)
    .sort((a, b) => a.at - b.at)
}

/** 今天的安排：sky 顺带报的那些。日界跟 AGENT_MAN_DAY_START 走，和日记同一套。 */
export function todayPlans(records, { now, dayStart = 0 }) {
  const today = dayKey(now, { dayStart })
  return pendingPlans(records)
    .filter((r) => dayKey(r.at, { dayStart }) === today)
    .sort((a, b) => a.at - b.at)
}
