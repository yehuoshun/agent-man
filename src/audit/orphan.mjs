// audit orphan（design §6）：结论的证据指向不存在的事件——只报出来，不删、不补、不改。
// 判定住在 memory（只有它知道"哪条事件算存在"，见 design §4 的 evidence/ids）；这里只是
// audit 的命名空间：CLI 问 audit 就能拿到，不必知道该去翻哪一层。
import { orphan as memoryOrphan } from '../memory/index.mjs'

export function orphan({ home } = {}) {
  const dir = dataHome(home)
  const got = memoryOrphan({ home: dir })
  return { items: got.items, skipped: got.skipped }
}

function dataHome(home) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('orphan 需要一个数据目录：home 为空（应由调用方从 AGENT_MAN_HOME 解析）')
  }
  return home.trim()
}
