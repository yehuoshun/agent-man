/**
 * 预算单位不是字符。
 *
 * CJK 约 1 字符 ≈ 1 token，拉丁约 4 字符 ≈ 1 token。
 * 拿字符当预算，中英混排时同一个数字能差 2-3 倍——"硬预算"这个承诺就不成立了。
 * 这里不是精确 tokenizer，是保守估计：宁可早停，不能溢出。
 */

const ASCII = 0.28 // 英文平均 3-4 字符/token
const WIDE = 1.0 // CJK、全角、谚文、emoji 按 1 算

const SENT = new Set([...'。！？；!?;\n…'])
const CLAUSE = new Set([...'，,、 '])

const width = (ch) => (ch.codePointAt(0) < 0x80 ? ASCII : WIDE)

/** 一条文本的预算代价。 */
export function cost(text) {
  let n = 0
  for (const ch of String(text ?? '')) n += width(ch)
  return Math.ceil(n)
}

/**
 * 把超预算的单条切到 cap 以内。
 *
 * 参考实现用 `[...text].slice(0, budget)` 硬切，输出过
 * "…这一段是很长的连续叙述，这一段是…"，和它自己"话不拆"的原则矛盾。
 * 这里优先在句末断；句末太靠前（浪费超过一半额度）就退到逗号；都没有才硬切。
 * 无论哪种，都返回 cut:true，让调用方说出来。
 */
export function truncate(text, cap) {
  const s = String(text ?? '')
  if (cap < 2) return { text: '…', cut: true }
  if (cost(s) <= cap) return { text: s, cut: false }

  let out = ''
  let used = 0
  let sent = -1
  let clause = -1
  for (const ch of s) {
    if (used + width(ch) > cap - WIDE) break // 给 "…" 留位
    out += ch
    used += width(ch)
    if (SENT.has(ch)) sent = out.length
    else if (CLAUSE.has(ch)) clause = out.length
  }

  // 句末断点得吃掉一半以上额度才值得用，否则不如切在逗号上
  const at = sent > 0 && sent >= out.length * 0.5 ? sent : clause > 0 ? clause : 0
  const body = at > 0 ? out.slice(0, at).trimEnd() : out
  return { text: body + '…', cut: true }
}
