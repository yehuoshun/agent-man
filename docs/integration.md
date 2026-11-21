# 本体与零件联调

> 零件（part）是 PATH 上的一个独立可执行文件，名字以 `agent-man-` 打头。本体不内置任何
> 具体能力：接天气、接语雀、接任何观察，都写成一个零件。
>
> 本文是**一次真实联调**的记录：本体 `agent-man` 加第一个真零件 `agent-man-yuQue`（语雀）。
> 契约的权威说法在 `docs/design.md` §8；这里写的是两边接起来之后，各条通道实际怎么走、
> 实测多快、代价在哪、出了事怎么自己验。

## 1. 四条通道，各走哪条路

| 通道 | 谁触发 | 问零件的预算 | 等零件多久 | 答话落在哪 |
|---|---|---|---|---|
| CLI 那一屏 | `agent-man context show`（含 `look`、裸 `agent-man`） | `inject.situation`，默认 550 | 不设总期限，单件受 `parts.timeout` 兜底（默认 5000ms） | 屏上「建议」段，最多 1 条 |
| DSH 宿主注入 | 每一步注入 | `inject.parts`，默认 120 | `parts.deadline`，默认 1200ms，**总**期限不分摊 | 处境块里，旧会话回顾之前 |
| 零件自己的无参模式 | 你直接敲 `agent-man-yuQue` | 零件自己定 | 本体不参与，没人在等 | 零件的 stdout |
| 直通（不过 sense） | `agent-man yuQue <参数>` | 不问，原样转发 | 没有期限，等到它自己退出 | 零件 stdio，退出码也原样 |

前两条都会「问一遍零件」，区别只在预算与期限：

```
agent-man context show
 ├─ config.load() ......................... src/core/config.mjs
 │    AGENT_MAN_* 只认已知键；零件找本体的入口提示只认名字，不当配置键读
 ├─ parts.sense(env, { budget: 550 }) ...... src/parts/sense.mjs
 │    ├─ parts.scan(env) ................... PATH 上扫 agent-man-<名字>
 │    ├─ parts.describe() ×N ............... 每个零件 --describe，timeout = parts.timeout
 │    └─ parts.capture() ×N ................ 每个零件无参跑一次
 │          └─ 子进程 env 里盖 AGENT_MAN_PART_CALL=1（防套娃）
 ├─ mind.situation(home, { parts }) ........ 建议段（v≥65 且 e≥76，最多 1 条）
 └─ view.screen() .......................... · 语雀：与本体一致（2m 前）（yuQue）
```

```
DSH 每一步注入（dsh/index.mjs）
 ├─ askParts(env, { budget: 120, deadline: 1200 }) ─┐
 ├─ recall(...) 旧会话字面回顾 ───────────────────┤ 并行，谁先到先用谁
 │                                                 ┘
 ├─ 块预算：soul 200 ┐
 ├─         user 100 │
 ├─         situation 550 + parts 120 = 670  ← situationBudget(cfg)
 ├─         recall 150
 └─ compose(budget: inject.total = 1120)
```

两处安排的理由：

- **注入侧单列 120，CLI 侧不单列。** 注入里零件答话单独一格（`inject.parts`），坏零件该挤掉
  自己而不是挤掉日程；CLI 那一屏本来就只有处境，建议从 550 里出，装不下丢的是建议（见
  `src/mind/situation.mjs` 的 `budgetOf`）。
- **注入侧有死期限，CLI 侧没有。** 注入最多等 `parts.deadline`，到点用已经拿到的部分继续；
  CLI 是人主动敲的，慢一点可以等，但单件仍受 `parts.timeout` 管着。

## 2. 零件契约（写零件的人看这一节）

- **一调用一进程**：参数走 argv，stdout 只放结果，日志走 stderr，无参 = 只读。
- **`--describe` 报五个字段**，缺一个这件就不接：

| 字段 | 要求 | 干什么 |
|---|---|---|
| `name` | 非空字符串 | 屏上与 `! ` 里点名用 |
| `desc` | 字符串 | 一句话说明这件干什么；只做校验与留档，当前没有屏渲染它 |
| `section` | 字符串 | `context sense` 汇总里挂在这行前面的段名；屏上固定归到「建议」 |
| `timeout_ms` | 正数 | 本件单次最多等多久（会被 `parts.timeoutMax` 夹住） |
| `side_effects` | 必须存在 | 说明这件无参时会不会写盘；骨架只查在不在，不解释里面的值 |

- **超时与截断**：`parts.timeout`（默认 5000ms）、`parts.timeoutMax`（默认 30000ms）、
  `parts.stdoutMax`（默认 8192 字节，超了说一句「输出超过 8KB，已截断」）。
- **连续失败的冷却是一个约定，不是自动的**：`parts.failLimit`（默认 3）配 `src/parts/index.mjs`
  的 `bump()` / `blocked()` 定义了「连坏 3 次就先别问」的账本形状，账要调用方按会话自己维护；
  CLI 与当前宿主每次都是重新 `sense`，不留这个账。所以坏零件眼下靠 `parts.timeout` 与注入的
  `parts.deadline` 兜着，别指望它自己被跳过。
- **答话是一行**：多行会被折成一行；成本口径是半角 0.28、全角 1.0、每行加 8（`src/core/const.mjs`）。
  插件侧自己把一行压在 30 cost 以内——这不是骨架强制，但建议段一屏只放一条，太长的会被丢。
- **哨兵 `AGENT_MAN_PART_CALL=1`**：本体调零件时一定会盖这个环境变量。零件无参时若反过来问
  本体（`agent-man context show` 之类），那一层本体见到哨兵就**不问任何零件**，只回自己的账。
  这是「零件在零件里」的护栏：没有它，无参要回问本体的零件会把本体绕进无限套娃，直到超时切断。
- **入口提示 `AGENT_MAN_BIN` / `AGENT_MAN_REPO`**：零件要找本体时看这两个（顺序在插件侧定：
  `AGENT_MAN_BIN` → PATH → `AGENT_MAN_REPO`）。它们不是配置键，本体只认下名字、不读取，所以
  设了也不会报「不对应任何配置键」。
- **不许零件在零件里**：零件想吃别的零件的数据，就在自己的无参输出里带上，别指望嵌套去问。

## 3. 插件侧约定（`agent-man-yuQue` 这一款怎么做的）

- **出口**：`agent-man-yuQue status --json` 看配置与登录态，`sync` 真同步，`sync --dry-run`
  算一遍但不发写请求。
- **判命**：只认 HTTP 200 / 404 决定 upsert，不猜其它状态码；429 不重试。
- **正文**：读 `data.body`，写回时带 `format: 'markdown'`，不带 `public` 字段——私有库的东西
  不该因为一个字段变公开。
- **目录树**：只做增量 `appendNode`，不整体覆盖；树挂不上时正文照落盘，只重试树。
- **退出码**：用法错 64、401 或找不到本体 69。找不到本体是「环境没装好」，不是「插件坏了」。
- **幂等**：正文没变就不写，第二次 `sync` 应该报「没变，跳过」——跨分钟也要成立。
- **隐私**：源码里**没有默认库名**。没设 `YUQUE_NAMESPACE` 时 `sync` / `status` 退 64 并说清
  用什么变量指定；无参那一行退 0、只说「没设目标知识库（YUQUE_NAMESPACE）」——这是缺配置，
  不是插件坏了，不该在本体那边变成一条 `! ` 噪声。写操作的目标必须每次由人明说：`state.json`
  里记的「上次写了哪个库」只有 `status` 与无参沿用，`sync` 不信它。

## 4. 实测数字（一次真机联调）

| 场景 | 墙钟 | 备注 |
|---|---|---|
| CLI，PATH 上没有零件 | 163ms | 一次 `context show` |
| CLI，PATH 上有 `agent-man-yuQue` | 1014–1100ms | 多出的是一次 `--describe` + 一次无参 `capture` |
| DSH 第一步注入，带零件 | 1057ms | 从会话开始到 `· 语雀：…（yuQue）` 出现 |
| 隔 66 秒再 `sync` | — | 报「没变，跳过」，跨分钟仍幂等 |

墙钟随机器、磁盘、网络变，只能当量级看：**一次零件答话 ≈ 两次进程启动**，Windows 每次
100–200ms 起。

### 2026-11-21 实机会话（DSH Web GUI，Windows，同一个数据目录）

第一次在真宿主里跑完一次会话，量的都是墙钟：

| 场景 | 墙钟 | 备注 |
|---|---|---|
| 会话首步注入（零件在） | 会话开头即出现 | 处境块 + 空行 + 情绪行，与 `renderScreen`/`affectLine` 拼法逐字对得上 |
| `agent_man` / `agent_man_look` | — | 两个工具都注册成功、都能调用；`agent_man` 写的那条事件 CLI 里读得回 |
| CLI `context show`，零件旧版（串行问本体四份） | 1776–1959ms | 零件自身 1.3–1.6s，整段落在 `parts.deadline`（1200ms）之外 |
| 同上，零件改并行取数后 | 1030–1126ms | 零件无参 572–677ms |
| `parts.sense(env,{deadline:1200})`，旧零件 | 5/5 被丢（1238–1260ms） | `dropped=[{name:'yuQue',reason:'deadline'}]`，`! ` 说「这次不用它的答话」 |
| 同上，新零件 | 5/5 答上来（814–961ms） | `dropped: []`，建议行照常出现 |
| 零件问本体那四份（`context show --json` 295 / `memory ls --json` 204 / `rule ls --json` 212 / `self show --json` 201ms） | 串行 941ms → 并行 359ms | 并行是零件侧改的，本体这边一行没动 |

「一次零件答话 ≈ 两次进程启动」这条要补一句**乘法**：零件内部再问本体几份，就是几份进程启动，
而且这些启动全压在同一个 `parts.deadline` 底下。互不依赖的取数得零件自己并行起来——串行的
零件会把「建议」整段吃掉，屏上看到的是零件"没答话"，其实是它答得太慢。

## 5. 已知代价

- **2N 次进程启动**：N 个零件最多 `describe` N 次 + `capture` N 次。Windows 上这是主要成本。
- **期限到了会丢**：`parts.deadline` 是总期限，压到 300ms 量级会连正常零件一起丢；注入那边
  丢的那件进 `dropped[{ name, reason: 'deadline' }]`，并出 `! ` 说明。2026-11-21 实测过一个
  真踩：串行取数的 `agent-man-yuQue` 无参要 1.3–1.6s，连跑 5 次 5 次全被丢——期限没毛病，
  是零件该提速（改并行后 0.57–0.68s，5/5 答上来）。
- **建议段一屏只有一条**：零件答的再多，屏上也就一条；想更宽就调 `inject.parts`（注入）或
  `inject.situation`（CLI）。
- **关掉就是全关**：`parts.inject = false` 之后连「谁没答上来」都记不进那一次注入——这是有意的
  「回到 1.1」，不是漏报。
- **直通不盖哨兵、也没有期限**：`agent-man yuQue ...` 是把你的环境原样递给零件，stdio 继承，
  等到它自己退出为止；只有 sense 里的 `capture` 才盖哨兵、才有超时。所以经直通问零件、零件又
  回问本体，最多多绕一圈就停（内层 `capture` 会盖）。

## 6. 怎么自己验

```sh
# 零件在不在、答的什么、预算怎么算的，全在这份 JSON 里
agent-man context sense --json

# 开关是配置项（也认同名环境变量，见最后一行 PowerShell）
agent-man config get parts.inject

# 关掉之后 CLI 那一屏应该只剩本体自己的话，stderr 有一行说明
agent-man config set parts.inject false
agent-man context show

# Windows PowerShell 里临时关一次（注意 AGENT_MAN_PARTS_INJECT 与配置键同源）
$env:AGENT_MAN_PARTS_INJECT = '0'; agent-man context show; Remove-Item Env:\AGENT_MAN_PARTS_INJECT
```

插件自己的账：

```sh
agent-man-yuQue status --json     # 配没配、连不连得上
agent-man-yuQue sync --dry-run    # 算一遍，零写请求
agent-man-yuQue sync              # 真写；随后再跑一次应该报「没变，跳过」
```

## 7. 已知限制

- **改完 profile 要重开进程**：宿主注入读的是进程启动时的环境，GUI 里改 profile 之后不重开
  读不到新 `env`。
- **CLI 那一屏没有总期限**：零件数 k 就要等 k 组 `describe` + `capture`；要在又慢又多的时候
  给个上限，得给 `sense` 传 deadline（注入侧已经这么做）。
- **建议段有门控**：不到 v≥65 且 e≥76 就不显示建议。屏上没零件答话，不代表零件没跑，可能只是
  被门控丢了——`context sense --json` 能看到答上来的原文。
- **先看 `dropped` 再怀疑门控**：`context sense --json` 里 `dropped[{ name, reason }]` 是硬证据，
  `reason: 'deadline'` 是零件太慢（`src/parts/sense.mjs:97`），`reason: 'budget'` 是装不下
  （`src/parts/sense.mjs:113`）。前者要那个零件提速——别调大期限，期限是总账，一调每个人每一步
  都跟着等；后者才是调 `inject.parts` / `inject.situation` 的事。
