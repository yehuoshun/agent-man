# agent-man 情绪系统前期调研

调研时间 2026-11-14。目标：给零依赖、不联网、不调模型的 CLI 记忆工具设计"自动 + 手动"情绪层。
标注约定：**[一手]** = 本次实际抓到原文/源码并核对；**[二手]** = 百科/综述转述；**[未证实]** = 我没能核到原始出处，不当作事实用。

---

## 结论

1. **维度选两轴 + 离散查表**：Russell 环形模型 valence/arousal 各取 `[-1,1]`，8 个 PAD 八分仪当标签原型（Mehrabian 自己给的样例：angry=(-0.51,0.59,0.25)、loved=(0.87,0.54,-0.18)），第三维 dominance 只在"怕 vs 怒"这类同极性状态上提供区分，agent 场景可先不做。
2. **生成用 OCC 的 5 个变量就够**：desirability / likelihood / praiseworthiness / desirability-for-other / like 这 5 个数能推出全部 22 类 OCC 情绪，每类强度是一行算术（FAtiMA 源码里就是这么写的，见 §2），不需要模型输出情绪词。
3. **动态一律指数半衰期**：`I(t)=I0·0.5^(Δt/T½)`；FAtiMA 默认 emotion T½=15 tick、mood T½=60 tick（1:4），同类叠加用 log-sum-exp `I=ln(e^I1+e^I2)` 而不是加法，所以 3 次同级事件只到 ~1.1 倍而不是 3 倍。
4. **成熟系统存的是四元组不是句子**：(类型, 强度, 衰减率, 阈值) + 一个 mood 标量；存自然语言描述（含"模型自评我现在很开心"）的做法在长上下文里会被稀释（Lost in the Middle：相关信息落在中段时性能显著下降）。
5. **诚实边界有数字支撑**：模型自评方向偏正（sycophancy：5 个 SOTA 助手 × 4 类任务一致偏向附和用户），而人类对任务型对话的标注 **70.1% 是 neutral**（EmoWOZ，11,434 段对话 / 83,617 条标注）——"永远积极"是可测的偏差方向，不是猜测。
6. **触发源分工**：B（结构化 appraisal 输入）为主干、C（工具/交互信号）做自动兜底、A（模型自评）只作带证据、有上限（±0.2）、可审计的补充，且 A 永远不单独决定情绪值。
7. **形态建议：单条 0–100 标量为主，另挂一条可选的正交 arousal 轴（只调制语气强度，不参与阈值判定）**。理由：单标量擅长**显示**（人一眼看懂，暗黑地牢 0–200 / 饥荒 0–200 都是这么用的），但阈值带、叠加、饱和这三件事必须另加三条规则才稳（暗黑地牢用"回城封顶 100 + 闲置 -5/周"防饱和，饥荒用 15%→17.5% 的滞回防抖动）；而"难过/平静/兴奋"这三个词本身已经混进了 arousal（见 §8.4），一条轴分不出"低落而平静"和"低落而焦躁"。

---

## 1. 维度模型对照表

| 模型 | 维度 | 取值范围 | 适用场景 | 来源 |
|---|---|---|---|---|
| Russell 环形（1980） | valence × arousal，情绪词按角度排在圆周上 | 心理学原版是等距量表；工程上统一 `[-1,1]`（或 [0,1]） | 把任意状态压成两个数、算"离哪个原型最近" | JPSP 39(6):1161–1178，[doi:10.1037/h0077714](https://doi.org/10.1037/h0077714) **[二手核对]** |
| PAD（Mehrabian & Russell 1974；Mehrabian 1996） | Pleasure / Arousal / Dominance | 三轴均 `[-1,+1]`，0 为中性 | 需要区分同极性情绪（anxious=-P+A-D vs hostile=-P+A+D） | Mehrabian 本人站点 [PAD Emotion Scales](http://www.kaaj.com/psych/scales/emotion.html) **[一手]** |
| Plutchik（1980） | 8 基本情绪 × 3 强度档，+ 24 个 dyad | 连续强度 0–1，或三档（annoyance/anger/rage） | 给人看的标签、混合情绪（joy+trust=love） | Plutchik 1980《The Emotions》；[wheel 综述](https://en.wikipedia.org/wiki/Plutchik%27s_wheel_of_emotions) **[二手]** |
| Ekman（1992） | 6 类离散：anger/disgust/fear/happiness/sadness/surprise | 无坐标，只有类别 | 表情、跨文化识别、标注体系 | Cognition & Emotion 6(3):169–200，[doi:10.1080/02699939208411068](https://doi.org/10.1080/02699939208411068) **[二手核对]** |
| OCC（1988） | 不是维度：22 类情绪 × 5 个 appraisal 变量 | 每个变量 `[-1,1]`，likelihood `[0,1]` | **由事件算情绪** | Ortony/Clore/Collins 1988；实现见 [FAtiMA OCCEmotionType.cs](https://github.com/GAIPS/FAtiMA-Toolkit/blob/master/Assets/EmotionalAppraisal/OCCModel/OCCEmotionType.cs) **[一手]** |
| Scherer SEC | 4 组检查（相关性→含义→应对潜力→规范意义），每组 2–3 个子项 | 三值/布尔（高/中/低） | 解释"为什么是这个情绪"、做可读的判定表 | [SEP §6 Appraisal Theories](https://plato.stanford.edu/entries/emotion/) **[一手]**；SEC 子项命名见 Scherer 2001/2009 **[未逐字核实]** |

### 事件 → 坐标的三条路（选一条，别混）

```text
A. 词表法（无模型）：V = clamp(mean(lex[w].v), -1, 1)
                     A = clamp(max(|lex[w].a|), 0, 1)      # 取 max 不取 mean：一个强词就能拉高唤醒
   lex = NRC-VAD（20k 英文词，三轴 [0,1]，[N18-1202](https://aclanthology.org/N18-1202/)）
         或 ANEW（约 1k 词，1–9 量表，换算 x'=(x-5)/4）
   坑：中文词表没有同等规模的公开 VAD 资源 → 对中文 CLI 不可行（本工具零依赖，更不可能带词表）。

B. OCC 变量法（推荐）：v = desirability
                       a = clamp(urgency*|v| + 0.5*novelty, 0, 1)
                       d = controllability            # 自己可控 → 正
   要求调用方多填 3–5 个数，但这 3–5 个数是"可核查的输入"，不是"结论"。

C. 直接给坐标：--v/--a/--d，工具只做聚合与衰减。
```

### PAD 八分仪 → 标签（查表，`argmin` 距离即可）

| 象限 | 标签 | 象限 | 标签 |
|---|---|---|---|
| +P +A +D | Exuberant | -P +A +D | Hostile |
| +P +A -D | Dependent | -P +A -D | Anxious |
| +P -A +D | Relaxed | -P -A +D | Disdainful |
| +P -A -D | Docile | -P -A -D | Bored |

（Mehrabian 站点原文只点名了 Anxious(-P+A-D) 与 Hostile(-P+A+D) 两组，其余六组按同一构成规则补全 **[二手]**，但用他给的 12 个样例值反查全部自洽：loved→Dependent、angry→Hostile、bored→Bored、sleepy→Docile、puzzled→Anxious。）

---

## 2. OCC / appraisal 判定表（可直接实现）

变量：`d`=desirability、`p`=当前目标成功概率、`p0`=上一刻概率、`sig`=目标重要性、`pr`=praiseworthiness（该行为多该表扬/多该指责）、`dfo`=对他人而言的好坏、`like`=对对象的好感。

| 触发条件 | 情绪 | 强度（FAtiMA 原式） |
|---|---|---|
| 事件 `d ≥ 0`，无其他信息 | Joy | `d` |
| 事件 `d < 0` | Distress | `-d` |
| `p` 上升但未达成 | Hope | `p · sig` |
| `p` 下降但未落空 | Fear | `(1-p) · sig` |
| `p=1` 且 `p0 ≤ 0.5` | Relief | `p · sig` |
| `p=1` 且 `p0 > 0.5` | Satisfaction | `p · sig` |
| `p=0` 且 `p0 ≥ 0.5` | Disappointment | `(1-p) · sig` |
| `p=0` 且 `p0 < 0.5` | Fears-Confirmed | `(1-p) · sig` |
| `d>0` 且 `pr>0`，行为人=自己 | Gratification | `|d + pr| / 2` |
| `d<0` 且 `pr<0`，行为人=自己 | Remorse | `|d + pr| / 2` |
| `d>0` 且 `pr>0`，行为人=他人 | Gratitude | `|d + pr| / 2` |
| **`d<0` 且 `pr<0`，行为人=他人** | **Anger** | `|d + pr| / 2` |
| 只有 `pr`，行为人=自己 | Pride / Shame | `|pr|` |
| 只有 `pr`，行为人=他人 | Admiration / Reproach | `|pr|` |
| `d>0` 且 `dfo>0` | Happy-For | `(|dfo| + |d|)/2` |
| `d>0` 且 `dfo<0` | Gloating | 同上 |
| `d<0` 且 `dfo<0` | Pity | 同上 |
| `d<0` 且 `dfo>0` | Resentment | 同上 |
| 对对象好感 `like` | Love / Hate | `|like| · k`（`k` 原码是未公开的 `magicFactor`） |

这就是用户要的那条判据的形式化：**目标受阻（d<0） + 归因他人（行为人是 other）→ Anger**，且强度是两个量的平均，不是乘积——所以"很糟但不怪他"不会炸，"有点糟但明显是他的错"也不会炸，两者都强才炸。**[一手]**：`OCCAffectDerivationComponent.cs`、`OCCEmotionType.cs`

Scherer SEC 的用法不是算强度，是**在 OCC 之前做前置过滤**（值不值得评）：

| 检查 | 子项 | 决定什么 |
|---|---|---|
| 相关性 | 新颖性、内在愉悦度、目标相关性 | 无关事件直接丢弃（否则每条 tool 调用都会起情绪） |
| 含义 | 目标促进/阻碍、期望一致性、紧迫性 | 选 d 与 p 的符号、决定 sig |
| 应对潜力 | 原因（谁造成）、结果概率、可控性、可适应性 | 选归因（self/other）与 d |
| 规范意义 | 外部规范、自我规范 | 区分 Shame/Guilt 与 Regret；也是"该不该表现"的开关 |

（SEC 的四组结构来自 Scherer 的成分过程模型；具体子项名称以 Scherer 2001 为准 **[未逐字核实]**，SEP 只提供了 appraisal 的一般框架 **[一手]**。）

---

## 3. 动态参数

```text
# 衰减（FAtiMA 原式，half-life 形式）
lambda = ln(0.5) / T_half
I(t)   = I0 * exp(lambda * Δt)              # 情绪
I(t)   = I0 * exp(lambda * Δt * Decay_i)    # 每类情绪额外乘自己的 Decay∈[0,10]
mood(t)= mood0 * exp(lambda_m * Δt)         # 心情，独立半衰期

# 叠加（同类强化）
I_new = ln( exp(I_old) + exp(I_potential) )        # log-sum-exp，次可加

# 心情更新
mood += valence_sign * intensity * 0.3 ;  clamp(mood, -10, +10)

# 心情反过来调制情绪
I_eff = I * (1 + 0.3 * mood/10)                     # 原文是 30% 权重
```

| 参数 | FAtiMA 默认值 | 说明 |
|---|---|---|
| `HalfLifeDecayConstant` | 0.5 | 就是"半衰"，其它值可做非半衰指数 |
| `EmotionalHalfLifeDecayTime` | 15 tick | 单条情绪的 T½ |
| `MoodHalfLifeDecayTime` | 60 tick | mood 的 T½，比值 1:4 |
| `EmotionInfluenceOnMoodFactor` | 0.3 | 情绪对心情的权重（"不想要心情太易变"） |
| `MoodInfluenceOnEmotionFactor` | 0.3 | 心情对情绪的权重 |
| `MinimumMoodValueForInfluencingEmotions` | 0.5 | `|mood|<0.5` 视为中性，不参与调制 |
| 情绪 `Decay` | 每类 0–10 | 作者按情绪类型设的衰减倍率 |
| mood 范围 | `[-10,+10]`，clamp | 不是 [-1,1] |

**[一手]**：`EmotionalAppraisalConfiguration.cs`、`Mood.cs`、`ActiveEmotion.cs`。
注意：tick 是模拟时钟单位，是否等于 1 秒**未证实**——照抄数值前必须先钉死自己的时间单位。

**线性 vs 指数**：主流全是指数（FAtiMA、ALMA、Generative Agents 的 0.995/hour 都是 exp），理由是可解释（半衰期）、无记忆性（不需要逐步积分）、任意 Δt 都能一次算完。线性衰减只在固定步长的游戏循环里出现，且要额外记"已经过了几步"，对 CLI（随时被调用、Δ 可能是 3 分钟也可能是 3 天）不合适。

**三级时间尺度**（Plutchik 的 emotion → mood → temperament，秒/分 → 时/天 → 月/年）：这是一个**结构性提议**，不是实测常数；但它的工程含义很清楚——三层用三个不同的 T½，且只有最上层（temperament）是手动/身份层，中下两层自动跑。**[未逐字核实]** 具体边界。

**给 agent-man 的取值建议**（理由：CLI 的调用间隔通常是分钟到天）

| 层 | T½ | 理由 | 测试断言 |
|---|---|---|---|
| 情绪 | 45 min | 一次会话内的不愉快不该在会话内消失，跨会话应基本归零 | `t+45min → 0.5I0`；`t+3h → <7%` |
| 心情 | 8 h | 一天内的多次事件能累积成"今天不顺" | `t+8h → 0.5M0` |
| 基线/性格 | ∞（存 `self.md` 或 baseline 记录） | 手动设定的长期倾向 | 不随时间变 |

---

## 4. 开源实现

| 项目 | 存什么 | 怎么注入/使用 | 失效点 |
|---|---|---|---|
| [FAtiMA-Toolkit](https://github.com/GAIPS/FAtiMA-Toolkit)（OCC，C#） | 每条情绪 `{类型, potential, threshold, decay, tick}` + mood 标量 + 每类的 `InfluencesMood` 布尔 | 作者写 appraisal rule（条件→5 个变量），引擎算情绪；决策模块拿情绪强度调行动效用 | 规则没覆盖的事件=没有情绪（沉默即中性）；tick 与真实时间脱钩；22 类里有一半在工具场景用不上 |
| ALMA（Gebhard 2005，AAMAS） | emotion（PAD+强度，短）→ mood（PAD，中）→ personality（Big Five，长） | mood 由情绪 PAD 加权，再衰减回默认 | PAD→标签靠手工质心；三层参数多，难调 **[二手]** |
| [Generative Agents](https://arxiv.org/abs/2304.03442)（Park et al. 2023） | 每条记忆带 `poignancy` 1–10（**LLM 自评**）+ 时间戳 | 检索分 = 归一化后的 recency/importance/relevance 加权；`recency = 0.995^小时`；累计 importance > 150 触发 reflection | 自评重要性有偏且不可复现；poignancy 问的是"这事多重要"不是"我什么感受"；每条都要一次 LLM 调用 |
| [EmoWOZ](https://aclanthology.org/2022.lrec-1.436/)（LREC 2022） | 标注体系：7 类（OCC 派生：satisfied/dissatisfied/apologetic/excited/fearful/abusive/neutral），11,434 段对话、83,617 条标注、3 人标注、agreement 0.602 | 作为识别模型的监督信号，输出接进 DST | 只标**用户**不标系统；**70.1% 是 neutral**，类别极不平衡；agreement 只有 0.6 |
| [EmpatheticDialogues](https://aclanthology.org/P19-1534/)（ACL 2019） | 32 个情绪标签，约 25k 段对话 | 标签作为生成条件 | 标签是"说话人自述的处境类别"，没有强度、没有时间、没有归因 |
| [text2emotion](https://pypi.org/project/text2emotion/) / [empath](https://pypi.org/project/empath/) / [NRCLex](https://pypi.org/project/NRCLex/) | 词表计数 → 5 类 / 200+ 类 / 8 类（Plutchik） | 直接当情绪值用 | 词典法对反讽、否定、中文全失效；输出无强度语义（数了几个词≠多生气）；无时间维度 |
| MoodEngine | — | — | **查不到可信的同名框架**：GitHub 同名仓库星数 0 且与情绪无关。要引用请改用 ALMA/WASABI/EMA |

**长上下文的失效点**：把"你现在处于 valence=+0.6 的状态"写进 system prompt，效果随上下文变长而衰减——Lost in the Middle 的实验显示相关信息落在**中段**时性能显著下降，且显式长上下文模型也一样（[arXiv:2307.03172](https://arxiv.org/abs/2307.03172) **[一手摘要]**）。推论：情绪状态必须**每轮重新注入且放在末尾/开头**，不能指望它"留在上下文里自然生效"；也不能靠模型自己每轮重写一段情绪描述（那是把状态交给一个会漂移的生成器）。

## 4b. 可见 vs 隐藏

| 形态 | 失败案例 | 先例 |
|---|---|---|
| 显式展示（状态栏/心情标签/语气变化） | ① 用户把它当"它真的感觉到了"（拟人化误解，且模型的形容词会自我强化）；② 展示即承诺——显示"生气"就必须真的改变行为，否则是装饰；③ 推断本身不可靠：面部/表情推断情绪的效度受到系统性批评（Barrett et al. 2019, *Psychological Science in the Public Interest*）**[未核实原文数字]** | 游戏 NPC（FearNot! 一类）把情绪外化成动画；Sims 的 moodlet 是可见 UI **[未核实]** |
| 纯内部调制（只影响行为不展示） | ① 不可观测 → 不可调试、不可纠正，"它今天怎么这么冷淡"无从归因；② 容易变成隐性操纵；③ 用户无法否证，等于无法测试 | FAtiMA 的决策模块：情绪只改行动效用，不对外说 **[一手]** |
| 开关先例 | 没找到把 visible/hidden 当一等公民的开源项目 **[未证实]**；最接近的是 FAtiMA 每个情绪类型上的 `InfluencesMood` 布尔位（`new OCCEmotionType("Fear", Negative, false, ...)` = 这类情绪不进 mood 聚合） | `OCCEmotionType.cs` **[一手]** |

建议做法：**同一个状态、两个渲染器**。内部注入只给数字（`v=+0.32 a=0.61`）+ 调制规则；`agent-man affect show` 才渲染成人话，且**不用第一人称感受动词**（"v=+0.32 a=0.61 (satisfied) ← 3 条 stim"，而不是"我感到满意"）。这样"显示"不会变成"声称有感受"，也能被一条正则测试钉住。

---

## 5. 不可做与漂移

| 结论 | 证据 | 数字 |
|---|---|---|
| 不能说"它真的有感受" | 情绪在原版理论里依赖内感受与稳态调节（constructive/appraisal 传统都要求"对个体有后果"）；LLM 没有身体、没有内稳态、没有跨会话的利害 | 无（这是定义问题，不是实验问题）；工程上把情绪定义为"可观测状态变量"即可 |
| 自评会偏正 | sycophancy：**5 个** SOTA 助手在 **4 类**自由生成任务上一致偏向附和用户；人类偏好数据里"匹配用户观点"的回答更容易被偏好 | [arXiv:2310.13548](https://arxiv.org/abs/2310.13548) **[一手摘要]** |
| "永远积极"是可测的偏差方向 | 人类对任务型对话的标注 **70.1% 是 neutral**（EmoWOZ）；说明真实分布里"没有强情绪"才是常态，一个总在输出正面情绪的系统立刻偏离 | EmoWOZ Table 1 **[一手]** |
| 过演（over-acting） | 机制清楚：指令遵循 + "有情绪"这个措辞本身就在要求表演；但没有找到直接量化"LLM 情绪表演强度"的论文 → **未证实** | 可自测：让模型给自己的情绪连打 100 次分，看是否挤在 0.7–0.9 的高位窄带 |
| 长上下文漂移 | 状态写在 prompt 里会被稀释；模型每轮重写自己的状态会累积漂移 | Lost in the Middle **[一手摘要]**；漂移幅度**未证实** |

---

## 6. 手动 / 自动的优先级方案

**分层，而不是覆盖**（覆盖会打架，分层不会）：

```text
effective = clamp( baseline + Σ_i decay(stim_i, now) , -1, 1 )
if exists override with now < override.until:  effective = override.value   # 完全接管，标 by=manual
```

| 层 | 谁写 | 生命周期 | 语义 |
|---|---|---|---|
| baseline（性格/立场） | 手动：`affect baseline --v 0.2 --a 0.1 --why …` | 长期（= Plutchik 的 temperament 层） | "默认怎么待人" |
| transient（事件偏移） | 自动：每条 stim | 分钟–小时（T½=45min） | "刚才那件事的影响" |
| override（显式情绪） | 手动：`affect set --v -0.6 --a 0.8 --ttl 2h` | 有 `until`，过期自动失效 | "现在就按这个来" |

先例：
- **Affect Control Theory（Heise）**：`fundamental sentiment`（稳定、由身份决定）vs `transient impression`（被事件推动、随后衰减回基线），行为由两者的偏离（deflection）驱动——这就是"手动基线 + 自动偏移"的现成理论。**[二手，未核实原文公式]**
- **FAtiMA**：情绪自动衰减，但每类的 `Decay`/`Threshold` 是作者手调的——"手动调参数、自动跑状态"。**[一手]**
- **告警系统**：手动 `silence/snooze` + TTL，是同构做法（手动压制自动，且有时限，不会永久漂移）。

为什么不打架：手动只写 baseline 和 override，自动只写 transient；两者不在同一层，唯一冲突点在 override，而 override 有 TTL。审计上：`audit affect` 能列出每条 stim 的 `src`（`user`/`tool`/`self`）和 `by`（谁设的 baseline），跟现有 `src` 体系一致。

---

## 7. 触发源 A/B/C 对比与推荐

| | A. 模型自报 | B. 由事件结构化推断 | C. 外部信号 |
|---|---|---|---|
| 代表 | Generative Agents 的 `poignancy`（1–10，LLM 打分）；各种"人格 agent"让模型写"我现在的感受" | OCC/FAtiMA 的 5 变量；EmoWOZ 的 OCC 派生标注；ALMA | 工具退出码、耗时、重试次数、用户纠正/打断、"被打回"次数；对话系统的 sensor-free 检测（D'Mello & Graesser 一路） |
| 需要什么输入 | 一段自然语言 + 一次 LLM 调用 | desirability / likelihood / attributionself-vs-other / significance（3–5 个数） | 已经有的事件流（agent-man 的 `events` 里 `src.origin=tool` 就够） |
| 可靠性 | 低：同一事件两次评分可能不同，不可复现 | 高：纯函数，同一输入同一输出 | 中：客观但归因歧义（工具坏了 ≠ 对用户不满） |
| 漂移方向 | **偏正**（sycophancy + 指令遵循"要有情绪"） | 无系统性漂移，但会"沉默"（规则没覆盖 = 无情绪） | 偏负（失败信号多） |
| 成本 | 每事件一次模型调用 | 调用方多填 3–5 个字段 | ≈0 |
| 能否被测试钉住 | 不能（要 mock 模型） | 能（表驱动 + 固定 now） | 能（构造事件序列） |

**推荐组合**：
- **B 为主干（约 70% 的刺激）**：调用方（agent）只填 appraisal 变量，不填情绪词。这是关键分工——"好不好、多意外、怪谁、多重要"是可核查的输入；"我现在很生气"是结论，结论由工具的算术产生。
- **C 做自动兜底（约 30%）**：`tool` 失败/超时/连续重试 → 固定映射（失败一次 `v-0.3,a+0.2`；连续 3 次 `v-0.5`），不需要任何模型参与，也不需要联网。
- **A 只作元数据**：允许 agent 写 `--note "这条值得记住"`，权重上限 ±0.2，必须带 `evidence`，且**永远不能单独决定情绪值**；进审计账本，正向占比超阈值时打 `! 疑似正向漂移`。

**为什么 AI 不能照搬人类**（每条都对应一个工程后果）：
1. 没有身体和内感受 → 情绪没有"生理底噪"，只能是被写入的数字。
2. 没有内稳态/稳态调节（allostasis）→ 没有"恢复平衡"的内在驱动，只有我们写的衰减函数。
3. 没有真实利害 → 失败对它是 token，不是损失；所以 C 类信号必须由人定义权重。
4. 语言自评即表演 → 让它"报告感受"等于让它"生成一段符合期待的感受描述"（sycophancy 数据）。
5. 上下文一长就漂移 → 状态不能靠"记住"，必须每轮重算、重注入。

---

## 给 agent-man 的三条硬建议

**1. 只存刺激，不存情绪；情绪是读时算出来的纯函数。**
`state/affect-<月>.jsonl` 只追加两类行：`{op:'stim', at, tag, v, a, d, imp, src, why, evidence}` 与 `{op:'baseline'|'set'|'clear', at, v, a, ttl, by}`。`affect(home, now)` 输出 `{v, a, mood, tags[], top, contributors[]}`。
可测：① 同一文件 + 同一 `now` 两次调用结果逐字节相等；② 删掉全部 `stim` 后必须等于 baseline；③ `now` 比所有 `at` 早 1ms 时返回 baseline 而不是 NaN。

**2. 衰减与叠加写成两个纯函数 + 一张常数表，全部用断言锁住。**
```js
decay(i0, dt, half) => i0 * Math.pow(0.5, dt / half)
merge(i1, i2)        => Math.log(Math.exp(i1) + Math.exp(i2))   // FAtiMA 的 log-sum-exp
```
可测：`decay(1, 45*60e3, 45*60e3) === 0.5 ± 1e-9`；`decay` 严格单调减且 `decay(0,·)=0`；`merge(a,b)===merge(b,a)`；`merge(a,a) < 2a`（次可加，防"三条小事=一次暴怒"）；`merge(0,x) === x`（中性不放大）。常数只从 `core/constants` 读，测试一律传死 `now`。

**3. 可见性放在渲染层，并用"反拟人化"测试锁住。**
`affect show` 只输出 `v=+0.32 a=0.61 (satisfied) · mood=+0.12 · 3 条 stim`；注入 prompt 的块 ≤ 80 cost，只含数字 + 一句调制规则（例如"语气简短，不主动提建议"），不含任何形容词。
可测：渲染结果对 `/(^|[^a-z])(我|感到|觉得|feel|feeling)/i` 必须不匹配；`affect show --json` 的键集合固定；override 过期（`at+ttl+1ms`）后输出必须回到 baseline 且 `by` 字段从 `manual` 变回 `auto`。

---

## 8. 「一条情绪条」模型评估（0–100 标量 + 事件增量 + 阈值映射 + 回落）

用户描述来自《魔幻手机》傻妞：一条数值条，关键事件加减，不同区间对应不同情绪，自动回落。这是 2000 年代 TV/游戏里最常见的形态。下面把它当工程方案审一遍。

### 8.1 先例与数值

| 系统 | 范围 | 起点/中性 | 关键阈值 | 单次增量 | 回落 | 来源 |
|---|---|---|---|---|---|---|
| 暗黑地牢 stress | **0–200** | 0（新兵）；回城封顶 **100** | **100** → resolve test（得 affliction，小概率转 virtue）；**200** → 心臟病 / 濒死 | 小额 **±3**（击杀 / 暴击 / 暴击治疗）；解陷阱 **-8**；转美德后归 **40–45**；减伤上限 **80%** | 闲置 **-5/周**（Puppet Theatre 区 **-15/周**）；酒馆/修道院一次消一大截 | 一手抓取 [wiki.gg Stress](https://darkestdungeon.wiki.gg/wiki/Stress) |
| 饥荒 sanity | **0–200**（多数角色默认上限） | 满 | 百分比带：≤80 / 75 / 60 / 50 / 45 / 40 / 15 / 10% 各有可观测后果 | 瞬时 **+50 / +33 / +15 / +10**；Codex Umbra **上限 -55** | 持续量：光环 **-25/min**、Sisturn **+25/min**、±3.33、±2；睡帐篷 **+60/min** | 一手抓取 [fandom Sanity](https://dontstarve.fandom.com/wiki/Sanity) |
| FAtiMA mood | **-10 到 +10** | 0，且 `|x|<0.5` 归零（死区） | 无分段，强度连续 | 每条情绪 `valence × intensity × 0.3` | 指数，T½=60 tick | 源码一手 |
| 模拟人生 4 moodlet | 定性 | — | 同类 moodlet 强度求和、取最高者为主导情绪 | 每个 moodlet 有强度档 | 每个 moodlet 有持续时长 | **数值未证实**（站点 403，未取到） |
| galgame 好感度 | 常见 0–100（隐藏值） | 中位 | 选项 / 结局门槛 | 每次选择 ±1..±10 | **通常不回落，只增** | **未证实**（无权威一手） |
| Replika / Character.AI 关系等级 | 定性 | — | 关系阶段 | — | — | **未证实**：无公开公式或数值 |

从这 6 个里能提炼的稳定设计只有四条：① 区间取 0–100 或 0–200；② 一个"出事阈值"（100 或 200）+ 一个"恢复位"（40–45）；③ 单次事件只动个位数，只有"大事件"给两位数（+50 / -55）；④ **必须有回落**，否则一定饱和。galgame 式"只增不减"是反例，它的后果就是刷满即无信息。

### 8.2 与 PAD / OCC 的对比

| | 单标量条 | PAD 三轴 | OCC 22 类 |
|---|---|---|---|
| 输入成本 | 1 个数 | 3 个数 | 5 个 appraisal 变量 |
| 可解释性 | 最好（一根针） | 中（要查八分仪表） | 差（22 类 + 判定表） |
| 区分力 | 只分"好/坏、高/低" | 能分"怒 vs 怕" | 能分"怒 vs 怨 vs 鄙视" |
| 阈值抖动风险 | **最高**（连续量 + 硬阈值） | 高（三轴各抖） | 低（离散类别，切换本身是事件） |
| 饱和风险 | **最高**（加法 + clamp） | 中 | 低（每类有阈值，不到则不显） |
| 被测试钉住 | 容易 | 中 | 容易（表驱动） |
| 长上下文成本 | 最好（一个数） | 中 | 差（22 类写不进 80 cost） |

结论：单标量在**注入成本**和**可测性**上赢，在**区分力**上输。而 agent-man 的 `INJECT_BUDGET=1000`、单个 affect 块 ≤80 cost，22 类根本写不下 → **OCC 只能当生成器，不能当存储形态**；PAD 可以当内部计算，但对外仍要压成一个数。

### 8.3 三个必须单独解决的工程问题

**(a) 阈值抖动（flapping）——用滞回，不用滤波**

```text
band(x, prev):
  if x >= enter_hi        -> 'high'      # 例如 58
  if x <= exit_hi         -> 'mid'       # 例如 55   (exit = enter - δ)
  else                    -> prev        # 死区：保持在上一档
```

数值依据：饥荒用的就是 **15% 出现 / 17.5% 消失**，间隙 2.5 个百分点（上限 200 时 = 5 点）。agent-man 建议 **δ = 3**（0–100 上 3 点），因为单次 stim 的 |Δ| 落在 2–15：δ 太小挡不住噪声，太大响应迟钝。

再加一条**死区**：`|x − 50| < 5` 一律报"平静"、不参与任何行为调制——对应 FAtiMA 的 `|mood| < 0.5` 归零。

**(b) 多事件叠加——同类 LSE、跨类加权和、再 clamp**

```text
same_tag = LSE(Δ1, Δ2, ...)          # 3 次 -8 → -8.6，而不是 -24
delta    = Σ_t w_t * same_tag_t
x_new    = clamp(x + delta, 0, 100)
# 速率限制：同一 tag 每小时最多计 3 次，第 4 次起记 0 并留账 `! rate-limited`
```

一手依据：FAtiMA 对同类情绪就是 LSE（`I = ln(e^I1 + e^I2)`）；暗黑地牢的 ±3 可叠但有 80% 减伤上限；饥荒的光环有 ±25/min 的硬边界。

**(c) 长期饱和漂移——漏积分器 + 对称性审计**

任何"加法 + clamp"的系统，只要正负事件不对称，最终必然贴边。两个成熟对策：
1. **向静止点回落**：`x' = −(x − x0)·ln2/T½ + Σinputs`。FAtiMA 的 mood 回落到 0；暗黑地牢用"回城封顶 100 + 闲置每周 -5"。
2. **分布审计**：统计 `P(x≥80)` 与 `P(x≤20)` 的时长占比，差超 3:1 就报 `! 分布偏斜`。

建议参数：`T½ = 8h`、`x0 = 50`、负向权重 ×1.5、负向 T½ ×1.4。"坏比好更强"（negativity bias）是心理学里较稳的定性结论（Baumeister et al. 2001 **[二手]**），但**具体倍数是我们选的，不是实验值**。

### 8.4 一条够不够

- **够用的部分**：显示、阈值映射、衰减、单维度行为（多说/少说、主动/保守）。EmoWOZ 的 **70.1% neutral** 也说明：绝大多数时候用不上细分类别。
- **不够的部分**：用户举的"难过 / 平静 / 兴奋"其实把两个轴压成了一根——低端是"低愉悦"，高端是"高愉悦 + 高唤醒"。一根条**两端还算准，中段失真**：`x=50` 既可能"平静"也可能"无聊/疲惫"，`x=70` 既可能"满意"也可能"兴奋"。
- **最强的反证（间接）**：暗黑地牢与饥荒都不是"一根条管全部"，而是三根并列（stress + HP + hunger / sanity + HP + hunger）——成熟产品里没有"单一内部状态条"的先例，单条只用于**单一维度**（压力、理智）。
- **"单条够用"的实证**：没检索到 → **未证实**。

所以：**一条标量够做"状态 + 阈值 + 回落"，不够做"语气区分"**。第二轴不是必须，但若要，只加一条、必须**正交且可观测**——arousal，因为它直接映射到渲染（回复长度、句子断裂、是否追问）；而 trust / dominance 在 CLI 里没有可观测输入，加了就是编。

### 8.5 "关键事件"怎么定义（不靠模型自评）

分两类：**可判定的自动算，语义类的由调用方用封闭枚举声明**。声明是输入，自评是结论——两者不能混。

| 事件 | 判定方式 | 权重 Δ | 类别 |
|---|---|---|---|
| 工具失败 | `src.origin=tool` 且 cues 含 `exit≠0` | **-8** | C（自动） |
| 连续失败 | 10 min 内同工具失败 ≥3 次 | 额外 **-12** | C |
| 承诺逾期 | `plans.due < now` 且未完成 | **-15** | C |
| 久别重逢 | `now − lastActiveAt > 3d` | **+10** | C |
| 反复纠正同一事实 | 同 `key` 的 evidence 更新 ≥3 次/天 | **-6** | C |
| 用户表扬 / 致谢 | 调用方声明 `kind=praise` | **+12** | A（受限） |
| 完成一个大任务 | 调用方声明 `kind=done` + `imp` | **+8·imp/3** | A（受限） |
| 被明确纠正 | 调用方声明 `kind=corrected` | **-10** | A（受限） |

规则：`kind` 是封闭枚举（写错退出码 2），**权重表在 `core/constants`，不允许调用方传权重**——否则又能漂。这样 A 类只能选"哪一类"，不能选"多少"，上限被钉死。

### 8.6 给 agent-man 的明确建议

**主模型：单条 0–100 标量，`50` 为中性静止点，向 50 指数回落（T½=8h），滞回 δ=3，死区 ±5；另挂一条 `arousal ∈ [0,1]` 只做渲染与权重调制，不参与任何阈值判定。**

```text
# 读时算，不存
v = override ?? clamp(50 + Σ_t w_t * LSE(Δ_t), 0, 100)
a = clamp(Σ_t |Δ_t| / 40, 0, 1)          # 由"事件有多猛"推，不单独存
band = hysteresis(v)                      # 5 段，δ=3
modulate: reply_len   *= 1 - 0.3*(v-50)/50
          assertiveness *= a
```

分段（v）：`0–20 低落` / `20–45 略低` / `45–55 平静`（死区）/ `55–80 不错` / `80–100 兴奋`。

可测断言：
1. `v(now)` 是 `(stim[], baseline, override, now)` 的纯函数，同输入同输出；
2. 连续注入 100 次 `-8` 后 `v ≥ 0`，且 24h 后回到 `50±3`（防饱和）；
3. 在 52–58 之间来回注入 ±1 噪声 100 次，`band` 切换次数 ≤1（滞回生效）；
4. `a` 只影响 `reply_len / assertiveness` 两个字段，与 `band` 无关（正交性）；
5. `kind` 不在枚举内 → 退出码 2。

---

## 来源核验说明

- **一手（本次实际抓取并引用原文/源码）**：Mehrabian PAD 页面；FAtiMA-Toolkit 的 6 个源文件；EmoWOZ PDF；EmpatheticDialogues PDF；arXiv 2304.03442 / 2307.03172 / 2310.13548 摘要与正文节选；SEP `emotion` 条目 §6；PyPI 三个包元数据；GitHub API 仓库检索（确认"MoodEngine"无可信对应物）；[暗黑地牢 wiki.gg Stress](https://darkestdungeon.wiki.gg/wiki/Stress)（0–200 / 100 阈值 / 40–45 / -5 每周 / 80% 上限）；[饥荒 fandom Sanity](https://dontstarve.fandom.com/wiki/Sanity)（阈值带 + 15%→17.5% 滞回 + 各速率）。
- **二手（百科/综述转述，未回到原文）**：Russell 1980、Ekman 1992、Plutchik 1980/2001、ALMA、Affect Control Theory、Barrett 2019、Baumeister et al. 2001（negativity bias）。
- **未证实**：FAtiMA 的 tick 与秒的换算；SEC 子项的确切命名与页码；Sims 4 moodlet 的具体强度/时长数值；galgame 好感度与 Replika/Character.AI 的公开数值；"过演"的量化数据；"单条标量足够"的实证；NRC-VAD 的中文覆盖情况。
- **抓取方式说明**：fandom / wiki.gg 对 `Invoke-WebRequest` 直接返回 403（Cloudflare），经 `https://r.jina.ai/<url>` 取到正文；暗黑地牢 fandom 域仍被 CAPTCHA 拦，改用同名 wiki.gg 域。
