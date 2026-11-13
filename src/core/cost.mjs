// 预算按"宽度"算而不是按字符数：一个汉字占两列、一个 ASCII 占一列。
// 混排时按字符数记会高估英文、低估中文，"注入那一屏 1000 cost"就成了假数（design §5）。

const COST_ASCII = 0.28
const COST_WIDE = 1

// 宽度 1 的字符区间。用一张表一次判完，比逐段 if 好读；不做字素分段——
// 预算不需要那么精确，组合符号多算半个也无伤大雅。
const WIDE_RANGES = [
  '\u1100-\u115F', // 谚文字母
  '\u2E80-\u303E', // CJK 部首与符号（含句号、书名号这类全角标点）
  '\u3041-\u33FF', // 假名、谚文兼容字母、CJK 兼容符号
  '\u3400-\u4DBF', // CJK 扩展 A
  '\u4E00-\u9FFF', // CJK 统一表意
  '\uA000-\uA4CF', // 彝文
  '\uAC00-\uD7A3', // 谚文音节
  '\uF900-\uFAFF', // CJK 兼容表意
  '\uFE10-\uFE19', // 竖排标点
  '\uFE30-\uFE6F', // 兼容标点与小写变体
  '\uFF00-\uFF60', // 全角 ASCII
  '\uFFE0-\uFFE6', // 全角符号
  '\u2600-\u27BF', // 杂项符号与装饰（☀ ✅ 一类）
  '\u{1F000}-\u{1FAFF}', // 代理对 emoji、麻将、扑克
]
const WIDE = new RegExp(`[${WIDE_RANGES.join('')}]`, 'u')

// 按码点累加：'🙂'.length 是 2，逐 UTF-16 单元算会把它记成两个半角，
// 一个 emoji 的成本就凭空翻倍。for...of 按码点走，正好。
export function cost(s) {
  const text = toText(s)
  let used = 0
  for (const ch of text) used += weightOf(ch)
  return used
}

// 切分只为一个承诺：切完的 cost 必须 ≤ budget（AGENTS 二·1）。
// 顺序照 design：先句末，再逗号，最后硬切。切了就在 cut 上写 true，让上层用 "! " 说出来——
// 不在这里补省略号：省略号也要占预算，而"被截过"这件事该由调用方决定怎么显示。
export function cut(s, budget) {
  const text = toText(s)
  const cap = Number.isFinite(budget) ? budget : 0
  if (cost(text) <= cap) return { text, cut: false }

  // 一遍扫到"刚好装得下"的最长前缀。这里不用 cost() 复核：used 与 cost() 是同一次累加，
  // 结果逐位相同，而前缀切法能保证任意更短的前缀只会更小。
  let used = 0
  let end = 0
  let idx = 0
  for (const ch of text) {
    const w = weightOf(ch)
    if (used + w > cap) break
    used += w
    idx += ch.length
    end = idx
  }

  const head = text.slice(0, end)
  // 取句末与逗号里更靠后的那个，而不是"有句末就只看句末"：预算内的第一句常常很短，
  // 硬按第一句切会白扔半屏预算；而句末只要还在预算内且最晚，这里就照 design 切在句末。
  const stop = Math.max(lastEnd(head, SENTENCE_END), lastEnd(head, JOINT), 0)
  const at = stop > 0 ? stop : end
  return { text: text.slice(0, at).replace(/\s+$/, ''), cut: true }
}

// 换行折成空格：一屏里的每条记录都得能塞进一行，否则 budget 的"行数 × 行宽"白算。
// max 是码点个数（不是 cost）——这里管的是显示宽度，不是预算。
export function oneLine(s, max) {
  const text = toText(s).replace(/\s*[\r\n]+\s*/g, ' ')
  if (!Number.isFinite(max) || max <= 0) return text
  const chars = Array.from(text)
  const cap = Math.trunc(max)
  if (chars.length <= cap) return text
  if (cap < 1) return ''
  return `${chars.slice(0, cap - 1).join('')}…`
}

// design §7 写的是 '。！？；\n'：半角的 ! ? ; 大量出现在命令与路径里，当句末会切在半句话上。
const SENTENCE_END = /[。！？；\n]/g
const JOINT = /[，、,]/g

function lastEnd(text, re) {
  let end = 0
  for (const m of text.matchAll(re)) end = m.index + m[0].length
  return end
}

function weightOf(ch) {
  return WIDE.test(ch) ? COST_WIDE : COST_ASCII
}

function toText(s) {
  if (typeof s === 'string') return s
  return s === undefined || s === null ? '' : String(s)
}
