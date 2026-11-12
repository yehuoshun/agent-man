# agent-man 项目约定

给 agent 一个会话之外的生活。**不是框架，是零件**：每个零件只做确定性的那部分，语义判断留给模型。

动手前先读 `README.md` 的「为什么」和 `docs/decisions.md`——那里的每条规则背后都对应一次具体事故。
没有新的、能被复现的事故，就不要推翻它们；有，也要先把它写进 `docs/decisions.md` 再改代码。

## 一、主题边界（越界的设计一律不合格）

1. **只存不说**。脚本负责记，说不说、怎么说，由模型自己定。脚本不生成对用户的台词。
2. **给处境，不给台词**。投递「这会儿 21:40，你之前想过……」，不是「〔定时任务到点〕」。
3. **保真优先于压缩**。宁可这次不更新，也不让记录被改写。
4. **降噪是必需项**。每天都发生的事不进队列，否则模型会学会忽略它。

由此推出一条硬结构约束：**零件必须跑在模型进程之外**——只依赖文件、状态目录、系统时间。
任何"需要模型在场才能工作"的设计（常驻进程、会话内状态、回调模型）都不合格。

## 二、三条硬承诺（有测试锁着）

1. **预算不可协商**。`select()` 的总 charge 永不超 `budget`，对 `weight=3` 也不例外。
2. **不静默丢弃**。切了记 `truncated`，没进去记 `no-room`，`weight=3` 被丢要单独报警（`src/cli.mjs` 的 `reportDrops`）；长期层没装下的由 `reportLongDrops` 报。
3. **时间只解释一次**。入口 `parseAt()` 归一成 epoch ms，之后全链路只认数字；`relTime()` 每次渲染现算，绝不写进存储或文本。

改这三条的任何一条 = 改测试 + 在 `docs/decisions.md` 写清代价。

## 三、技术栈硬约束

- **零依赖**：不新增 `dependencies`/`devDependencies`，不装 `node_modules`。只用 `node:` 内置模块。
- **Node ≥ 20**（`package.json` 的 `engines`），ESM，全部 `.mjs`，`"type": "module"`。
- **无构建、无转译、无 TypeScript**。`node bin/agent-man.mjs <cmd>` 必须能直接跑。
- **行末一律 LF**。`.gitattributes` 已锁 `eol=lf`；在 Windows 上用编辑器或脚本写文件也必须写 `\n`，否则整文件变成 diff。
- 文件编码 UTF-8，**不写 BOM**（PowerShell `Set-Content -Encoding UTF8` 那次事故）。
- 提交前 `node --test` 必须全绿；用例只增不减。条数以 `test/agent-man.test.mjs` 为准，
  不在这里写死——这里写过的"44 个"在 §15 加完用例后就过期了，过期的基线比没有更糟。

## 四、模块职责

| 路径 | 职责 | 不该做的事 |
|---|---|---|
| `bin/agent-man.mjs` | 薄壳：`process.exitCode = main()` | 不放任何逻辑 |
| `src/cli.mjs` | 参数解析、命令分发、退出码、用户可见输出 | 不直接读写文件、不自己算预算 |
| `src/time.mjs` | 时间的唯一解释点：`parseAt` / `stamp` / `dayKey` / `daySpan` / `relTime` / `clock` / `hourOf` | 别的模块不许自己 `new Date()` 解析或格式化 |
| `src/cost.mjs` | 预算单位与切分：`cost()` / `truncate()` | 不判断"该不该记" |
| `src/budget.mjs` | 纯函数选择：`select(events, {budget, pinnedShare})`、保底那条的额度 `pinnedFloor` | 不碰文件系统、不看时钟、不生成文本 |
| `src/memory.mjs` | 长期层的纯逻辑：`makeItem`（校验/发号）/ `activeItems`（supersedes）/ `selectMemory` / `longLine` | 不总结、不合并语义、不碰文件系统 |
| `src/render.mjs` | 把两层选择结果渲成 markdown + `stats`；整段文本夹进预算（`attempt`） | 不做取舍决策（取舍全在 `budget.mjs` / `memory.mjs`） |
| `src/when.mjs` | 定时候的纯逻辑：`cue` / `inQuiet` / `describeQuiet` | 不碰文件系统、不生成台词、不判断"这条重不重要" |
| `src/trace.mjs` | 账本纯逻辑：`buildTrace` / `neverShown` / `traceLine` | 不碰文件系统、不看时钟、不判断"哪条重要" |
| `src/store.mjs` | `resolveHome` / `paths` / `ensure` / `appendEvent` / `readEvents` / `appendMemory` / `readMemory` / `appendTrace` / `readTraces` / `readCue` / `writeCue` / `assertTail` / `writeAtomic` | 不解析业务语义 |

- 退出码约定：`0` 成功，`1` 输入或运行时错误（`main` 内 catch 后 `! <message>`），`2` 未知命令或未知选项（解析层就拦下的用法错误，见 `FLAGS` / §16）。
- 加命令/加参数必须同步改 `src/cli.mjs` 的 `HELP` 文本和 `README.md` 的用法段。
- 改版本号：`src/cli.mjs` 顶部的 `VERSION` 与 `package.json` 的 `version` 一起改。
- 关键常量就地定义、具名导出，不散落魔数：`PINNED_WEIGHT = 2`、`LINE_OVERHEAD = 8`、`pinnedShare = 0.7`、`longShare = 0.6`、`DUP_WINDOW = 24h`。

## 五、代码风格（照现有代码写，别引入第二套）

- 无分号、单引号、2 空格缩进，行宽约 ≤ 110。
- 具名导出写 `export function foo()`；模块级常量 `const NAME = ...`。不导出箭头函数常量。
- **纯函数与副作用分开**：`select()` 不碰文件系统也不看时钟；时间从参数进来（`now`）。
- **依赖注入优先**：`main(argv, { env, out, now })` 这种形状让 CLI 无需 spawn 就能测。新增入口按同样形状设计。
- 注释写**为什么**和**当初的事故**，不写"这行在做什么"。样板见 `src/budget.mjs` 顶部注释、`src/store.mjs` 的 BOM 说明。
- 用户可见文案用中文，省略号用 `…`，不用 `...`。
- 输出分两条路：正常结果 `out.log`，警告/异常 `out.error`（前面带 `! `）。

## 六、存储与数据

- 数据目录默认 `~/.agent-man`，`AGENT_MAN_HOME` 覆盖（`resolveHome`）；`state/` 子目录已预留。
- 事件是 JSONL，一行一条：`{ at, kind, fact, weight?, feel?, src? }`；`at` 必须是有限数字（epoch ms）。
- 写：`appendLine()`（open → write → fsync → close），一次一行，不写 BOM。
- 读：坏行跳过并计数，返回 `{ events, bad }`，由调用方用 `! ` 报出来。**不因一行坏掉丢整份记忆**，但也绝不装作没发生。
- 覆盖写文件一律走 `writeAtomic()`（write → fsync → rename，不留 `.tmp`）。
- 追加也要落盘：`appendLine()` 写完就 fsync，再用 `assertTail()` 读回最后一行核对；
  不落盘不算记下（§20）。
- 排序只认 `a.at - b.at` 数字差；禁止 `localeCompare` / `startsWith('YYYY-MM-DD')` 之类字符串比较。
- 需要"展示时间"就走 `relTime()` / `stamp()`；需要"预算"就走 `cost()`；需要"切句子"就走 `truncate()`。不要就地手搓。

## 七、测试

- `node --test`，用例都在 `test/agent-man.test.mjs`。
- 用例名用中文，描述的是**约束**而不是函数名：「总代价永不超预算——包括 weight=3」「一条放不下不终止后面的候选（break → continue）」。
- 每个从参考实现抄来的坑配一条回归用例，注释里写明事故来源；修 bug 先加用例。
- 时间相关用例必须传死 `now` / `at`，不许依赖当前时钟；否则会随日期漂移。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))`，不写进仓库。
- CLI 层用 `main(argv, ctx)` + `recorder()` 断言 stdout/stderr，不 spawn 子进程。
- 断言"不超预算"时要真跑 `cost()` 复核，别只断言布尔。

## 八、提交与文档

- **一改一提交一 push**。每个自洽的改动单独提交并立刻 `git push origin main`，不攒批、不把两件事塞进一个提交——目的是任何一行代码都能追回到一次改动和一条信息。中途失败或被打断时，宁可提交一个"半成品但可解释"的状态，也不要留一堆未提交的改动在本地。
- 提交信息中文，一句话说清改的是哪个约束或加的哪个零件（例：`记事: 事件日志 + 按预算渲染摘要`、`统一 LF 行末，避免 Windows 下整文件 diff`）。
- 一个新的**决定**必须写进 `docs/decisions.md`，固定三段：**决定** / **来由**（那次事故）/ **代价**。只写"选了什么"没有价值。
- `docs/decisions.md` 第 9 节「还没想清楚的事」是真清单：解决了就删掉那条，未定的不要假装定了。
- `README.md` 保持产品语气（给谁、为什么、怎么用），实现细节留在这里和 `docs/`。
- README 顶部那张零件清单（`记事 / 定时候 / 看天气 / 递话`）随零件完成移动 `← 现在在这里`。

## 九、禁止清单

- 第三方依赖、数据库、二进制存储格式。
- 把语义判断塞进脚本（合并重复、判断"是不是同一件事"、生成台词、决定该说什么）。
- 静默丢弃 / 静默截断 / 静默吞异常。
- 常驻进程、守护线程、交互式确认；零件是"跑一次就退出"的。
- 业务代码里散落 `Date.now()`（只在参数默认值和 CLI 入口出现）。
- 在仓库根或工作区根散落临时文件：本项目临时产物写本仓库 `tmp/`（已被 `.gitignore` 覆盖），需要保留的成果进 `docs/` 或 `src/`。
- 凭据进仓库：一律放工作区 `config/`，只引用路径，不回显内容。

## 十、与工作区的关系

本仓库位于工作区 `code/agent-man/`，继承工作区根 `AGENTS.md`；冲突时以本文件为准。
git 操作的工作目录必须是本仓库自身，不在工作区根 `git init`、不跨仓库 `git add`。
