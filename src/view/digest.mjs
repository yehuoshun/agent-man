// 摘要页：一段抬头、一段正文、一行账。
// 页脚必须把"用了多少 / 装下几条 / 丢了什么原因"一次说全：摘要会进模型上下文，
// 被丢掉的条目不在屏幕上留原因，就等于静默丢弃（AGENTS 二·2）。

// design §4 的 trace 把 kept 记成 id 数组，§7 的 build 又把 kept 往上传；
// 两种形态都认，省得上游为了一个数字改形状。
function keptCount(kept) {
  return Array.isArray(kept) ? kept.length : Number(kept) || 0
}

// 原因去重、按首次出现排序：同一个原因丢掉三条只写一次——条数已经写在前头了；
// 具体哪个 id 因为什么掉的，账本（state/trace-*.jsonl）里逐条都在，屏上不重复搬。
function droppedNote(dropped) {
  if (dropped.length === 0) return '没丢东西'
  const reasons = []
  for (const entry of dropped) {
    const reason = (entry && entry.reason) || '原因缺失'
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  return `丢 ${dropped.length} 条（${reasons.join('、')}）`
}

// 预算按 cost 算，cost 是加出来的浮点数，一位小数的噪声（97.0800000000001）在屏上
// 只会让人以为还有零头可分。这里只收一格小数，内部值一概不动：账本记真相，屏幕给读数。
function costText(value) {
  const n = Number.isFinite(value) ? value : 0
  return Math.round(n * 10) / 10
}

function footer(stats) {
  const s = stats || {}
  const used = costText(s.used)
  const budget = costText(s.budget)
  const dropped = Array.isArray(s.dropped) ? s.dropped : []
  const head = `—— 用了 ${used}/${budget} · 装下 ${keptCount(s.kept)} 条`
  return `${head} · ${droppedNote(dropped)}`
}

export function render({ header, body, stats }) {
  // 正文为空要明说"今天没什么可巩固的"，不能留空段：空段读起来像是渲染坏了。
  // 抬头让位到 headerKind 'none' 时 header 是空串、正文也为空，这一屏就只剩这句话：
  // "今天没什么可巩固的"是给人看的结论，不是渲染失败的痕迹。
  const text = body && body.trim() !== '' ? body : '（今天没什么可巩固的）'
  // 抬头为空就不占那一段：空行和空标题一样，只白吃预算（与处境屏同一套省略规矩）。
  const blocks = header ? [header, text, footer(stats)] : [text, footer(stats)]
  return blocks.join('\n\n')
}
