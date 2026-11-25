# dsh-rsi

DeepSeek Harness 的 RSI（Recursive Self-Improvement）工具包：把 Harness² 的 Propose–Probe–Compose 循环固化为 12 个全局工具，补齐「失败证据自动收集 → 反思任务卡 → 巡检摘要 → 提案审核 → 采纳（冒烟 + 回滚）→ 教训沉淀」闭环，并提供一个全局侧栏总览和跨工作区经验账本。工作区数据仍写在各工作区 `.rsi`；汇总账本写到 `~/.dsh/rsi`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rsi-plan` | 创建一轮实验：统一任务 T + 候选 harness 变体（可给 `edits` 按 8 组件合成），可配 `repeats`（默认 3）、`mode`（parallel/sequential）、`budget`、`minPassRate`、`parent`；落盘任务/评分表/变体文件并返回每个 probe 的启动指令（模型用 subagent 工具执行） |
| `rsi-run` | 实验状态机（只读）：按变体 × 重复扫描 probe 产出（`done/partial/empty`），报告 `repeats/mode/budget/parent/children/archived/meta`，对缺失的 `(variant, repeat)` 重放启动指令 |
| `rsi-collect` | 按 rubric 逐次评分并按重复聚合（均值/标准差/passRate），生成 report.md/report.json（含 `repeats/minPassRate/failedVariants/rubricHashVerified`）。评分表只读 `rubric.json` 并与创建时的 sha256 比对 |
| `rsi-compare` | 对比式探测：对同一实验两个变体的第 k 次产出做目录级 diff（only-a/only-b/changed/same），写 `compare/<a>__vs__<b>/r<k>/compare.{md,json}`；可回写 `judge{winner,reason,confidence}` |
| `rsi-archive` | 实验归档：`archive`（移到 `.rsi/runs/_archive/<ts>-<runId>` 并标记）、`restore`、`list`（同时给出 parent→children 血缘） |
| `rsi-audit` | probe 写隔离审计：扫描实验 `createdAt` 之后工作区内（`.rsi` 之外）被写入的文件，暴露越界写 |
| `rsi-adopt` | 采纳 harness 改动：**必须传 `proposalId` 且提案为 `approved`**。workspace 模式（AGENTS.md / .agents/**/SKILL.md / `.rsi/**` 排除 bundles|evidence|state|proposals|backups）先备份、后写入，再跑冒烟（可选 `smoke{command,timeoutMs}` + js/json/非空检查），失败自动回滚；preset-bundle 模式落盘 cordis.patch.yml 到 `.rsi/presets/` 并返回 plugin_manager 安装指令 |
| `rsi-status` | 查看实验、教训条目/行数、备份、preset bundles、提案库分布、反思卡/巡检摘要数量、最近反思与摘要时间、状态文件错误（`stateError`） |
| `rsi-evidence` | 读取自动收集的失败证据（列文件 / 按文件读最近记录） |
| `rsi-propose` | 基于证据起草提案写入 `.rsi/proposals/<ts>-<slug>.md` 并登记 `index.json`（`draft`）；`basedOnEvidence` 为空直接拒绝 |
| `rsi-review` | 审核提案：`list` / `approve` / `reject`，改状态并同步改写提案 md 的状态行 |
| `rsi-lesson` | 教训库：`add` 追加（正文去重）、`list` 读取最近条目；`rsi-adopt` 采纳时也会自动追加 |

## 实验生命周期（B 批）

```
rsi-plan  →  variants/<n>-<label>/{harness.md,edits.json}
             probes/<n>-<label>/r<k>/         （repeats>1 时；旧实验无 r<k> 按单次兼容）
rsi-run   →  逐 (variant, repeat) 看 done/partial/empty，给出补跑指令
rsi-collect → 逐次评分 → 变体聚合（executed/passRate/mean/stdev）→ report.md/json
rsi-compare → 两变体同一 k 的产出 diff + 可选裁判结论
rsi-archive → .rsi/runs/_archive/<ts>-<runId>，索引保留 parent/children 血缘
```

- 聚合判定：**执行齐全部重复** 且 `passRate ≥ minPassRate`（默认 1）且 **均值 ≥ passScore**；缺跑的重复按 0 分计入 passRate，任一次有机器项失败即该次未通过。
- `budget` 默认 24，`variants × repeats > budget` 时 `rsi-plan` 直接拒绝；`config.json` 记录 `repeats/minPassRate/mode/budget/parent/rubricRuleVersion/meta`（node/platform/arch/gitHead/cwd/createdAt）。
- `variants[].edits` 只能改 8 个组件之一：`system-prompt`、`guardrails`、`memory`、`skills`、`tool-guidance`、`scripts`、`subagents`、`plugins`；不给 `edits` 时回落到整份 `harness` 文本。
- 运行索引 `.rsi/runs/index.json`（原子写，坏 JSON 转 `.corrupt-<stamp>.bak` 并保留原文件）。

## 自动闭环（Tier 3 + Tier 4）

```
tools/result(isError) ┐
agent/error          ├→ .rsi/evidence/<session>.jsonl（先脱敏再落盘）
feedback/committed   ┘        │
                              │ 每轮 turn/end（session/event）
                              ▼
                新增证据 ≥ 3 且距上次 ≥ 5 分钟
                              │
                              ▼
             .rsi/inbox/reflect-<ts>.md（反思任务卡）
                              │  未消化反思卡 ≥ 3 张
                              ▼
             .rsi/inbox/digest-<ts>.md（巡检摘要：来源/工具排名/待审提案）
                              │
                              ▼
  rsi-evidence → rsi-propose(draft) → rsi-review approve
                              → rsi-adopt(proposalId) → applied → rsi-lesson 沉淀
```

- 水位与冷却记在 `.rsi/state/reflection.json`：反思按会话隔离，摘要用已消化清单（`digestConsumed[]`）判定未消化卡片。状态文件损坏会转存 `.corrupt-<stamp>.json` 并在 `rsi-status` 的 `stateError` 中告警。
- 证据写入前经 `redactSecrets` 脱敏（OpenAI/AWS/GitHub/Slack 令牌、JWT、`Bearer` 头、`api_key|token|secret|password` 赋值），再按 500 字符截断；证据文件超 200 行或 200KB 时轮转 `.1.jsonl`。
- 反思卡与巡检摘要只做提示与证据摘要，不自动改任何 harness 文件；采纳必须经过 `rsi-review approve` + `rsi-adopt`。
- 本版的面板是只读总览 + 账本，不含实时审核/采纳按钮；审核与采纳仍在对话里用 `rsi-review` / `rsi-adopt` 完成。

## 全局总览与跨工作区经验账本

安装后左侧栏出现「RSI 总览」：读取所有已注册工作区的 `.rsi`，合并实验、证据、教训与提案；可按工作区筛选，点开记录看详情。页面只读，不会修改 harness。

- **手动同步**：账本页「同步账本」把所有工作区的教训/提案汇总到 `~/.dsh/rsi`（`ledger.json`、`lessons.md`）。
- **自动同步**：`rsi-lesson` 或 `rsi-adopt` 成功后，Host 自动把当前工作区的经验并入账本；无需再点同步。
- **跨工作区复用**：账本只提供证据索引，不会自动改任何文件；`rsi-adopt` 仍要求 approved 提案和冒烟检查。
- **失败证据**：`tools/result` 失败、`agent/error`、差评反馈继续写入各工作区 `.rsi/evidence`；账本按 `sources` 记录来源工作区。

> 账本是 profile 级（`~/.dsh/rsi`），不是某次会话的私有数据；所有工作区共享同一份经验索引。

## rubric 机器评分项

| kind | 语义 |
| --- | --- |
| `file-exists` | probe 目录内 path 文件存在且非空（0 字节 / 只有空白判失败） |
| `line-count` | 文件行数在 min~max 区间 |
| `regex-all-lines` | 所有行匹配 pattern 正则 |
| `regex-last-line` | 最后一行匹配 pattern 正则 |
| `contains` | 文件内容包含 pattern 子串 |
| `command` | 在 probe 目录执行 `run` 命令，退出码等于 `expectExit`（默认 0），可选 `pattern` 匹配 stdout+stderr；超时上限 60s |
| `manual` | 人工评审（ok=null，collect 汇总进「待人工评审」清单） |

`passScore` 为加权及格分（必须是 > 0 的有限数字）；每次得分 = Σ(通过项 × weight)。判定规则：**任一次中任一机器评分项失败即判该次未通过**，变体还需执行齐重复次数、`passRate ≥ minPassRate`、均值 ≥ `passScore`；顶层 `passed` 要求所有变体都通过。`manual` 项不进分母。变体目录以 `variants/` 为准，缺对应 `probes/` 目录记 0 分。

正则安全（C5）：`pattern` 长度 ≤ 1000、输入 ≤ 512KB，拒绝嵌套量词与反向引用，`vm` 内带 250ms 超时执行，防 ReDoS。

## 典型一轮 P-P-C

1. `rsi-plan`：task=T，variants=[基线, 候选 edits A]，repeats=3，rubric=机器可判项（含必要时 `command`）。
2. 模型按 instructions 用 subagent 为每个 `(变体, 第 k 次)` 启动**全新**子代理，任务文本完全一致，只有 harness 约束不同；probe 只能写自己的 `probes/<n>-<label>/r<k>/`。
3. `rsi-run`：查看谁还空着，按指令补跑；`rsi-audit` 检查有没有越界写。
4. `rsi-collect`：得到逐次分数与聚合判定。
5. `rsi-compare`：对关键差异做行为对比，必要时让裁判子代理给 `judge`。
6. 有稳定差异 → `rsi-propose` → `rsi-review approve` → `rsi-adopt`（冒烟通过才落教训、标 applied）→ `rsi-lesson`；无差异 → 不采纳，把结论记进 harness-lessons.md。
7. 收尾 `rsi-archive` 归档老实验。

## 单测

```bash
node --test "test/*.test.mjs"   # 30 项：schema/fsx/redact/regex-safe/rubric/compose/compare/overview + 集成
```

- `test/integration.test.mjs` 用 fake ctx 注册全部 12 工具，覆盖 plan→重复→collect、compare+judge、预算/非法 edits 拒绝、archive/restore、audit、adopt 冒烟回滚与门禁、证据脱敏。
- `test/overview.test.mjs` 覆盖跨工作区聚合：合并 evidence/lessons、给条目打 workspace 标签、排除没有 `.rsi` 的候选。
- 代码按职责拆在 `lib/`：`fsx`（文件与哈希、原子写）、`schema`（参数编译）、`text`、`redact`、`regex-safe`、`rubric`（评分与聚合）、`compose`（组件合成）、`compare`（目录 diff）、`runs`（run 目录与索引）、`audit`（写隔离扫描）。不引入任何 npm 依赖。

## 约束

- 所有工具都要求显式传 `cwd`（工作区绝对路径）；文件写入通过路径前缀 + realpath 校验限制在 cwd 内。
- `.rsi` 目录位置固定（不可通过插件 config 配置，本版本未导出 Config）。
- `rsi-propose` / `rsi-adopt` 红线：证据为空时拒绝；workspace 模式只允许写 AGENTS.md、`.agents/**/SKILL.md`、`.rsi/` 下非 bundles|evidence|state|proposals|backups 的路径；路径含 `..`、绝对路径或经符号链接逃逸一律拒绝。
- 工具 `parameters` 在 `apply()` 内统一走 `compileParameters` 编译：作者侧 DSL（属性级 `required: true`）必须转成模型端合法 JSON Schema，否则非 PTC 模式下整批工具定义会被 provider 拒绝。

## 目录布局

```
.rsi/
  runs/<runId>/
    task.md             # 统一任务 T
    rubric.json         # 评分表（passScore/minPassRate + items）
    config.json         # 实验元信息（repeats/mode/budget/parent/meta…）
    variants/<n>-<label>/harness.md   # 各候选 harness
    variants/<n>-<label>/edits.json   # 组件级改动（若给了 edits）
    probes/<n>-<label>/r<k>/          # 第 k 次 probe 产出（result.txt / report.md 视为完成）
    compare/<a>__vs__<b>/r<k>/        # rsi-compare 的 diff 与裁判结论
    report.md / report.json           # rsi-collect 汇总（逐次表 + 聚合判定）
  runs/index.json              # 运行索引与血缘（parent/children/archived）
  runs/_archive/<ts>-<runId>/  # rsi-archive 归档目录
  memory/harness-lessons.md    # 教训记忆（rsi-adopt / rsi-lesson 追加）
  backups/<ts>/                # workspace 模式改动前的备份
  presets/<name>/              # preset-bundle 模式产物（package.json + cordis.patch.yml + README.md）
  evidence/<sessionId>.jsonl   # 自动失败证据（已脱敏；超限轮转 .1.jsonl）
  proposals/<ts>-<slug>.md     # rsi-propose 提案正文
  proposals/index.json         # 提案库与生命周期（draft/approved/rejected/applied）
  inbox/reflect-<ts>.md        # 自动反思任务卡
  inbox/digest-<ts>.md         # 自动巡检摘要（多卡聚合）
  state/reflection.json        # 反思（按会话）/摘要水位与已消化清单
```

## 安装

三种方式任选：

1. **profile link（本地开发）**：把本仓库路径加进 `~/.dsh/profiles/<name>/package.json` 的 `dependencies`（`"dsh-rsi": "link:D:/path/to/DSH-RSI"`），并在 `dsh.profile.bundles` 末尾追加 `"dsh-rsi"`，然后重启 DSH。
2. **插件管理器**：DSH 侧边栏「插件」→ 右上「+ 添加插件」→ 输入本仓库路径或 npm 包名安装，然后在「已安装插件」里确认 `dsh-rsi` 为「运行中」。

3. **市场 tarball（v1.5.0 起）**：
   ```bash
   dsh plugin --profile web add -w "https://github.com/Bert0000000000/dsh-rsi/releases/download/v1.5.0/dsh-rsi-1.5.0.tgz"
   ```

安装后 12 个 `rsi-*` 工具出现在模型工具集中（PTC 模式下以程序内 SDK 声明出现）；客户端全局侧栏面板「RSI 总览」显示所有工作区的实验、证据、教训和提案，账本页可手动/自动同步。
## 版本

- 1.5.0：合并全局总览/账本页面；新增 `~/.dsh/rsi` 跨工作区账本、手动同步，以及 `rsi-lesson` / `rsi-adopt` 成功后的自动同步；`dsh.client` 改为 slots 全局面板，不再依赖会话 inject。
- 1.4.1：修复 `rsi-compare` 省略 `judge` 时返回 `judge:null` 违反自身 `output.schema`（运行时输出校验报 `value.judge must be an object`）；集成测试的 `call()` 现在按每个工具的 `output.schema` 校验返回值，防同类回归。
- 1.4.0（B + C 批）：重复采样与统计判定（`repeats`/`minPassRate`/均值与标准差、缺跑记 0）；对比式探测 `rsi-compare`（目录 diff + judge）；组件级编辑合成（8 组件 `edits`）；`command` 评分项；预算校验与 `mode`（parallel/sequential）+ `meta` 复现元数据；`rsi-archive` 归档与 parent/children 血缘索引；采纳冒烟校验与自动回滚（C1）；写隔离审计 `rsi-audit`（C2）；证据脱敏（C3）；`stamp()` 毫秒（C4）；ReDoS 防护（C5）；`lib/` 拆分 + `node --test` 28 项单测（C6）。
- 1.3.0（A 批修复）：采纳门禁（`rsi-adopt` 必须带 approved 提案、`applied` 只能来自 `approved`、失败回滚）；采纳白名单 fail-closed；证据修复（读宿主 `exec.arguments`、只采差评反馈、按会话落库）；评分表完整性（sha256 比对、删除 `rubric` 覆盖参数）；评分语义（空文件失败、manual 不进分母、任一失败即未通过）；状态隔离（按会话水位、已消化清单、坏状态转存、证据轮转、原子写 + `.bak`）。
- 1.2.0：新增 `rsi-run`（实验状态机）、`rsi-lesson`（教训库）、turn/end 自动巡检摘要、`rsi-status` 增补 `digests`/`lessonEntries`/`lastDigestAt`。
- 1.1.0：新增提案库与生命周期、`rsi-review`、turn/end 自动反思卡、`rsi-adopt --proposalId`；修复 parameters 未经编译导致的非法 JSON Schema。
