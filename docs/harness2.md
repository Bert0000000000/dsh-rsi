# Harness² 与 dsh-harness2：对 dsh-rsi 的参考

本文记录 2026-11-25 的调研结论，说明 Google Harness² 的方法、社区插件 `Asiu-x/dsh-harness2` 在 DSH 里的调用方式，以及 dsh-rsi 与它的差异和可借鉴点。

## 1. Google Harness² 是什么

论文《Harness²: Recursive Agent Harnessing for an Open World》（arXiv:2610.14224，Google Cloud AI Research + Northwestern）提出：冻结模型权重，把可编辑的 **harness** 当作改进对象，用同一任务下不同 harness 的执行差异来提议、探测、合成改进，不需要 ground truth 或 rubric。

- Harness 的 8 个组件：system prompt、guardrails、memory、tool guidance、subagents、skills、scripts、plugins。
- **P-P-C**：Propose（提议 harness 改动）→ Probe（同一任务各跑一次）→ Compose（按证据合并/保留）。
- 两级递归：任务级（改当前执行的 harness）+ harnessing 级（把采纳的 harness 与经验写入改进库，指导下一次改进）。
- 代码：`google-research/harness2`（Apache-2.0）；项目页 `harness2.github.io`。论文与代码均标注为研究原型，不是 Google 官方支持产品。

## 2. Asiu-x/dsh-harness2 怎么被 DSH 调用

`Asiu-x/dsh-harness2` 是社区第三方插件（v0.1.1，HEAD 55ddce2），只移植方法，不复现论文基准；与 Google/DeepSeek 无隶属。npm 无同名包，只能从 GitHub 安装。

```bash
dsh plugin --profile web add github:Asiu-x/dsh-harness2
# 重启 DSH 后验证
dsh --profile web --dump-config | grep -A2 harness2
```

- 包：`type=module`、`dsh.bundle.patch=./cordis.patch.yml`、`engines.node>=20`，无 dependencies；**无 dsh.client、无 Host 服务、无页面**。
- bundle：`cordis.patch.yml` 只 insert 一个 Host 插件 `dsh-harness2`。
- 注册面：3 个工具 `harness2_refine` / `harness2_status` / `harness2_reset`；1 个命令 `/harness2 [status|library|reset]`；1 个动态 systemPrompt section `harness2:adopted`（order 10050）；`inject=['agents','agentDefaultModel','systemPrompt','tools']`。
- 子 agent：`ctx.agents.create`，session id `session-h2-<uuid>`；继承父 preset，内部 agent 先清空 adopted section，避免污染证据。
- 经验闭环是**纯手动**（工具或 `/harness2`），没有会话结束/失败/定时 hook；唯一自动的是采纳后把 always-on 文本 + 最近 3 条 lesson 注入该 workspace 后续普通 agent 的 systemPrompt。

### 一次 refine 的成本

`harness2_refine(task, domain, k≤3, mode, isolation)` 在 copy 隔离下：

1. 复制工作区到 `.dsh-harness2/runs/<run>/workspaces/pristine`（默认 50MB 上限）。
2. 跑 k 次 base rollout。
3. 两个 proposer（INV 工作方式 / DOM 领域知识）改 `context/harness/` 树，失败重试 ≤2 次。
4. 硬校验闸门：4 个 always-on 文件 ≤12000 字符；skill 名必须出现在 system.md/guardrails.md；引用 script 必须存在；拒绝模板花括号与 off-surface 文件。
5. 每候选独立工作区副本、同一任务各跑一次；证据=轨迹+交付物+文件 diff+是否交付。
6. 一个 composer 合并/采纳/保留 base；每个决定引用具体轨迹时刻。
7. 候选 id 按 hash 打乱、harness 隐藏，按 DELIVERY→CONFORMANCE→FIDELITY→CONSISTENCY→FINISH 比较；base 入池；base 胜或 winner 与 base 字节相同 → 不采纳。
8. 逐组件 verdict（helped/hurt/no observed effect/confounded）+ ≤1 条可迁移经验 `{cue, lesson, evidence, confidence}`。
9. 采纳写 `.dsh-harness2/harness/` + `state.json`，归档到 `library/<domain>/harnesses/<date>-<task>/` 并重建 `INDEX.md`。

k=1 sequential 约 9 个 child agent（1 base + 2 propose + 2 probe + 1 compose + 1 final probe + 1 selector + 1 reflect）。

## 3. 与 dsh-rsi 的差异

| 维度 | dsh-harness2 | dsh-rsi |
| --- | --- | --- |
| 评分 | 无 rubric，轨迹/产物对比 + LLM 盲选 | rubric 机器评分 + 重复采样 passRate |
| 采纳 | 工具调用即自动写 harness | 用户批准 + 备份 + evidence 必填 + 冒烟/回滚 |
| 数据 | `.dsh-harness2/`（workspace 内） | `.rsi/`（workspace 账本）+ `~/.dsh/rsi`（跨工作区账本） |
| 改进单位 | INV/DOM 两路，k≤3 | 多变体 harness，subagent probe，repeats 1–9 |
| 可见性 | 命令/工具输出 | 全局侧栏总览 + 账本页 |
| 触发 | 纯手动 | 工具/命令手动；失败证据/反思卡自动收集 |

## 4. 可借鉴点（按优先级）

1. **KEEP_BASE 一等公民**：证据不足就保留基线，避免“为改而改”。dsh-rsi 的 `rsi-collect` 已要求 `passRate ≥ minPassRate`；可再加“变体与基线无显著差异 → 不建议采纳”的提示。
2. **base 入池 + no-op 检测**：防止 winner 与 base 字节相同仍被采纳。可用 `rsi-compare` 的 `same` 计数做门禁。
3. **匿名盲选**：对产物做匿名 pairwise，降低“更复杂=更好”的偏见；dsh-rsi 的 `rsi-compare` 已有目录 diff，可扩展为匿名裁判。
4. **领域库四元组**：`{cue, lesson, evidence, confidence}` + `INDEX.md` + 按 recency 注入。当前 `~/.dsh/rsi/ledger.json` 的 `lessons` 已有 title/body/sources；可加 `cue`/`confidence` 字段。
5. **INV/DOM 正交拆分**：工作方式与领域事实分开提，天然单变量归因；对应 dsh-rsi 的 8 组件 `edits`，可固定“工作方式”和“领域知识”两类模板。
6. **硬校验闸门**：always-on 上限、skill 触发名、script 存在性；可移植到 `rsi-adopt` 的 preset 校验。
7. **隔离 + diff**：每 probe 独立副本 + 交付物 diff；dsh-rsi 的 probe 目录已经是独立副本，`rsi-audit` 可补“交付物 diff”摘要。
8. **成本门槛**：k 上限 3、默认 1、明示 child runs 数；dsh-rsi 的 `budget` 已限制 `variants × repeats`，可在 `rsi-plan` 输出预估 child agent 数。

## 5. 怎么选

- 有明确机器可判标准、需要统计置信度：用 **dsh-rsi**（rubric + repeats + passRate + compare）。
- 开放任务、没有 ground truth、需要从行为差异里发现改进：用 **dsh-harness2**（P-P-C + 盲选）。
- 两者可同时安装，但都会创建子 agent，成本叠加；同一轮改进建议只用一个方法，避免证据互相污染。

## 6. 参考

- [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)
- [google-research/harness2](https://github.com/google-research/harness2)
- [harness2.github.io](https://harness2.github.io/)
- [Asiu-x/dsh-harness2](https://github.com/Asiu-x/dsh-harness2)
