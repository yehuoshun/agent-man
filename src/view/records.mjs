// 记录行：一条记录一行——id、时间、正文，再加上这一类特有的记号。
// 时间串必须由调用方用 core/time 的 clock() 算好再传进来：view 不碰 Date、不问钟，
// 「时间只解释一次」才有唯一落点（AGENTS 二·3）；在这儿再实现一遍格式化就是第二份真源。

const KINDS = ['event', 'memory', 'rule', 'note', 'plan']

// 记号按类别拼在正文前后：读一行就知道这是"事实"、"规矩"还是"等着提的一句话"，
// 不必回头按 id 前缀反推类别。
function bodyOf(rec, kind) {
  switch (kind) {
    case 'memory':
      // key 是这条结论占的槽位：不印出来，读者就看不出两条结论为什么会互相顶掉（design §2 干扰）。
      return rec.key ? `${rec.text} [${rec.key}]` : rec.text
    case 'rule':
      // ! 是仓库里"这行要照做"的记号（AGENTS 用 ! 开头报要注意的事）：规矩是约束，不是叙述。
      return `! ${rec.text}`
    case 'note':
      // 前瞻记忆靠触发不靠检索：不写「等什么」，这条便条就没法用（design §2）。
      return rec.trigger ? `${rec.text}（等：${rec.trigger}）` : rec.text
    case 'event':
    case 'plan':
      // 日程的时间已经写在行首，正文不再重复一遍。
      return rec.text
    default:
      // 不认识的类别当场说清楚，绝不退回成"看着像事件的普通行"——那种错要翻很久才找得到。
      throw new TypeError(`records: 不认识的类别 ${String(kind)}，只能是 ${KINDS.join(' / ')}`)
  }
}

// 缺时间时留一个破折号，而不是省掉这一列：省掉会让三列错位，破折号至少看得出缺了东西。
function stamp(rec) {
  return typeof rec.when === 'string' && rec.when !== '' ? rec.when : '—'
}

export function item(rec, kind = 'event') {
  return `${rec.id}  ${stamp(rec)}  ${bodyOf(rec, kind)}`
}

export function list(items, kind = 'event') {
  // 空表也要回一行「（空）」：返回空字符串会被当成渲染坏了（AGENTS 二·2 不静默）。
  if (!Array.isArray(items) || items.length === 0) return '（空）'
  return items.map((rec) => item(rec, kind)).join('\n')
}
