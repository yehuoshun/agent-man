# agent-man

给 LLM agent 补上它没有的那一层：**会话之外的记忆、此刻的处境、该不该开口**。

它自己不是 agent——不常驻、不联网、不调用模型、不替你下判断。它只做三件事：
把发生过的事分层记住、把"现在是什么时候、谁在等什么"摆出来、给出"这次该不该说话"的判决。
说不说、说什么，仍然由模型自己决定。

零依赖、纯 `node:` 内置、Node ≥ 20。

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
agent-man note   add|ls|take          便条
agent-man plan   add|done|ls          日程
agent-man self   show|set|append      自我块
agent-man soul   ls|use|show|check|import  灵魂卡（角色卡）
agent-man affect show|set|clear|why   情绪（四轴：情绪/精力/信任/尊重）
agent-man context show|digest|cue|sense    处境屏、摘要、开口判决、零件聚合
agent-man audit  trace|timeline|orphan     审计账本
agent-man config show|get|set|reset   配置（唯一真源，读命令无副作用）
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
支持导入 SillyTavern 的 CCv1/V2 角色卡，`creator_notes` 之类只进 `card.json`、不进注入。名字、身份、说话方式走常驻预算，往事与示范对话按触发竞争——**切角色不切记忆**，
角色换的是人设与说话方式，我记住的事还在。

## 情绪

四条轴：情绪 `v`、精力 `e`、信任 `t`、尊重 `r`（`r` 可负）。只做状态，不演台词：
影响的是开口门槛与语气分寸，不上屏就被忽略（`affect.visible` 可关）。
瞬时情绪这一版不启用（理由见 `docs/decisions.md`）：宁可说"最近 45 分钟有 3 条刺激"，
也不给一个编出来的情绪名字。

## 插件

PATH 就是注册表：`agent-man-foo` 装上就能 `agent-man foo …`。契约六条（一调用一进程、
`--describe` 自报家门、退出码 `0/64/69/75`、骨架强制超时、stdout ≤ 8KB、连续三次失败冷却）。
插件只能写情景层（`event add --src tool:<名字>`），不许写结论、规矩、自我块——
工具的观察不能替 agent 下结论。

## 作为 DSH 宿主

同一个包两个入口：`bin` 走 CLI，`main` 指向 `dsh/index.mjs`。宿主层在首步注入一条消息
（灵魂 200 / 用户模型 100 / 处境 550 / 旧会话字面回顾 150，合计 1000 cost，数字只在配置里有一份），
并注册两个工具：`agent_man`（写）与 `agent_man_look`（读）。只对 root 会话生效。

## 文档

- `docs/design.md` —— v3 设计，**本仓库唯一真源**。设计与代码冲突时，先改设计。
- `docs/decisions.md` —— 为什么这么选（决定 / 来由 / 代价）。
- `docs/soul-card.md`、`docs/soul-example.md` —— 灵魂卡格式与示例。
- `docs/research-emotion.md` —— 情绪模型的调研底稿（一手来源与数值）。

## 状态

1.0.0。已知限制写在 `docs/design.md` §16（宿主层未实机验、证据区间、`--due`、长表单行排版等）。
旧实现存档在 `archive/v0.4`（`v0.4.0` tag）。
