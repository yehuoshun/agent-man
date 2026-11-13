// 复述记账的入口（design §5）：被选进摘要的结论 seen +1。
// 规则本身住在 memory 的 markSeen——它写的是 memory 自己的行，一条记录长什么样
// 只有那一层知道；这里只做一次参数换名：digest 的 now 就是 markSeen 的 at。
import { markSeen } from '../memory/index.mjs'

import { nowOf, requireHome } from './build.mjs'

// retell({home,now,ids}) → { marked, skipped, failed }。
// run 只关心后两个：没记上的每一条都要说出来，否则"我说过几次"会慢慢变成假话。
export function retell(opts = {}) {
  const dir = requireHome(opts.home)
  const at = nowOf(opts.now)
  return markSeen(dir, { ids: opts.ids, at })
}
