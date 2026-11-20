# agent-man

[![ci][ci-badge]][ci-link]

给 LLM agent 补上它没有的那一层：**会话之外的记忆、此刻的处境、该不该开口**。

它自己不是 agent——不常驻、不联网、不调用模型、不替你下判断。它只做三件事：
把发生过的事分层记住、把"现在是什么时候、谁在等什么"摆出来、给出"这次该不该说话"的判决。
说不说、说什么，仍然由模型自己决定。

零依赖、纯 `node:` 内置、Node ≥ 20。

## 装它

没有 npm 包：`agent-man` 这个名字在 npm 上是别人的（2022 年的 0.0.1，一直没人动），
本仓库用 `"private": true` 明说不发布（来由见 [docs/decisions.md](docs/decisions.md) 的「不发 npm」一节）。
两条正当的装法：

- **当命令行用**：`git clone` 之后 `npm link`，或者把 `code/agent-man/bin` 整目录加进 `PATH`。
  Windows 上那个目录里有 `agent-man.cmd` 垫片，加完直接敲 `agent-man` 就行，
  不用再敲 `node …\bin\agent-man.mjs`。
  不想动 `PATH`、只希望**零件**能找到本体：设 `AGENT_MAN_BIN` 或 `AGENT_MAN_REPO` 也可以
  （零件侧的查找顺序是 `AGENT_MAN_BIN` → `PATH` → `AGENT_MAN_REPO`；这两条环境变量是
  "本体在哪"的入口提示，本体自己不读，也不是配置键）。
- **当 DSH 插件用**：`package.json` 里的 `dsh.bundle.patch` 指本包的宿主补丁，用 DSH 的插件管理从本地路径装。

数据落在 `~/.agent-man`；想换个地方就把 `AGENT_MAN_HOME` 指过去（试用与测试都靠这一条，不污染真数据）。

## 它解决的是模型的三个缺口

| 缺口 | 表现 | agent-man 的做法 |
|---|---|---|
| 会话之外没有记忆 | 每次对话从零开始，用户上周说过的偏好要再说一遍 | 五类记忆分层落盘（见下），按保留率 `R` 与线索分 `cue` 竞争进预算 |
| 不知道"此刻" | 不知道现在几点、有没有过点的事、欠了几笔该整理的事 | 处境快照：日界、静默时段、日程、便条、最弱的三条记忆、欠账、兴致够时的一条建议（来自 PATH 上的零件） |
| 不知道何时该沉默 | 要么一声不吭，要么每轮都插话 | 开口判决：最小间隔、静默时段、欠账门槛，再按情绪四轴调制；**一次没说出口也留账** |

## 五类记忆（按人类记忆分层，不按表格分层）

| 层 | 住哪 | 保留 |
|---|---|---|
| 情景（原文） | `events/<日>.jsonl` | 3 天半衰 |
| 语义（结论） | `memory.jsonl`，`key` 唯一 | 30 天半衰，`seen` 让它变牢 |
| 程序（规矩） | `rules.jsonl` | 永不衰减 |
| 前瞻（便条/日程） | `state/notes-<月>.jsonl`、`state/plans-<月>.jsonl` | 到点/过期即失效 |
| 自我（我在成为谁） | `self.md` | 不衰减，超预算报红 |

原文永远留在日记里，结论只是索引——`memory` 的每条结论都带 `evidence`，指回它从哪几条事件来。

## 三条硬承诺（每条都有测试锁着）

1. **预算不可协商**：装下的总 cost 永不超预算，对必放项也一样；放不下就明确丢并记进 `dropped`。
2. **不静默**：截断记 `truncated`、丢弃记 `reason`、降级打 `! ` 警告；连"这次决定不说话"也要留账。
3. **时间只解释一次**：入口 `parseWhen()` 归一成 epoch ms，之后全链路只认数字，展示时才现算。

## 命令面

```
agent-man                             处境屏（≡ context show）
agent-man event  add|ls|find          情景
agent-man memory add|ls|find|show|revise   结论
agent-man rule   add|ls               规矩
agent-man note   add|ls|take|drop     便条
agent-man plan   add|done|drop|ls     日程
agent-man self   show|set|append      自我块
agent-man soul   ls|use|show|check|import  灵魂卡（角色卡）
agent-man affect show|set|clear|why|stim <kind>   情绪（四轴：情绪/精力/信任/尊重）
agent-man context show|digest|cue|sense    处境屏、摘要、开口判决、零件聚合
agent-man audit  trace|timeline|orphan     审计账本
agent-man config path|show|get|set|reset   配置（唯一真源，读命令无副作用）
agent-man doctor                      自检
agent-man <其它名字> …                PATH 上的 agent-man-<名字>（插件直通）
```

别名：`log`→`event add`、`remember`→`memory add`、`leave`→`note add`、`digest`→`context digest`、
`cue`→`context cue`、`find`→`event find`、`show`→`memory show`、`look`→`context show`。

退出码：`0` 成功/有话要说、`1` 不说（cue 的"不打扰"、`audit orphan` 查出不合格数据、
`memory show` 查不到）、`2` 用法或数据错。读命令都支持 `--json`；
stdout 只放结果，stderr 只放 `! ` 开头的警告。

## 数据目录

默认 `~/.agent-man`，`AGENT_MAN_HOME` 覆盖。分片规则：情景按日、便条/日程/账本按月，
语义/程序/自我不分片（`key` 的唯一性要全局可见）。**旧行永不改写**——结论失效写 `to`/`by`，
规矩更新写新条 + `supersedes`，仓库里没有任何 UPDATE。

## 灵魂卡

一个可切换的身份：`name.md`（称呼）/ `identity.md`（我是谁）/ `soul.md`（说话方式）/
`dialogue.md`（示范对话，`<START>` 分组）/ `lore.jsonl`（往事，按触发词取）。
支持导入 SillyTavern 的 CCv1/V2 角色卡，`creator_notes` 之类只进 `card.json`、不进注入。
名字、身份、说话方式走常驻预算，往事与示范对话按触发竞争——**切角色不切记忆**，
角色换的是人设与说话方式，我记住的事还在。

## 情绪

四条轴：情绪 `v`、精力 `e`、信任 `t`、尊重 `r`（`r` 可负）。只做状态，不演台词：
影响的是开口门槛与语气分寸，不上屏就被忽略（`affect.visible` 可关）。
瞬时情绪这一版不启用（理由见 `docs/decisions.md`）：宁可说"最近 45 分钟有 3 条刺激"，
也不给一个编出来的情绪名字。

## 零件（插件）

PATH 就是注册表：`agent-man-foo` 装上就能 `agent-man foo …`。契约六条（一调用一进程、
`--describe` 自报家门、退出码 `0/64/69/75`、骨架强制超时、stdout ≤ 8KB、连续三次失败冷却）。
插件只能写情景层（`event add --src tool:<名字>`），不许写结论、规矩、自我块——
工具的观察不能替 agent 下结论。
零件被本体调用时会带上 `AGENT_MAN_PART_CALL=1` 哨兵，本体见到它就不再问零件（零件在零件里会无限套娃）；
嫌零件慢或不想让它们参与，就 `agent-man config set parts.inject false`——CLI 那一屏与宿主注入会一起停，
只留一条 `! ` 说明这次没问零件。

**接一个新的**：在 PATH 上放一个可执行文件 `agent-man-<名字>`，它得能 `--describe` 报五个字段
（`name` / `desc` / `section` / `timeout_ms` / `side_effects`），无参时只读、只往 stdout 回一行。
写完先 `agent-man context sense --json` 看它答了什么、预算怎么算的。
第一个真零件是 [`agent-man-yuQue`](https://github.com/yehuoshun/agent-man-yuQue)
（把处境与记忆同步进语雀；库名必须自己设 `YUQUE_NAMESPACE`，它没有内置默认库），装法看它自己的 README。

**出问题看哪**：`agent-man context sense --json` 里有每件的答话、预算与 `dropped`；
`agent-man config get parts.inject` 确认开关没被关掉；四条通道各走哪条路、实测数字与代价
见 `docs/integration.md`。

## 作为 DSH 宿主

同一个包两个入口：`bin` 走 CLI，`main` 指向 `dsh/index.mjs`。宿主层在**每轮第一步**注入一条消息
（灵魂 200 / 用户模型 100 / 处境与零件 670 / 旧会话字面回顾 150，合计 1120 cost，数字只在配置里有一份；
自我块已经在上下文里就不重复发，省下的是复读），
并注册两个工具：`agent_man`（写）与 `agent_man_look`（读）。只对 root 会话生效。
注入里的「建议」段现在真的会有零件答话：注入时按死期限（`parts.deadline`）问一遍 PATH 上的零件，
到点没答上来的记进 `dropped` 并出 `! `，`parts.inject = false` 就整段不跑、行为回到 1.1。

## 文档

- `docs/design.md` —— v3 设计，**本仓库唯一真源**。设计与代码冲突时，先改设计。
- `docs/integration.md` —— 本体与零件的联调记录：四条通道、实测数字、代价与自验步骤。
- `docs/decisions.md` —— 为什么这么选（决定 / 来由 / 代价）。
- `docs/soul-card.md`、`docs/soul-example.md` —— 灵魂卡格式与示例。
- `docs/research-emotion.md` —— 情绪模型的调研底稿（一手来源与数值）。

## 状态

1.1.0。已知限制写在 `docs/design.md` §16（宿主层未实机验、证据区间、`--due`、长表单行排版等）。
旧实现存档在 `archive/v0.4`（`v0.4.0` tag）。

[ci-badge]: https://github.com/yehuoshun/agent-man/actions/workflows/ci.yml/badge.svg
[ci-link]: https://github.com/yehuoshun/agent-man/actions/workflows/ci.yml
