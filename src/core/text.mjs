// 线索检索的分词（design §2 "诚实放弃"）：没有嵌入，就没有语义检索，
// 这里能做的只是"同样的字出现没出现"。中文按二元组切，英文按词切。
//
// 为什么是二元组：单字太散（"窗"和"窗户"互不相认），整句又太死（改一个标点就全miss）。
// 二元的代价写死在用例里：**同义改写查不到**，这是设计选择，不是等待修复的 bug。

// 中文停用字：出现在几乎每一句里、却几乎不携带线索的字。
// 表刻意小：滤太多会把真正的搭配拆掉（"她关"里的"她"一删，"关"就只剩半个线索）。
const CN_STOP = new Set(Array.from('的了是在我你他她它这那就也都和与吗呢吧啊着过有个把被给对上下里很再又还'))

// 英文虚词与上面同性质。不滤掉的话，'the clock' 这种查询会被 the 抬高分母之外的交集。
const EN_STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'at', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'they', 'we',
  'me', 'my', 'your', 'his', 'her', 'their', 'our', 'do', 'does', 'did', 'not', 'no',
  'for', 'with', 'by', 'from', 'up', 'down', 'out', 'about', 'into', 'over',
  'after', 'before', 'can', 'could', 'will', 'would', 'should', 'may', 'might',
  'have', 'has', 'had', 'there', 'here',
])

// 一次扫完两种"词"：连续的 CJK 字块、连续的字母数字块。标点与空白天然是分隔符，不用另删。
const AT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]+|[A-Za-z0-9]+/g
const CJK_ONE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]/

// 去重后再返回：这个数组的唯一用途是求交并比，重复项只会让下游多算几遍。
export function tokens(s) {
  const text = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s)
  const out = []
  const seen = new Set()
  const push = (t) => {
    if (t === '' || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  for (const m of text.matchAll(AT)) {
    const piece = m[0]
    if (!CJK_ONE.test(piece[0])) {
      const word = piece.toLowerCase()
      if (!EN_STOP.has(word)) push(word)
      continue
    }
    const chars = Array.from(piece)
    // 单字块留一个：'窗' 这种独字线索没有二元组可用，丢了就再也查不到。
    if (chars.length === 1) {
      if (!CN_STOP.has(chars[0])) push(chars[0])
      continue
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      // 两个都是停用字才丢：'关了' 里还有'关'，丢了它就等于把线索一起扔了。
      if (CN_STOP.has(chars[i]) && CN_STOP.has(chars[i + 1])) continue
      push(chars[i] + chars[i + 1])
    }
  }
  return out
}

// 两边都空返回 0：空查询与空记录的"相似度"没有意义，给 1 会让一条空记录排到最前。
export function jaccard(a, b) {
  const left = toSet(a)
  const right = toSet(b)
  if (left.size === 0 && right.size === 0) return 0
  let hit = 0
  for (const t of left) if (right.has(t)) hit += 1
  const union = left.size + right.size - hit
  return union === 0 ? 0 : hit / union
}

function toSet(x) {
  if (typeof x === 'string') return new Set(tokens(x))
  if (!Array.isArray(x)) return new Set()
  return new Set(x.filter((t) => typeof t === 'string' && t !== ''))
}
