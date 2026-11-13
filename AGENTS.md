# agent-man 项目约定

给 LLM agent 补上它没有的一层：**会话之外的记忆、此刻的处境、该不该开口**。
它自己不是 agent：不常驻、不联网、不调用模型、不替你下判断。

动手前先读 `docs/design.md`（v3 设计，本仓库唯一真源）。设计与代码冲突时，先改设计再说。

## 一、边界

做：情景 / 语义 / 程序 / 前瞻 / 自我 五类记忆，处境快照，开口判决，预算摘要，审计账本，插件通道。

不做：任何具体功能（天气、刷 B 站）、常驻进程、网络、向量与图、LLM 调用、
自动摘要、替模型生成台词或反思、第二份真源、静默丢弃、静默截断。

## 二、三条硬承诺（每个都要有测试锁着）

1. **预算不可协商**。`fit()` 装下的总 cost 永不超 `budget`，对必放项也一样——放不下就明确地丢，并记进 `dropped`。
2. **不静默**。截断记 `truncated`、丢弃记 `reason`、降级记 `! ` 警告；一次都没说出口的 `cue` 也要留账。
3. **时间只解释一次**。入口 `parseWhen()` 归一成 epoch ms，之后全链路只认数字；展示时才 `rel()` / `clock()` 现算。

## 三、技术栈

- **零依赖**：不新增 `dependencies`/`devDependencies`，不装 `node_modules`，只用 `node:` 内置模块。
- **Node ≥ 20**，ESM，全部 `.mjs`，`"type": "module"`，无构建无转译无 TS。
- **LF、UTF-8 无 BOM**（`.gitattributes` 锁了 `eol=lf`）。Windows 上写文件也必须写 `\n`。
- 提交前 `node --test` 必须全绿；用例只增不减，**不写死用例条数**（会过期）。
- 代码风格：无分号、单引号、2 空格缩进，行宽 ≤110，具名导出 `export function`。

## 四、结构（有结构用例锁着）

- 一个目录最多 5 个文件（门面 `index.mjs` 不计）；每个目录必须有 `index.mjs` 门面，`src/` 与 `dsh/` 根除外。
- 跨目录**只准 import 门面**（`../store/index.mjs`），不许深挖 `../store/append.mjs`。
- 依赖单向：`cli / host → view / audit → mind / digest / soul → recall / memory / intent / parts / affect → store → core`。
  `cli` 与 `host` 并列——DSH 与命令行是两个门，谁都不许被对方 import。反向依赖一律不合格。
- `node:child_process` 只许出现在 `src/parts/call.mjs`；`fetch(` 全仓禁止。
- CLI 只有 `index.mjs` 门面 + `main.mjs` + `registry.mjs` 三个文件：命令逻辑住各领域模块，
  `registry` 是一张 `"memory add" → handler` 表，外加取参与排屏。它已经一千行左右，别再往里加业务。
- 薄壳 `bin/agent-man.mjs` 只接退出码，不放逻辑；`dsh/` 只放宿主适配（`index.mjs` 挂生命周期与工具注册、`search.mjs` 取旧会话）与元数据。
  宿主层的业务判断归 `src/host/`：装配是纯函数（`compose`），取数才碰环境。

## 五、存储

- 数据目录 `~/.agent-man`，`AGENT_MAN_HOME` 覆盖。分片规则见 design.md §3，**不许加目录层级**。
- 写 JSONL 只有一条路：`store/append.mjs` 的 `appendJsonl()`（open → write → fsync → close），写完 `assertLanded()` 读回**自己那一行**。
- 覆盖写走 `writeAtomic()`（write → fsync → rename），Windows `EPERM`/`EBUSY` 退避重试，不当作数据损坏。
- 自动发号走 `claim()`（`state/ids/` 下 `wx` 建文件抢号），不许按"现有几条"算。
- **旧行永不改写**：结论失效写 `to` / `by`，规矩更新写新条 + `supersedes`。仓库里没有任何 UPDATE。
- 读坏行跳过并计数，由调用方用 `! ` 报出来；不因一行坏掉丢整份记忆，也不装作没发生。
- 排序只认 `a.at - b.at` 的数字差；禁止 `localeCompare` 或字符串前缀比较时间。
- 校验不合法就**退出码 2** 并说明怎么改，不猜、不补、不截断后继续。

## 六、测试

- `node --test`，用例名用中文写**约束**，不写函数名。
- 时间用例必须传死 `now`，不许依赖当前时钟；构造"本地某天某点"用本地时间构造函数，不写死 `+08:00` 字符串（CI 有纽约时区腿）。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-'))`，且每个用例文件用
  `test.after` 兜底删掉：一次全量会开出两百多个，不删就在系统临时目录里攒成垃圾。
- CLI 层用 `main(argv, { env, out, now })` + 记录器断言 stdout/stderr，不 spawn 子进程。
- 断言"不超预算"要真跑 `cost()` 复核，不能只断言布尔。

## 七、提交与分支

- 工作在**分支 `v1`**，不直接改 `main`。旧代码存档在 `archive/v0.4`（v0.4.0 的 tag 也在）。
- **一改一提交一 push**：每完成一个自洽的小步就 commit 并 `git push origin v1`，不攒批。
  中途被打断时，宁可提交一个"半成品但可解释"的状态，也不要留未提交改动在本地。
- 提交信息中文，格式 `范围: 改了什么(为什么)`，范围用 `core` / `store` / `memory` / `recall` / `mind` / `digest` / `view` / `cli` / `parts` / `dsh` / `docs` / `test`。
- push 失败必须报原文并停下；PowerShell 5.1 会把 `To github.com:...` 当错误——以 `git status -sb` 无 `ahead` 为准。
- 禁止 `reset --hard` / `checkout -- .` / `clean -fd` / `push --force`。
- 决定写进 `docs/decisions.md`，固定三段：**决定** / **来由** / **代价**。只写"选了什么"没有价值。

## 八、禁止清单

- 第三方依赖、数据库、二进制存储、向量与嵌入。
- 把语义判断塞进脚本（判断"是不是同一件事"、生成台词、决定该说什么）。
- 静默丢弃 / 静默截断 / 静默吞异常。
- 常驻进程、守护线程、轮询、文件监听、后台队列、交互式确认。需要定时由外部调度器调 `cue`。
- 业务代码里散落 `Date.now()`（只在参数默认值与 CLI 入口出现）。
- 在仓库根散落临时文件：临时产物写本仓库 `tmp/`（已被 `.gitignore` 覆盖）。
- 零件直接读写 `events` / `memory` / `rules`：只走 `agent-man event add --src tool:<名字>`。
- 插件写结论、规矩、自我块；凭据进仓库。

## 九、与工作区的关系

本仓库位于工作区 `code/agent-man/`，继承工作区根 `AGENTS.md`；冲突时以本文件为准。
git 操作只在本仓库内做，不跨仓库 `git add`。
