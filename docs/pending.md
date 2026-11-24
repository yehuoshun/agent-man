# 还没做的：清单与理由

本文件只收"**知道有问题、这一轮决定先不做**"的事。已修的进 `docs/decisions.md`，
设计口径进 `docs/design.md`。每一条都要能自证（跑一遍就能看见），不做"感觉可能有问题"的登记。

登记格式：**现象**（一条命令或一处代码）→ **为什么这轮不做** → **要做时从哪儿下手**。

## 一、CLI 命令面

1. **`config` 裸命令退 2**。`agent-man config` 没有任何输出、退出码 2，而别的资源裸命令都等于 `ls`
   （§6「资源无动作等于 ls」）。设计与实现谁让谁：设计没写 `config ls` 这个命令，所以现在两边都说得过去。
   要做：先在 §6 补一行 `config` 裸命令等于 `config show`，再改 `registry` 的二级路由。

2. **`--help` 与 `registry` 没有互相锁住**。别名（`log`/`remember`/`leave`/`digest`/`cue`/`find`/`show`/`look`）、
   `--all/--live/--key/--no-mood/--dry-run/--at` 这些都不在帮助里。改帮助靠人记，不靠用例盯。
   要做：加一条用例，断言"`--help` 里出现的每个命令都能真跑通、`registry` 里注册的每个命令都在 `--help` 里"。

3. **`plan add --at 999999d` 被接受**（算出 4764 年）。`core/time.mjs` 的 `parseWhen` 只挡 1970..9999 之外，
   999999 天落在区间内就放行。要做：给"多久以后"加一个上限（比如 100 年），超了退 2 并说清范围。

4. **rules 到第 21 条时是退 2 还是静默丢旧**。`RULE_MAX = 20` 的判定在写入路径上确实退 2 并指路 `supersedes`，
   但没有用例播种 20 条再写第 21 条。要做：补一条"第 21 条退 2、且库里还是 20 条"的用例。

5. **`context digest --budget 0` 被接受**（配置侧 `digest.budget` 有 200 下界，命令行没有）。
   要做：命令行取值也走同一个下界，或明确"命令行为 0 就是不要东西"并写进 §16。

## 二、数据层与账本

6. **`inject.total` 的预算传导没测过**。`inject.total` → `soul/user/situation/parts/recall` 五个槽位的分配
   只在 `host/compose` 里读过一次，没有端到端用例断言"总数超了先砍哪一段"。
   要做：一条用例，给一组能撑满 `inject.total` 的数据，断言 `composed` 里的顺序与 `dropped` 记录。

7. **`audit timeline` 把便条与日程按 `at` 入窗**，而 §5 说便条按 `ttl`、日程按 `due` 截断，不该按窗口。
   现在的实现是"窗口内看看发生了什么"，两种口径在边界上会不一样（45 天前写、下周到期的日程会消失）。
   要做：先定 timeline 到底是"事件流"还是"处境快照"，再照口径改。

8. **`memory/query.mjs` 没把 `clock.dayStart` 传下去**。`store` 侧的 `listShards`/`shardSpan` 已经认
   `{dayStart}`，`memory.events()` 还没有这个入参 → 日界设在 04:00 时，`event list --from 00:30` 查不到当天 01:00 的事件。
   要做：`memory.events(home, {from, to, dayStart})` 透传 + 命令层把 `config.clock.dayStart` 传进来，
   端到端用例写"凌晨 01:00 的事件用 `--from 00:30` 查得到"。

## 三、情绪与灵魂

9. **`countedIn()` 把超额行也算进 `counts`**（`src/affect/stim.mjs`）。注释说"超额的不计"，
   代码把 `{ignored: true}` 的行也数了进去，于是同一天第 4 条刺激之后 `affect why` 的"另有 N 条"会偏大。
   要做：明确 `counts` 是"计入权重的条数"还是"记下来的条数"，按口径改并用一条用例钉住。

10. **`name.md` 算不算一栏**。§13 只列 `identity/soul/dialogue/lore` 四栏，但灵魂目录里可以有 `name.md`，
    它既占注入又不进"四栏全缺"的判定。要做：在 §13 里补一句它的地位（现在实际是"有就读、不参与缺栏判定"）。

11. **情绪有两套屏上实现**：CLI 的 `affectLine`（`src/cli/registry.mjs`）与注入侧的 `affectLine`
    （`src/host/inject.mjs`），字段拼法各写一遍。§14.11 要求"一处真源"。
    要做：把"数值+标签+原因"的拼装提到 `affect` 门面里导出，两个屏幕都调它。

## 四、零件与网关

12. **零件契约的 69/75 只有约定没有用例**。骨架侧 `classify()` 认 69（依赖缺失）与 75（超时），
    yuQue 与 gateway 也真的会退这两个码，但没有一条用例从"零件退 75"一路断言到"骨架记 timeout 而不是 crash"。
    要做：假零件退 75 / 69 各一条，断言 `capture().status` 与 `failures[].why` 的措辞。

13. **gateway 的出站没有 `--describe` 之外的零件能力**：它现在能被发现、能被问一句、能判一条内容，
    但"判完还能不能发"（`authorize`/`send` 那条链）没有做成 CLI 子命令，宿主拿不到。
    要做：等真有第二个宿主要用再开，别为了对称硬造一个接口。

## 五、语雀零件（两条已查清，剩余待办见下）

14. ~~**`lastAt` 的语义**~~ **已查清并修文档（2026-11-24，`agent-man-yuQue` 提交 `acdcdf9`）**：
     `lastAt` 就是「上一次 `sync` 走完的时刻」，空跑（没有一篇要推）也算走了一趟
     （`src/sync.mjs:552/588/595`），哈希没变所以下次进去还是跳过。这不是 bug，是"上次动手"
     而不是"上次真推"；要看内容动没动，看每篇那一行的 `一致` / `内容变了`。README 原来写
     「上次真推上去的时刻」不准确，已改成实现口径。

15. ~~**令牌文件权限错误没验**~~ **已验，行为正确（2026-11-24）**：先纠一个前提——**没有
     `YUQUE_TOKEN_FILE` 这个环境变量**，只有 `YUQUE_TOKEN` 与 `--token-file` 开关（拿那个变量名去试
     会得到「缺语雀令牌」，属正确行为，别误判成 bug）。用 `--token-file` 三种坏输入实测：指到目录
     `EISDIR`、不存在 `ENOENT`、空文件，全部退 69，且 `! ` 那行分开说（「读不到令牌文件「…」（EISDIR）」
     /「是空的：里面要有一行语雀令牌」），不会把"读不动"含糊成"你没配"。`status` 完全不读令牌（离线）。
     README 已补这段。剩下的只是"没有用例钉住这三种 69"——要做时在 `test/config.test.mjs` 里加三条。
