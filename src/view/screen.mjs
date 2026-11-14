// 处境屏：把 mind/situation 已经算好的快照排成人读的一段字。
// 这里不做任何取舍——哪条该出现、排第几、值不值得说，都由上游算好了；
// view 只负责形状与省略（design §7：view 不吃盘、不问钟）。

// 空段整段不出现、段间空一行：这一屏是往模型上下文里塞的工作记忆，
// 空标题加空行只会白占预算（design §2 工作记忆 ≈4 chunk）。
function section(title, lines) {
  if (lines.length === 0) return null
  return [title, ...lines.map((line) => `  ${line}`)].join('\n')
}

// 保留率只留两位：它是个解释用的刻度，不是账目；
// 小数点后十几位的浮点尾巴只会让人怀疑这数算错了（design §5）。
function retention(r) {
  const n = Number(r)
  return Number.isFinite(n) ? n.toFixed(2) : String(r)
}

// 从没开过口时也要有一行：省掉它，读者会以为"上次开口是零秒前"。
function sinceLine(since) {
  if (!since) return '上次开口：还没开过口'
  const fresh = Number(since.fresh) || 0
  // 之后 0 条新记忆时不留括号：写「之后 0 条」等于没说，还多占一段。
  return fresh > 0 ? `上次开口：${since.text}（之后 ${fresh} 条新记忆）` : `上次开口：${since.text}`
}

// 两项都为 0 时整行省略：没有积压还挂一行「积压：0 条」，读者会去猜 0 是什么单位。
function backlogLine(backlog) {
  const b = backlog || {}
  const parts = []
  if (b.unconsolidated > 0) parts.push(`${b.unconsolidated} 条待巩固`)
  if (b.overdue > 0) parts.push(`${b.overdue} 条过期日程`)
  return parts.length > 0 ? `积压：${parts.join(' · ')}` : null
}

// 过点的日程优先说"过点了"：此刻还剩多久已经没有意义，再摆倒计时就是误导。
function planLine(plan) {
  if (plan.late) return `${plan.when} ${plan.text}（已经过点了）`
  return plan.left ? `${plan.when} ${plan.text}（${plan.left}）` : `${plan.when} ${plan.text}`
}

// 便条靠触发不靠检索（design §2 前瞻记忆），所以「等什么」和正文并排写，
// 少了它就只是一句话，agent 无从判断此刻该不该提。
function noteLine(note) {
  return note.trigger ? `· ${note.text}（等：${note.trigger}）` : `· ${note.text}`
}

// 建议行带零件名字：读者要能判断这话是哪只眼睛看到的，不是屏自己编的。
function suggestLine(item) {
  return item.name ? `· ${item.text}（${item.name}）` : `· ${item.text}`
}

// 标题固定写「最弱的三条」：上游最多给三条，数字随 len 变会让人以为这一段有条数配额。
function weakLine(item) {
  return `${item.text} · R=${retention(item.r)} · 读到过 ${item.seen} 次（${item.id}）`
}

export function render(situation) {
  const plans = situation.plans || []
  const notes = situation.notes || []
  const weakest = situation.weakest || []
  const suggest = situation.suggest || []

  const head = [
    `agent-man · ${situation.clock}`,
    // 静默时段只换这一行文案，别的照旧：agent 需要看见"现在该收声"，
    // 也得看得见它压着哪些事——藏起来等于逼它下一次重新判断。
    situation.quiet ? '! 夜深了，除非她先开口，不然不主动说' : sinceLine(situation.since),
    backlogLine(situation.backlog),
  ].filter((line) => line !== null)

  const blocks = [
    head.join('\n'),
    section('日程', plans.map(planLine)),
    section('便条', notes.map(noteLine)),
    section('最弱的三条', weakest.map(weakLine)),
    // 建议排在最后：它是"可以开始做的事"，不是此刻的处境本身；放在最弱的三条前面
    // 会让读者以为这是要做的事排在记忆之前，而这条建议随时可以不采纳。
    section('建议', suggest.map(suggestLine)),
  ].filter((block) => block !== null)

  // 块之间空一行、结尾不留多余空行：CLI 与注入两条通道都直接拼这段字。
  return blocks.join('\n\n')
}
