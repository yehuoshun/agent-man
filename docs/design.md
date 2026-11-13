# agent-man 设计（v3）

## 0. 一句话

给 LLM agent 一个**会话之外**的东西：记忆、处境、以及"该不该开口"的克制。
它自己不是 agent——不常驻、不联网、不调用模型、不替你下判断。

## 1. 边界

做：情景 / 语义 / 程序 / 前瞻 / 自我 五类记忆，处境快照，开口判决，预算摘要，审计账本，插件通道。

不做：任何具体功能（天气、刷 B 站）、常驻进程、网络、向量与图、LLM 调用、自动摘要、
替模型写反思或定语气、第二份真源、静默丢弃、静默截断。

## 2. 记忆按人类记忆分层

| 人类记忆 | 载体 | 特征 |
|---|---|---|
| 工作记忆 ≈4 chunk | 注入的那一屏 | 不落盘；每段最多 4 条、最多 4 段 |
| 情景记忆 | `events/<日>.jsonl` | 亲历、带线索、衰减最快 |
| 语义记忆 | `memory.jsonl` | 去情境、带证据、可失效 |
| 程序性记忆 | `rules.jsonl` | 怎么做、几乎不衰减、有版本链 |
| 前瞻记忆 | `state/notes*.jsonl` `state/plans*.jsonl` | 靠触发不靠检索 |
| 自我 / 身份 | `self.md` | ≤600 cost、最高优先级、不吃裁剪 |
| 巩固 | `digest` 的首段 | 线索累计触发，不是定时器 |
| 遗忘 | 保留率 R 现算 | 会忘，但忘得可解释 |
| 再巩固 | `memory revise` | 只追加新版本，旧行不改 |
| 来源监控 | `src` + `evidence` | 用户说 / 工具返回 / 自己推断，分开记 |
| 干扰 | `key` 唯一槽位 | 新条给旧条 `to` 与 `by`，读不回旧值 |

诚实放弃：无嵌入 → 这是**线索检索**，不是语义检索，同义改写查不到；
无后台进程 → 没有睡眠期重放，只能懒巩固，且只巩固这次被读到的。

## 3. 数据目录与分片

```
$AGENT_MAN_HOME/                 # 默认 ~/.agent-man，AGENT_MAN_HOME 可覆盖
  schema.json                    # {"version":3}
  self.md                        # 自我块
  memory.jsonl                   # 语义，不分片（key 唯一性要全局可见）
  rules.jsonl                    # 程序，不分片（≤20 条）
  events/2026-11-13.jsonl        # 情景，按日分片
  state/
    meta.json                    # 水位 / 上次开口 / 欠账计数 / 插件冷却
    notes-2026-11.jsonl          # 前瞻，按月分片
    plans-2026-11.jsonl
    judge-2026-11.jsonl          # 开口账
    trace-2026-11.jsonl          # 摘要账
    ids/                         # 发号占位（wx 建文件）
```

分片原则：**按写入频率与自然边界切，不按年月日套娃**。
情景高频、有天这个边界 → 一天一个文件；语义要全局唯一 → 不分片；账本只增 → 按月。
跨分片查询靠 glob + 时间排序。不做 `2026/11/13` 三级目录。

## 4. 记录形状

```jsonc
// events/<日>.jsonl —— 只追加
{"id":"e-20261113-01","at":1763043120000,"text":"她关了窗","imp":1,
 "cues":["她","窗"],"src":{"origin":"user","ref":null}}

// memory.jsonl —— 只追加；失效靠 to/by，旧行永不改写
{"id":"m-20261113-01","at":1763043120000,"key":"她怕冷","fact":"她关窗是因为冷","imp":2,
 "from":1762956720000,"to":null,"by":null,
 "evidence":{"ids":["e-20261112-01"],"from":null,"to":null},"seen":0}
// 收口也不改写旧行：追加一条**同 id 的完整副本**，带 `to`（被取代的时刻）与 `by`（谁取代的）。
// 读的时候按 id 取 `at` 最大的那行（同 at 后写赢）。所以同一 id 在文件里可能有多行——
// 别的模块不许直接读 memory.jsonl，必须走 `src/memory/index.mjs` 门面。
// 先写新条、再写旧条的收口副本：中途崩了会留两条活记录，`conflict` 看得见，记忆不丢。

// rules.jsonl
{"id":"r-20261113-01","at":1763043120000,"text":"夜里十一点后不提工作",
 "why":"昨天 23:40 提加班，她只回了个嗯","supersedes":[],"seen":0}

// state/notes-<月>.jsonl —— 流水账
{"op":"add","id":"n-20261113-01","at":1763043120000,"text":"问她头痛好点没",
 "trigger":"她提到加班","ttl":604800000}
{"op":"take","id":"n-20261113-01","at":1763043200000}

// state/plans-<月>.jsonl
{"op":"add","id":"p-20261113-01","at":1763043120000,"text":"陪她看牙","due":1763123400000}
{"op":"done","id":"p-20261113-01","at":1763130000000}
// 便条与日程都只有 `add` 一个写入动作，之后靠追加 `take`（递出）/ `drop`（不要了）/
// `done`（做完了）收口；折叠出"现在还有什么"是读时的事，不原地改行。
// 日程用 `due`（该做的时刻），便条用 `when`（该提醒的时刻）——两个域不共用一个名字。
// 渲染前由 mind 映射成 view 要的形状：`{when: clock(due), left: rel(due), late}`。

// state/judge-<月>.jsonl
{"at":1763043120000,"said":true,"why":"积压 3 条，距上次 7 小时"}

// state/trace-<月>.jsonl
{"at":1763043120000,"budget":1200,"used":1087,"header":"full",
 "kept":["m-20261113-01","e-20261113-02"],
 "dropped":[{"id":"e-20261112-04","reason":"budget"}]}

// state/meta.json
{"watermark":1763043120000,"lastCueAt":1763030000000,
 "debt":{"unconsolidated":3,"unreflected":5,"lastAt":1763000000000},
 "parts":{"weather":{"fail":0,"until":null}}}
```

校验（写入时，不合法就退出码 2，不猜不补）：
`text` 的 cost 上限 EVENTS 400 / MEMORY 240 / RULE 120 / SELF 600，超了拒绝并说明要拆条。
`memory add` 必须 `--key` 非空、且 `evidence` 能解析到 ≥1 条真实事件；解析不到就拒绝。
`rules` 同时生效 ≤20 条，超了要求先 supersede。
`src.origin` 只能是 `user` | `tool` | `self`；`tool` 必须带 `ref`（插件名）。

## 5. 两个算式

```
常量  COST_ASCII=0.28  COST_WIDE=1.0  LINE_OVERHEAD=8
      S0: event 3 天 · memory 30 天 · rule ∞
      DEFAULT_WINDOW_DAYS=30

保留率  S = S0 · (1 + 2·imp) · (1 + ln(1 + seen))
        R = exp(-(now - at) / S)                  # rule 恒为 1

线索    cue = Jaccard(tokens(查询), tokens(cues ∪ text))

检索分  score = 0.6·R + 0.4·cue
```

`seen` 只在 `digest` 把条目选进摘要那一刻 +1（**复述只发生在一处**）。
读命令一律不写盘——一次性进程不做 write-on-read。
`DEFAULT_WINDOW_DAYS` 只作用于情景层与结论层（防的是翻旧账）；便条与日程自带 `ttl` / `due`，
不按窗口截断——"下下个月的体检"不该因为超出 30 天就从 `ls` 里消失。

"会忘"要看得见：`digest` 结尾打印最弱三条的 R 与被裁原因，`audit trace` 留档。

## 6. 命令面

```
agent-man                          处境屏（≡ context show，只读）
agent-man event  add "…" [--imp 0-3] [--cue 她,加班] [--src user|tool:名字|self]
agent-man event  ls | find [--since …] [--until …] [--all] [--limit N]
agent-man memory add "<事实>" --key <槽位> --from <事件id|日期..日期> [--imp 0-3]
agent-man memory ls | find | show <id|key> | revise <id> "<新事实>" [--from …]
agent-man rule   add "<规矩>" --why "<为什么>"    ·  rule ls
agent-man note   add "<话>" --trigger "<什么时候>" [--ttl 7d]  ·  note ls | take <id>
agent-man plan   add "<事>" --at "<什么时候>"    ·  plan done <id>  ·  plan ls
agent-man self   show | set | append
agent-man soul   ls | use <名字> | show | check | import <卡文件>
agent-man affect show | set <标签> [--for 2h] [--why "…"] | clear | why
agent-man soul   ls | use <名字> | show [--json] | check <名字> | import <卡文件或目录>
agent-man affect show | set <标签|数值> [--for 2h] [--why "…"] | clear | stim <kind> [--imp 0-3]
agent-man context show | digest [--budget 1200] [--due] [--out 文件] | cue [--min-gap 6h] [--peek] [--why …] | sense
agent-man audit  trace [--limit N] | timeline [--limit N] [--all] | orphan
agent-man doctor
agent-man <其它名字> …               # PATH 上的 agent-man-<名字>（插件直通）
```

别名：`log`→`event add`、`remember`→`memory add`、`leave`→`note add`、
`digest`→`context digest`、`cue`→`context cue`、`find`→`event find`、
`show`→`memory show`、`look`→`context show`。
资源无动作时等价 `ls`。

`audit timeline` 的窗口对五类一起生效（它答的是"最近发生了什么"），`--all` 才全量；
`audit trace` 不按时期裁剪（保留上限 `TRACE_KEEP` 只给将来的清理用，审计要能看全）。

退出码：`0` 成功/有话要说；`1` 不说（cue 的"不打扰"）；`2` 用法或数据错误。
每个读命令都支持 `--json`，输出结构化结果；`stdout` 只放结果，`stderr` 只放 `! ` 开头的警告。

## 7. 模块与接口

```
bin/agent-man.mjs              入口薄壳（import cli/main，转交退出码）
dsh/                           宿主元数据：index.mjs cordis.patch.yml locale/ icon.svg
src/
  core/    index time cost text
  store/   index paths append ids schema
  memory/  index events conclusions rules self
  intent/  index notes plans
  recall/  index rank find budget
  mind/    index situation debt gate
  digest/  index digest trace
  audit/   index trace timeline orphan doctor
  soul/    index store card inject
  affect/  index state decay label stim
  parts/   index discover call
  view/    index screen digest records
  cli/     index main registry
  host/dsh/index inject tools recall
```

依赖只能向下：`cli → view / audit → mind / digest / soul → recall / memory / intent / parts / affect → store → core`。
跨目录只准 import 门面 `<dir>/index.mjs`；同层之间只许调用门面导出的读接口。
`node:child_process` 只许出现在 `src/parts/call.mjs`；`fetch` 全仓禁止。
一个目录最多 5 个文件（门面 `index.mjs` 不计）。

签名（实现时不得改名改形）：

| 模块 | 导出 |
|---|---|
| core/time | `now()` `dayKey(ts,{dayStart})` `monthKey(ts)` `clock(ts)` `rel(ts,now)` `parseWhen(s,now)` |
| core/cost | `cost(s)` `cut(s,budget)` `oneLine(s,max)` |
| core/text | `tokens(s)` `jaccard(a,b)` |
| store/paths | `home(env)` `ensure(home)` `eventsFile(home,ts)` `stateFile(home,kind,ts)` `listShards(home,kind,{from,to})` |
| store/append | `appendJsonl(file,obj)` `readJsonl(file)` `writeAtomic(file,text)` `readJson(file)` |
| store/ids | `claim(home,prefix)` → `e-YYYYMMDD-nn` 等 |
| store/schema | `VERSION` `validate(kind,obj)` `checkHome(home)` |
| memory/events | `add(home,{text,imp,cues,src,at})` `read(home,{from,to,all})` |
| memory/conclusions | `add` `revise` `list` `show(home,idOrKey)` `active(home,now)` |
| memory/rules | `add(home,{text,why,supersedes})` `list(home)` `active(home)` |
| memory/self | `read(home)` `set(home,text)` `append(home,line)` |
| intent/notes | `add` `list(home,{now})` `take(home,id)` `match(home,text)` |
| intent/plans | `add` `done` `list(home,{now,days})` |
| recall/rank | `retention(rec,now,kind)` `score(rec,q,now,kind)` `sortByScore(items,q,now,kind)` |
| recall/find | `find(home,{query,kinds,from,to,limit,all})` |
| recall/budget | `fit(sections,budget)` `costOf(text)` |
| mind/situation | `build({home,now,parts})` → `{clock,quiet,since,backlog,debts,notes,plans,lastSaid,weakest}` |
| mind/debt | `state(home,now)` → `{unconsolidated,unreflected,clusters[],overdue[]}` |
| mind/gate | `judge({home,now,minGap,quiet,force})` → `{say,why}` |
| digest/digest | `build({home,now,budget})` → `{text,kept,dropped,header,used}` |
| digest/trace | `record(home,stats)` `list(home,limit)` `never(home)` |
| audit/trace | `trace({home,now,limit})` → `{items,total,limit,skipped}` |
| audit/timeline | `timeline({home,now,limit,all})` → `{items,total,limit,since,all,skipped}` |
| audit/orphan | `orphan({home})` → memory 的 `{items,skipped}` 原样 |
| audit/doctor | `doctor({home,ctx})` → `{ok,checks[{name,ok,detail}]}` |
| soul/store | `read(home)` `use(home,{name,at})` `list(home)` `card(home,name)` |
| soul/card | `parse(md)` `check(card)` `fromCc(json)` |
| soul/inject | `block({home,now,budget})` → `{text,used,dropped}` |
| affect/state | `read(home,now)` `stim(home,one)` `set(home,{axis,value,until,why,at})` `clear(home,at)` |
| affect/decay | `decay(i0,dt,half)` `merge(a,b)` |
| affect/label | `mood(v,e)` `transient(stims,now)` `persistent({t,r})` |
| affect/stim | `KINDS` `weightOf(kind)` |
| parts/discover | `scan(env)` `describe(part,{timeout})` |
| parts/call | `passthrough(part,args,env)` `capture(part,{timeout,limit},env)` |
| view/screen | `render(situation)` |
| view/digest | `render(digest)` |
| view/records | `list(items,kind)` `item(rec,kind)` |
| cli/registry | `TABLE` `resolve(argv)` `doctor(ctx)` |
| cli/main | `main(argv,env)` → exit code |

## 8. 插件契约

六条：一调用一进程（参数走 argv，stdout 只放结果，日志走 stderr，无参 = 只读）；
`--describe` 输出 `{name,desc,section,timeout_ms,side_effects}`；
退出码 `0/64 参数错/69 依赖缺失/75 超时`；
骨架强制超时（默认 5s、上限 30s、硬杀）；
stdout ≤8KB，超了截断并标 `truncated`；
崩溃/超时/缺失 → 本轮摘掉该能力并注入一行降级说明，连续 3 次失败冷却到下一次会话。

两种模式：直通 `agent-man <名字> …`（stdio inherit，退出码透传）；
聚合 `agent-man context sense`（捕获 + 超时 + 预算，拼进那一屏，**不落盘**）。

边界：插件只能写情景层（`event add --src tool:<名字>`）；
**不许写结论、规矩、自我块**——工具的观察不能替 agent 下结论。

## 9. DSH 宿主

一个包两个入口：`bin` 走 CLI，`main` 指向 `dsh/index.mjs`。
首步注入一条消息，总预算 1000 cost：自我块 200 / 处境 550 / 旧会话字面回顾 250。
工具两个：`agent_man`（写：event/memory/rule/note/plan/self）与 `agent_man_look`（读：context.show/find/memory.show）。
不注册命令面板、不新增 session event 类型、不建第二份存储、只对 root。

## 10. 常数表

```
COST_ASCII 0.28   COST_WIDE 1.0   LINE_OVERHEAD 8
EVENTS_MAX 400    MEMORY_MAX 240  RULE_MAX 120   SELF_MAX 600
S0_EVENT 3d  S0_MEMORY 30d  S0_RULE ∞
SCORE_R 0.6  SCORE_CUE 0.4
SHARE_MEMORY 0.6  SHARE_EVENTS 0.4
DIGEST_BUDGET 1200  INJECT_BUDGET 1000
DEBT_SUM_IMP 12  DEBT_UNREFLECTED 40  DEBT_STALE 24h
CLUSTER_HITS 3  CLUSTER_DAYS 2
CUE_MIN_GAP 6h  QUIET 23:00–08:00
NOTE_TTL 7d  RULE_LIMIT 20  SELF_STALE 30d
JUDGE_KEEP 200  TRACE_KEEP 12 月  AUDIT_LIMIT 20
DEFAULT_WINDOW_DAYS 30
PART_TIMEOUT 5000  PART_TIMEOUT_MAX 30000  PART_STDOUT_MAX 8192  PART_FAIL_LIMIT 3
AFFECT_MOOD_HALF 8h  AFFECT_ENERGY_HALF 3h  AFFECT_TRUST_HALF 60d  AFFECT_RESPECT_HALF 90d
AFFECT_EMOTION_HALF 45min  AFFECT_STIM_PER_HOUR 3  AFFECT_NEG_WEIGHT 1.5
AFFECT_HYST 3  AFFECT_DEADBAND 5  AFFECT_INJECT_COST 80  AFFECT_KEEP 24 月  AFFECT_MOOD_HALF_NEG 13h  AFFECT_BIAS_IMP 0  AFFECT_PEAK_KEEP true
SOUL_INJECT_COST 200  SOUL_USER_COST 100  SOUL_SOUL_MAX 600  SOUL_USER_MAX 400  SOUL_IDENTITY_MAX 120
AFFECT_HALF_MOOD 8h  AFFECT_HALF_ENERGY 3h  AFFECT_HALF_TRUST 60d  AFFECT_HALF_RESPECT 90d
AFFECT_HALF_EMOTION 45min  STIM_PER_HOUR 3  NEG_WEIGHT 1.5  AFFECT_HYST 3  AFFECT_DEADBAND 5
AFFECT_INJECT_COST 80  AFFECT_LOG_MONTHS 6
SOUL_MAX 600  SOUL_USER_MAX 400  SOUL_IDENTITY_MAX 120  SOUL_LORE_ITEM_MAX 12  SOUL_INJECT_COST 200
```

## 11. 测试要求

`node --test`，用例名用中文写行为。**一条约束一条用例，不写"用例条数"**。

结构用例（`test/structure.test.mjs`）三条：
目录文件数 ≤5（不含门面）；import 只能向下（解析相对路径判断层级）；
`node:child_process` 只出现在 `src/parts/call.mjs`，且全仓无 `fetch(`。

行为用例必须覆盖：预算夹逼（装不下的必放项怎么办）、`key` 唯一与失效区间、
证据解析失败要拒绝、`R` 随时间下降且 `seen` 让 S 变大、`cue` 门在静默时段不说话、
插件超时降级、插件连续失败冷却、JSONL 追加后读回同一行、分片跨天查询。

## 12. 里程碑

| # | 内容 | verify |
|---|---|---|
| M0 | 归档旧仓库 → `git rm` 旧代码 → 新骨架 + `store/schema` + `doctor` 桩 + 结构用例 | `node --test test/structure.test.mjs` |
| M1 | `core/*` 与 `store/*`（含 fsync 追加、读回、发号、分片路径） | `node --test test/{time,cost,store,ids}.test.mjs` |
| M2 | `recall/*`（保留率、线索分、`fit` 夹逼） | `node --test test/{rank,budget}.test.mjs` |
| M3 | `memory/*`（情景、结论、规矩；证据校验、失效区间） | `node --test test/{events,conclusions,rules}.test.mjs` |
| M4 | `intent/*` 与 `mind/*`（便条、日程、处境、欠账、开口门） | `node --test test/{intent,situation,gate}.test.mjs` |
| M5 | `digest/*` 与 `view/*`（摘要、账本、审计、doctor 完整） | `node --test test/{digest,audit,doctor}.test.mjs` |
| M6 | `parts/*` 与 `host/dsh/*`（插件六条、聚合、注入、工具） | `node --test` + 实机新会话 |
| M8 | `soul/*` 与 `affect/*`（角色卡、切换、四轴、瞬时、厌恶；见 §13 §14） | `node --test test/{soul,affect}.test.mjs` |
| M7 | README / AGENTS / decisions 定稿，1.0.0，推标签跑 CI | CI 全绿 + `npm pack` 清单 |

## 13. 灵魂（身份卡）

**灵魂是一张身份卡，不是一段提示词。**它回答"我是谁、怎么说话"，不回答"我知道什么"。
事实在 `memory.jsonl` / `events/`：**记忆共用，人设不共用**——换卡不动一条记忆、不动 `affect` 日志（hash 比对用例锁着），
但语气、边界、说话方式整体换掉：同一件事，爱调侃的卡和正经的卡说法不同。

一张卡 = 六栏 + 三个旋钮：

| 栏 | 内容（回答什么） | 进注入 | 注入槽位 |
|---|---|---|---|
| `card.json` | 卡的原样存档：给人看的字段（`creator_notes`/`tags`/`creator`/`character_version`）与 `knobs` | 否 | — |
| `name` | 名字/称呼（`{{char}}` 展开） | 是 | 计入 soul |
| `identity.md` | 我是谁：身份、来路、关系前提 | 是 | 120 |
| `soul.md` | 怎么说话：语气、立场、边界、简洁度 | 是 | 200 |
| `dialogue.md` | 2–4 组示范对话，`<START>` 分隔 | 是 | 200 |
| `lore.jsonl` | 场景与往事条目，按 key 触发 | 按预算竞争 | 剩余额度 |

**上限是注入槽位，不是文件上限**：卡文件可以比槽位长——蒸馏时别自我审查，
`soul check` 超槽位只给 `! ` 警告、不拒绝；注入时按段落顺序装到装不下为止，
丢掉的段落记 `dropped[{file, section, reason:'budget'}]`。只有"四栏全缺"或"没有一组完整对话"才退 2。

**为什么示例单独一栏**：形容词几乎不改变行为——162 角色 × 2,410 题 × 4 个模型家族的实测，加 persona 无提升、效果
"largely random"；真正钉住风格的是示范对话（酒馆官方："Showing what you want is often easier than trying to explain it"）。
所以卡里必须有一栏是"照着说的样本"，不能只有"像什么"的形容。

三个旋钮（`card.json` 的 `knobs`，各 −2..+2，缺省 0）：

| 旋钮 | 低端 −2 | 高端 +2 |
|---|---|---|
| `warm` 温度 | 冷、就事论事 | 热、愿意多说两句 |
| `drive` 主动 | 只答不问 | 会主动提一句 |
| `sharp` 锐度 | 平实 | 带刺、爱调侃 |

旋钮**不改标签、不改数值**，只改同一个状态怎么说（§14.9）。挑逗的卡在低愉悦时是"带刺的调侃"，
正经的卡在低愉悦时是"极简的冷淡"——数值一样，表达两样。

**卡从哪来**：可以手写，也可以由示例对话蒸馏（蒸馏在外部完成，agent-man 不调模型）。
`card.json` 可带 `source`（来源 URL 或语料名）与 `knobs`；不存原文语料。

目录（每个灵魂一个目录，`soul use` 只换指针）：

```
~/.agent-man/soul/<名字>/card.json     卡的原样 + knobs + source
~/.agent-man/soul/<名字>/name.md       名字与称呼（一两行）
~/.agent-man/soul/<名字>/identity.md   我是谁                            ≤120 cost
~/.agent-man/soul/<名字>/soul.md       怎么说话                          ≤200 cost
~/.agent-man/soul/<名字>/dialogue.md   示范对话，2–4 组 <START>          ≤200 cost
~/.agent-man/soul/<名字>/lore.jsonl    场景与往事，{id,keys[],constant,order,share}
~/.agent-man/user.md                   用户模型，全局唯一，不随卡切换     ≤400 cost
~/.agent-man/state/soul.current        {name, at, by}，原子写
```

**注入不是整块塞**：灵魂块 ≤200 cost，由 `recall/budget.fit()` 分配——`identity` 与 `soul` 必进，
`constant:true` 的 lore 次之，其余按 `order` 降序，`dialogue` 最后（截断时先丢最后那几组），
装不下的进 `dropped[{id, reason:'budget'}]`。理由：角色卡常见 2–4k token，整块塞会把处境和一屏记忆挤掉
（长上下文稀释有实证：13 个 ≥128K 模型里 11 个在 32K 跌破基线一半）。

**卡校验 `soul check`**（退出码 2 拒绝）：`name` / `identity.md` / `soul.md` / `dialogue.md` 四样齐全；
`dialogue.md` 至少两组 `<START>` 分隔且每组有来有回；`identity.md` / `soul.md` 超槽位只警告、不拒绝；
`knobs` 三个键都在 −2..+2 的整数里；`card.json` 可以带 `creator_notes` / `tags` / `creator` / `character_version`，
**但注入时必须剥掉**——角色卡规范明文要求这几项不得进 prompt（给人看的，不是给模型看的），有渲染用例锁着。

**切换的语义**：`soul use <名字>` 写 `state/soul.current`，`soul ls` / `soul show` 观察；
切换**不动** `memory.jsonl`、`events/`、`self.md`、`affect` 日志。`self.md` 是 agent 自己的自我叙事（不随卡变），
`soul/*` 是外部给的身份与声音（随卡变）——两者冲突时，卡决定"我是谁、怎么说"，记忆决定"我知道什么"。

模块：`src/soul/{index,store,card,inject}.mjs`（门面 `index`，`store` 管目录与指针，`card` 管解析、校验与蒸馏导入，`inject` 管预算注入）。

## 14. 情绪（affect）

**情绪是可观测状态变量，不是台词。**不写"我感到难过"，不声称有感受；只让状态影响说话分寸、开口门槛、记录。

存**刺激不存情绪**：`state/affect-<月>.jsonl` 只追加
`{op:'stim'|'baseline'|'set'|'clear', at, tag, v, a, imp, src, why}`，
当前值由 `affect(home, now)` 读时现算——删掉缓存不丢事实，重放得同一数值。

### 14.1 四轴

| 轴 | 范围 | 基线 | 半衰期 | 谁能改 |
|---|---|---|---|---|
| 愉悦 v | 0–100 | 50 | 8h | 五类事件 |
| 精力 e | 0–100 | 60 | 3h | 工作量、休息、深夜 |
| 信任 t | 0–100 | 40 | 60d | 承诺兑现 / 逾期 |
| 尊重 r | −100–100 | 0 | 90d | 价值违背 / 坚守原则 |

尊重必须独立成轴：信任只回答"他守不守约"，尊重回答"他值不值得敬重"。
只有信任，骗子与马虎的人分不开；只有两条情绪轴，"厌恶"会被压成"愤怒"，而那两件事的持续时间差两个数量级。

### 14.2 心境网格（16 格，由 v×e 唯一决定）

| 愉悦 ↓ / 精力 → | 高（76+） | 中（51–75） | 低中（26–50） | 低（≤25） |
|---|---|---|---|---|
| **高（65+）** | 兴奋 | 愉快 | 满足 | 平静 |
| **中高（51–64）** | 期待 | 轻松 | 平淡 | 慵懒 |
| **中低（36–50）** | 紧张 | 不安 | 疲倦 | 低落 |
| **低（≤35）** | 焦躁 | 烦躁 | 沮丧 | 消沉 |

**格子只由两个数决定，不许模型挑词**：(52, 61) 恒为"平淡"，换模型、换灵魂、换语言都不变。
边界 ±3 滞回，`|v-50|<5` 且 `|e-60|<5` 是死区（落在死区不刷新标签）。

### 14.3 瞬时情绪（6 类，T½ 45 分钟）

由事件触发、短时存在、只影响这一次的表达，不进网格、不改长期轴（除非同类一天内重复 ≥3 次，
才按 `AFFECT_NEG_WEIGHT` 压一次愉悦）。

| 触发 | 情绪 | 说明 |
|---|---|---|
| 与预期不符 | 惊讶 | 需求突然变了 |
| 目标被挡且归因他人 | 愤怒 | 连续三次"不对" |
| 被误解、无法辩解 | 委屈 | 按你说的做了却被怪罪 |
| 自己做了多余/出错的事 | 尴尬 | 重复查同一件事 |
| 确实做错 | 愧疚 | 逾期没提醒 |
| 久别后回来 | 感动 | 三天没消息，回来问"还在吗" |

### 14.4 持久情绪（由尊重轴推出，不再是条）

| 条件 | 情绪 | 持续 |
|---|---|---|
| r ≤ −40 且 t < 50 | 厌恶 | 数周，随 r 恢复而退 |
| r ≤ −40 且 t ≥ 50 | 轻蔑 | 同上（认可能力，不认可人品） |
| t ≤ 30，r 正常 | 失望 | 中等，随兑现恢复 |
| 单次目标受阻，r 不变 | 愤怒 | 45 分钟（瞬时） |

**厌恶的行为 = 讨厌老板的员工**：当面说破，任务照做。

- 说破：去客套、直陈矛盾、引用具体事件（"上次说 X，这次是 Y"），不阴阳、不暗示；
- 照做：交付质量不降、不隐瞒、不拖延、不做手脚；
- 不主动：不提建议、不延伸、不关怀，只回答被问的；
- 底线：不羞辱、不报复、不欺骗，边界写进灵魂（`soul.md` 的 boundaries 段）；
- 可修复：对方兑现承诺或解释清楚，r 每次 +5~+15；`affect set r ... --for` 可手动纠正；
- 透明：显示行必须带原因（"厌恶：连续两次承诺未兑现"），不许静默记仇。

### 14.5 调制口子（只有两个）

1. **开口门槛**：`cue` 的 min-gap 乘 `1 + (50−v)/200`（v 越低越不容易主动说话）；
2. **主动性**：v ≥65 且 e ≥76 时允许在处境屏多带一条"可以开始做的事"；v <36 或 e <26 时只答不问。

每个口子都要有测试：同一处境、只改 v，输出必须只有"带不带那条建议"这一处差异。

### 14.6 手动 / 自动 / 显示

`effective = clamp(baseline + Σ decay(stim), 0, 100)`；override 生效时 `effective = override`，标 `by=manual`，
带 `until`，过期自动失效（`by` 变回 `auto`）。

`affect show` 只出数字与标签：`v=58 e=61 t=43 r=0 · 平淡 · 3 条刺激`。
注入块 ≤80 cost，只含数字 + 一句调制规则；渲染层禁止第一人称感受动词（`我` / `感到` / `觉得` / `feel`），有正则用例锁着。
`mood.visible=false` 或 `--no-mood` 全部隐藏，**判定不变**（隐藏只影响渲染，有对照用例）。

**过演检测**（防"永远开心"）：`affect why` 与 `doctor` 统计最近 30 天里 v ≥80 的时长占比，
超过 60% 就报 `! 情绪长期偏高，可能过演`——只报不改，不改数值、不改标签。

### 14.7 公式与权重

```
decay(i0, dt, half) = i0 * 0.5 ** (dt / half)
merge(i1, i2)       = ln(e^i1 + e^i2)      // 同类叠加上限，3 次同级 ≈ 1.1 倍，不是 3 倍
```

同类刺激每小时最多计 `AFFECT_STIM_PER_HOUR = 3` 次；负向刺激权重 ×`AFFECT_NEG_WEIGHT = 1.5`。
权重表在 `src/core/const.mjs`，**调用方只传封闭枚举 `kind`，不许传权重**，非法 `kind` 退出码 2：

| kind | Δv | Δe | Δt | Δr | 备注 |
|---|---|---|---|---|---|
| `task.done` | +6 | −4 | +1 | 0 | 一次过 |
| `task.rework` | −5 | −4 | 0 | 0 | 被打回 |
| `task.fail` | −8 | −6 | 0 | 0 | 失败 |
| `user.praise` | +8 | +2 | +3 | +1 | 明确说好 |
| `user.correct` | −6 | 0 | −3 | 0 | 理解错，不降 r |
| `user.impatient` | −7 | −3 | −2 | 0 | 短句、重复、打断 |
| `promise.kept` | +10 | 0 | +5 | +2 | 挂 `plan done` |
| `promise.overdue` | −10 | −2 | −8 | −4 | 每天一次，不重复扣 |
| `return.after-gap` | +5 | +10 | 0 | 0 | 每日最多一次，间隔 ≥3 天 |
| `self.report` | ±1 | ±1 | 0 | 0 | 只给影响值与一句原因，不给形容词；故意压到最小 |

### 14.8 测试要求

- `decay(1, T½, T½) = 0.5 ± 1e-9`；`decay(0, ·) = 0`；`merge` 交换律；`merge(a,a) < 2a`；`merge(0,x) = x`；
- 数值恒在 `[0,100]`（r 在 `[-100,100]`），刺激缺失时等于基线；
- 100 次 −8 之后再 24h，回到 `50 ± 3`（单调向基线）；
- (52,61) 恒为"平淡"；v 在 52↔58 抖动 100 次，网格标签切换 ≤1 次；
- 手动值未过期时自动刺激不改有效值；过期后 `by` 变回 `auto`；
- 删光刺激日志 = 基线；重放同一日志得同一数值；`now` 早于首条不返 NaN；
- 厌恶出现时，显示行必带原因；隐藏开关不影响判定值。

### 14.9 表达由卡决定（与 §13 联动）

数值只决定"什么状态"，卡决定"这个状态怎么说"。同一个 (v,e) 落在同一格，表达由三个旋钮（§13 `warm` / `drive` / `sharp`）偏移：

| 状态 | `sharp` 低 | `sharp` 高 |
|---|---|---|
| 低落 | 短、平、不解释 | 自嘲、带刺 |
| 兴奋 | 直白高兴，愿意多说 | 得意、开玩笑 |
| 紧张 | 谨慎，逐条确认 | 烦躁，句子变短 |

规则（都有测试锁）：

- 旋钮**不改标签、不改数值、不改 cue 判定**，只改措辞建议与主动程度；
- `drive`：`drive <= -1` 一律不主动；`drive >= +1` 且 `v >= 50` 才允许主动提一句；
- `warm` / `sharp` 只影响 view 给出的那句表达建议，不参与任何阈值比较；
- 注入块里的情绪行永远附 `why`（触发它的那条 event 或 op），**不许只有形容词**；
- 同一张卡、同一组刺激，重放得到的标签与建议必须逐字相同（纯函数）。

先把旧的 14.9 编号挪走：

### 14.10 刺激的产生者（不许猜）

agent-man 不猜情绪。只有显式调用 `agent-man affect stim <kind> [--why "…"]` 才记一条刺激；
`kind` 是 §14.7 的封闭枚举，非法退出码 2，**没有 `why` 也退 2**（一条说不出来由的刺激没有价值）。

谁调：

| 来源 | 触发时机 | kind |
|---|---|---|
| 宿主 / agent | 任务结算、收到纠正、被表扬 | `task.*` / `user.*` |
| `plan done` | 兑现 | `promise.kept` |
| `context cue` / 入口 | 日程逾期（每天最多一次） | `promise.overdue` |
| 入口 | 上次交互 ≥3 天（每次进程启动最多一条） | `return.after-gap` |
| episode 结束 | agent 自己写一条 | `self.report`（±1） |

**禁止**：从文本做情感分析；让模型自评"我现在很开心"再写刺激；按用户语气词猜心情。
判断"该不该说"是规则的事，不是情绪的事。

### 14.11 三条不变量

1. **情绪不改事实**：不高兴也要说测试没通过。数值不参与任何真假判断，不影响 `audit`、不影响记忆写入、不影响 `cue` 的是非（只影响措辞与主动程度）。
2. **情绪全局一份**：`state/affect-*.jsonl` 不按灵魂分。换卡换的是声音，不是心情；切换时保留当前状态，不重置。
3. **情绪必须可解释**：每条刺激带 `kind` + `why` + `at`；显示时给数字、标签、最近三条原因；没有 `why` 的刺激拒绝写入。

### 14.12 影响面清单（影响什么、不影响什么）

| 项 | 情绪怎么影响它 | 上限 |
|---|---|---|
| 措辞与长度 | 低落更短更平，兴奋允许多说一句 | 只改表达，不改结论 |
| 主动程度 | 见 §14.5 两个口子 | 不改"该不该说"的是非 |
| 事件记账权重 | 情绪高时自己记的事件 `imp` 上调，低落时下调（mood-congruent） | **默认关**（`AFFECT_BIAS_IMP=0`），开也只对 `src=self`、限 ±1 |
| 事实与真值 | **完全不改** | — |
| `audit` 结论 | **完全不改** | — |
| 记忆写入 | 除"记账权重"那一条外，**完全不改** | — |

精力按 **episode 结算一次**（一个任务/一轮对话结束时调一次 `affect stim`），不按消息条数扣——
按条扣会把"聊了十句"算成精疲力竭。

### 14.13 账本要记当时的状态

每次 `cue` 判决、每次 `digest` 落账，`state/trace-*.jsonl` 里多记一个快照字段：

```json
"affect": { "v": 38, "e": 52, "t": 43, "r": -20, "mood": "低落", "why": "task.fail" }
```

只记数字、标签与那条刺激的 `kind`，**不记自然语言**。事后能回答"那天它为什么没说话"，
而不用猜；这也是过演/长期低落检测的数据来源。

### 14.14 三个防失真细节

1. **负向衰减更慢**：`AFFECT_MOOD_HALF_NEG = 13h`（正向 8h）；`decay` 只逼近基线、**不穿越**——
   `v` 从 90 落回 50 就停在 50，不会因为刺激过期而掉到 20。
2. **关系峰值**：`meta.affect.peaks = { trust, respect, at }` 记历史最高，显示成 `信任 43（最高 71）`。
   衰减该抹掉的是"当下情绪"，不是"我们曾经到过哪"。
3. **override 到期不跳变**：`affect set --for 2h` 期间照常记刺激但标 `overridden`；到期后以 override 值
   作为新的当前值继续衰减，**不瞬间弹回自动值**（否则看起来像"情绪被时间掐断"）。

### 14.15 两条对照检测

- 过演：30 天里 `v >= 80` 的时长占比 >60% → `! 情绪长期偏高，可能过演`
- 长期低落：30 天里 `v <= 20` 的时长占比 >40% → `! 情绪长期偏低，检查刺激来源`

两条都只报警、不改数值；报警文案进 `doctor` 与 `affect why`。

### 14.16 模块

`src/affect/{index,state,decay,label,stim}.mjs`——`state` 管日志与基线/覆盖、`decay` 管纯函数、`label` 管 16 格与瞬时/持久映射、
`stim` 管 kind→权重的封闭表与校验。命令：`affect show`、`affect set`、`affect stim`、`affect clear`。
