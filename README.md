# agent-man

给 agent 一个会话之外的生活。

[tests](https://github.com/yehuoshun/agent-man/actions/workflows/ci.yml)

不是框架，是零件。每个零件只做确定性的那部分，语义判断留给模型。

```
记事   agent-man log / remember / digest / recall / find / trace / show
定时候  agent-man cue
递话    agent-man leave
看天气  agent-man place / sky
日程    agent-man plan                              ← 现在在这里
```

## 为什么

模型的自我只活在上下文窗口里。会话一结束，它就消失；下次开新窗口，它不记得昨天发生过什么，也不会在没人说话的时候想起来找你。

所以零件必须跑在模型进程之外——用文件、用状态目录、用系统时间。这不是架构偏好，是那一句话的直接推论。

而且跑一次就退出：不常驻、不轮询、不监听，占用的只有那几十毫秒（见 `docs/decisions.md` §22）。

四条从主题推出来的边界：

1. **只存不说**。脚本负责记，说不说、怎么说，由模型自己定。
2. **给处境，不给台词**。投递一句"这会儿 21:40，你之前想过……"，而不是"〔定时任务到点〕"。
3. **保真优先于压缩**。宁可这次不更新，也不让记录被改写。
4. **降噪是必需项**。每天都发生的事不进队列，否则模型会学会忽略它。

## 现在能做什么

```bash
# 记一条日记（原文，只追加）
node bin/agent-man.mjs log "她把窗关上了，说外面风大" --weight 2 --feel "被照顾到" --kind dm

# 记一条长期记忆（模型整理出来的结论，必须带出处）
node bin/agent-man.mjs remember "入秋后先关窗再抱怨风" --topic 她怕冷 --refs 2026-11-05,2026-11-09

# 给自己定一条规矩（是约束，不是回忆；没有 --why 定不下来，改就 --supersedes 一条新的）
node bin/agent-man.mjs rule "夜里十一点后不提工作" --why "昨天 23:40 提加班，她只回了句嗯"
node bin/agent-man.mjs rule "夜里十点后不提工作" --why "她说到十点就困" --supersedes 2026-11-10-02

# 把日记、结论、规矩、判断摆成一条时间线（现读现排，不落任何新数据）
node bin/agent-man.mjs timeline --limit 20
node bin/agent-man.mjs timeline --kind rule --since 2026-11-01

# 渲染成能直接贴进上下文的摘要（长期 60% / 日记 40%，谁没用完借给对方）
node bin/agent-man.mjs digest --budget 1200
node bin/agent-man.mjs digest --budget 800 --out ~/.agent-man/digest.md

# 问一句"我欠了几次巩固"（不排 cron：被叫起来时顺手结账，见 docs/decisions.md#15）
node bin/agent-man.mjs digest --due

# 看账：每次 digest 装下了什么、丢了什么；哪些日记从来没进过摘要
node bin/agent-man.mjs trace
node bin/agent-man.mjs trace --never

# 看原始流水 / 看长期记忆
node bin/agent-man.mjs ls --limit 20
node bin/agent-man.mjs recall --tier 0

# 找原文：摘要只压不取，"那件事当时到底怎么说的"只有日记答得上来
node bin/agent-man.mjs find 窗 --since 2026-11-01
node bin/agent-man.mjs find 关窗 --kind dm --limit 5
```

```bash
# 问一句"这会儿该不该开口"：只给处境——几点了、上次说话多久前、之后攒了什么
node bin/agent-man.mjs cue
node bin/agent-man.mjs cue --force   # 手动问，无视 6 小时间隔与静默时段
node bin/agent-man.mjs cue --peek    # 看一眼，不记水位
node bin/agent-man.mjs cue --why "她在开会，晚点再提"   # 记下这次为什么说／为什么没说
```

带上 `--why` 之后，这次判断会写进 `state/judge.jsonl`（只留最近 200 条），下次 `cue` 的末尾先还给你
一句 `上次：3 小时前没说话——她在开会，晚点再提`。脚本只存和还，不评价上一次的理由对不对——
判断仍然是每次会话里那个模型自己的事（见 `docs/decisions.md` §35）。

```bash
# 顺着一条结论找回原文：recall 尾巴上那串 refs 现在能用了
node bin/agent-man.mjs show 她怕冷
```

```bash
# 给下一次的自己留一句：cue 递出，递过就烧，7 天不取作废
node bin/agent-man.mjs leave "记得问她头痛好点没" --when 她提到加班时
```

```bash
# 记下你在哪儿：坐标查一次就存住，之后看天不再问
node bin/agent-man.mjs place 上海

# 外面什么样、跟上次比变了什么——变了才开口，没变就一句"和上次一样"
node bin/agent-man.mjs sky
```

天气只报变化：天况换类、最高温跳 5℃、有雨而上次没有、第一次进极热极冷。
取数走 Open-Meteo（不要 key），半小时内复用缓存；断网时能报旧数，但会写明那是几点的数
（见 `docs/decisions.md` §25）。

```bash
# 记下要做的事：写一句话就是新加一条，--done 划掉
node bin/agent-man.mjs plan "陪她去看牙" --at "2026-11-14 09:30"
node bin/agent-man.mjs plan                     # 接下来 7 天
node bin/agent-man.mjs plan --done 2026-11-14-p01
```

日程只做记录和陈列：`sky` / `cue` 会顺带说今天还剩几条，但日程自己不会"到点提醒"——
什么时候提、怎么提是模型的事（见 `docs/decisions.md` §26）。

断电、闪退、卡死都不会悄悄丢记忆：每次写入都 fsync，写完当场读回最后一行核对，
半行会立刻报错而不是等下次读才发现（见 `docs/decisions.md` §20）。

选项名写错不会被忽略：`--waight` 直接报错并提示 `--weight`，退出码 2（见 `docs/decisions.md` §16）。

`digest` 的输出：

```markdown
# 我记得的事
<!-- agent-man · 日记 5 条 / 长期 2 条 · 取 5+2 · 预算 1200 · 条目 240 · 丢 0 · 截 0 · 2026-11-12T01:08:05+08:00 -->

## 我给自己定的规矩
- 夜里十一点后不提工作（第 2 版）

## 记住的事
- 她怕冷：入秋后先关窗再抱怨风（11-02 ~ 11-09）
- 她喝什么：爱喝冰的，胃疼那两天会点热的

## 不会忘的
- 昨天 22:40 · 那天晚上我们聊了很久，从窗户聊到风，从面聊到盐，最后谁也没说到底是谁先睡着的。…
- 1 小时前 · 第一次跑通整条链路

## 最近
- 5 小时前 · 煮了番茄面，盐放多了
- 8 分钟前 · 今天风大
```

数据就是两个 JSONL，一行一条，`cat` 能看、`grep` 能搜、坏了能手改：

```json
{"at":1794415872000,"kind":"dm","fact":"她把窗关上了，说外面风大","weight":2,"feel":"被照顾到"}
{"id":"2026-11-12-01","at":1794424114448,"tier":0,"batch":"2026-11-12","topic":"她怕冷","fact":"入秋后先关窗再抱怨风","span":{"from":1793577600000,"to":1794182400000},"refs":["2026-11-05","2026-11-09"],"supersedes":[]}
```

规矩和结论住同一个 `memory.jsonl`，只是多两个字段：`kind:"rule"` 和 `why`（哪件事让它出现）。
摘要里规矩单独一节、排在结论前面——它是"我答应过自己怎么做"，不是"我记得这回事"（§36）。

`events.jsonl` 是日记层，`memory.jsonl` 是长期层。两者都只追加：日记永不删，
长期条目要合并就新写一条、用 `supersedes` 指过去，旧行不动。总结由模型做，
脚本只负责挑和存——见 `docs/decisions.md` §11。

## 扩展零件：不聚合进这个仓库

扩展功能一律做成**独立的命令、独立的包**，不并进这个仓库。`agent-man` 在自己的命令表里找不到
`<名字>` 时，去 PATH 上找 `agent-man-<名字>`，把参数原样转交、把它的退出码原样返回：
`npm i -g` 装上就有，`npm rm -g` 卸了就回到"未知命令"，这个仓库里不留清单、也不 import 别人的包。
PATH 就是注册表，npm 就是安装器（为什么这么定，见 `docs/decisions.md` §32）。

```bash
npm i -g agent-man-bili           # 一个零件 = 一个包：独立仓库、独立发版
agent-man bili feed --limit 5     # 本仓库不认识 bili → 转给 PATH 上的 agent-man-bili
agent-man bili --help             # 零件的选项是它自己的，这里不列
```

零件只守三条，改其中任何一条都算破坏兼容：

1. **一个进程**——被调一次、跑完退出，不常驻、不轮询（见 §22）；要定时就由外部调度器来调它。
2. **数据只走两个口子**——`agent-man log … --src <名字>` 和 `agent-man remember …`，不直接碰
   `events.jsonl` / `memory.jsonl` 的格式。带上 `--src`，摘要里就看得见这条是谁记的（`[note|bili]`）。
3. **参数自己解释**——主项目不认识零件的选项，写错了由零件自己报，`--help` 也不列它们。

这个仓库不维护零件清单：PATH 上有谁，`agent-man <名字>` 就能用谁。反过来，如果一个"零件"反复
需要动主项目内部——想 import 它的函数、想改存储格式、想跟它同版本发——那它就不是零件，该搬进
`src/` 变成核心命令。

## 三条硬承诺

- **预算不可协商**。任何一条都不能让渲染结果超预算，包括 `weight=3`。
- **不静默丢弃**。被切的记"截"，没进去的记"丢"，`weight=3` 被丢会单独报警。
- **时间只解释一次**。入库全是 epoch ms，展示时才转本地时间；相对时间每次现算，不写死进文本。

## 接进调度器：谁的钟

零件自己不睡、不循环、不常驻：`cue` 被敲一次，回答一句"这会儿该不该开口"，然后退出。
所以模型不在的时候，得有别的什么东西按时敲它——那个"别的"就是宿主或系统调度器。

`cue` 的契约只有两条：

- 该开口：把要说的话打到 stdout（几点了、上次说话多久前、之后攒了什么、几张便条、今天还剩几条安排），退出码 `0`；
- 不该开口：打一行"这会儿 9:40，不打扰：…"，退出码**也是** `0`。"不打扰"不是失败，调度器别把它当成错误去重试。

它不管投递：输出落到哪儿由 `--out` 决定（不写就打到 stdout）。两种接法，按宿主能力挑一个：

1. **宿主本来就有定时器**（比如 DSH 的定时任务、别家的 cron 服务）：让它定时跑一次
   `node /path/to/agent-man/bin/agent-man.mjs cue`，把 stdout 原样喂给模型。通道现成，最省事。
2. **系统调度器**：Linux/macOS 用 cron，Windows 用任务计划程序。这类调度器没有"把输出交给谁"这回事，
   所以让它 `cue --out <文件>`：话写进文件，宿主起会话时读那个文件。

敲多少次不重要：六小时内不重复开口由 `--min-gap`（默认 6 小时）管，半夜不叫人由静默时段
（23:00–08:00）管。敲得再密也只是多读几个文件，不会多说一句话。

一天一次的钟（早上叫醒）配 `--out`——覆盖写，文件里永远是最近一次问的答案，不会越滚越大：

```cron
# 每天 8:05 问一次该不该开口；结果覆盖写到收件箱，宿主开机会话时读它
5 8 * * * node $HOME/agent-man/bin/agent-man.mjs cue --out $HOME/.agent-man/inbox.md
```

```powershell
# Windows：每天 8:05 一次，输出落到同一个文件
$arg = '"D:\agent-man\bin\agent-man.mjs" cue --out "D:\agent-man\state\inbox.md"'
$act = New-ScheduledTaskAction -Execute 'node' -Argument $arg
$trg = New-ScheduledTaskTrigger -Daily -At 8:05
Register-ScheduledTask -TaskName 'agent-man cue' -Action $act -Trigger $trg -Description '每天早上问一次该不该开口'
```

一天敲好几次就别用 `--out` 了——每半小时覆盖一次，9:37 那句"不打扰"会把 9:07 真要说的话盖掉。
高频用 `>>` 往后堆，宿主读完自己把文件截断。

**写进文件也算说过了。** 水位（§21）记的是"交给模型看过"，`--out` 不改这个规矩：话写进文件，下次就
当你已经知道——所以那个文件得有人真去读，没人读等于把话丢进了收件箱。只想让定时器提醒"有话"、把话留到
交互时再说，就加 `--peek`：它不记水位、不烧便条，同一个答案下次还会端上来。

接上之后先手动敲一次自检——第一次的输出不该是"没有新东西"：

```bash
node bin/agent-man.mjs cue --force
```

一直是"不打扰：没有新东西"，八成是 `AGENT_MAN_HOME` 和模型那边用的不是同一个目录：两边各记各的，
谁也不报错。

退出码：`0` 正常（含"不打扰"、"什么都没有"）、`1` 读不出或写不进数据目录（下一次照常敲即可，别写重试循环）、
`2` 参数写错了（配置问题，得改配置，不会自己好）。`cue` 不联网，没有"网断了"这一类。

**`--peek`：只看不烧。** 便条默认"递出即焚"，因为递出等于模型看见了。用 `--peek` 时便条留在原地，
下次还会端上来（见 `docs/decisions.md` §24、§30、§33）。

**先有读者，再挂钟。** 定时器只是把"该开口"写进一个地方；那份文件谁读、多久读一次、读完做什么，
答不出来就别挂——`cue` 的读者是模型，模型不在场时没人执行"该开口"。这一条是 2026-11-12 提出每日任务
被用户当场否掉之后补的（见 `docs/decisions.md` §34）。

## 安装

零依赖，Node ≥ 20。

```bash
git clone git@github.com:yehuoshun/agent-man.git
cd agent-man && node --test    # 用例只增不减，条数以输出为准
```

或者下打包好的 tarball——每次 main 构建都会挂一个 artifact，发版时挂在 Release 上
（最新：[v0.3.0](https://github.com/yehuoshun/agent-man/releases/latest)，78 kB）：

```bash
curl -LO https://github.com/yehuoshun/agent-man/releases/download/v0.3.0/agent-man-0.3.0.tgz
npm i -g ./agent-man-0.3.0.tgz
```

推 `v<version>` 标签就会发版：CI 先在 Linux/Windows × Node 20/22/24 上跑一遍用例，
再打 tarball、建 Release。标签和 `package.json` 的版本对不上会直接失败
（见 `docs/decisions.md` §27）。

零件（另装的 `agent-man-<名字>`，见「扩展零件」）会反过来调 `agent-man log` / `agent-man remember`，
所以 `agent-man` 本身得在 PATH 上——`npm i -g`（或用上面的 tarball）装一次就够。

数据目录默认 `~/.agent-man`，用 `AGENT_MAN_HOME` 覆盖；日界默认午夜，
用 `AGENT_MAN_DAY_START`（0..23）把它往后挪。

## 文档

- [docs/a-day.md](docs/a-day.md) — 一天真跑一遍：每条命令当时的输出
- [docs/decisions.md](docs/decisions.md) — 每个决定背后的那次事故
