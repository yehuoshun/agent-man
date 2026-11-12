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
```

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

`events.jsonl` 是日记层，`memory.jsonl` 是长期层。两者都只追加：日记永不删，
长期条目要合并就新写一条、用 `supersedes` 指过去，旧行不动。总结由模型做，
脚本只负责挑和存——见 `docs/decisions.md` §11。

## 三条硬承诺

- **预算不可协商**。任何一条都不能让渲染结果超预算，包括 `weight=3`。
- **不静默丢弃**。被切的记"截"，没进去的记"丢"，`weight=3` 被丢会单独报警。
- **时间只解释一次**。入库全是 epoch ms，展示时才转本地时间；相对时间每次现算，不写死进文本。

## 安装

零依赖，Node ≥ 20。

```bash
git clone git@github.com:yehuoshun/agent-man.git
cd agent-man && node --test    # 用例只增不减，条数以输出为准
```

或者下打包好的 tarball——每次 main 构建都会挂一个 artifact，发版时挂在 Release 上
（最新：[v0.2.0](https://github.com/yehuoshun/agent-man/releases/latest)，68 kB）：

```bash
curl -LO https://github.com/yehuoshun/agent-man/releases/download/v0.2.0/agent-man-0.2.0.tgz
npm i -g ./agent-man-0.2.0.tgz
```

推 `v<version>` 标签就会发版：CI 先在 Linux/Windows × Node 20/22/24 上跑一遍用例，
再打 tarball、建 Release。标签和 `package.json` 的版本对不上会直接失败
（见 `docs/decisions.md` §27）。

数据目录默认 `~/.agent-man`，用 `AGENT_MAN_HOME` 覆盖；日界默认午夜，
用 `AGENT_MAN_DAY_START`（0..23）把它往后挪。

## 文档

- [docs/decisions.md](docs/decisions.md) — 每个决定背后的那次事故
