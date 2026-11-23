# dsh-rsi

DeepSeek Harness 的 RSI（Recursive Self-Improvement）工具包：把 Harness² 的 Propose–Probe–Compose 循环固化为 9 个全局工具，并补齐「失败证据自动收集 → 反思任务卡 → 巡检摘要 → 提案审核 → 采纳 → 教训沉淀」闭环。所有写入都限制在工作区的 `.rsi` 目录（以及 adopt 允许的 harness 文件）内。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rsi-plan` | 创建一轮实验：给定统一任务 T + 候选 harness 变体，落盘任务/评分表/变体文件，返回每个 probe 的启动指令（由模型用 subagent 工具执行） |
| `rsi-run` | 实验状态机（只读）：扫描 `.rsi/runs` 下每个变体的 probe 产出，报告 `done/partial/empty`、评分汇总状态，并对缺失 probe 重放启动指令 |
| `rsi-collect` | 按 rubric 对每个 probe 产出机器评分，生成 report.md/report.json（含 total/maxTotal/passed/hasPassScore/rubricHashVerified/failedVariants）。评分表只能读 `rubric.json` 并与创建时的 sha256 比对，不接受调用方覆盖 |
| `rsi-adopt` | 采纳 harness 改动：**必须传 `proposalId` 且提案状态为 `approved`**（否则拒绝）。workspace 模式（AGENTS.md / .agents/**/SKILL.md / .rsi/** 排除 bundles|evidence|state|proposals|backups，先备份、后写入、决策追加进 harness-lessons.md）或 preset-bundle 模式（落盘 cordis.patch.yml 到 .rsi/presets/，返回 plugin_manager 安装指令，人工批准执行）。成功后提案 `approved → applied`；状态更新失败会回滚已写文件并报错 |
| `rsi-status` | 查看实验、教训条目/行数、备份、preset bundles、提案库分布、反思卡与巡检摘要数量、最近反思/摘要时间、状态文件错误（`stateError`） |
| `rsi-evidence` | 读取自动收集的失败证据（列文件 / 按文件读最近记录） |
| `rsi-propose` | 基于证据起草提案写入 `.rsi/proposals/<ts>-<slug>.md` 并登记到 `index.json`（状态 `draft`）；`basedOnEvidence` 为空直接拒绝 |
| `rsi-review` | 审核提案：`list` 列提案与状态、`approve`/`reject` 改状态（同步改写提案 md 的状态行） |
| `rsi-lesson` | 教训库：`add` 手动追加一条教训（同一正文去重）、`list` 读取最近条目；`rsi-adopt` 采纳时也会自动追加 |

## 自动闭环（Tier 3 + Tier 4）

```
tools/result(isError) ┐
agent/error          ├→ .rsi/evidence/<session>.jsonl
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

- 水位与冷却记在 `.rsi/state/reflection.json`：反思按会话隔离（`sessions.<sessionId>.{lastReflectAt,lastEvidenceCount,lastCard}`），摘要用已消化清单（`digestConsumed[]`）判定未消化卡片，不再依赖文件 mtime。状态文件损坏会转存 `.corrupt-<stamp>.json` 并在 `rsi-status` 的 `stateError` 中告警。
- 反思卡与巡检摘要只做提示与证据摘要，不自动改任何 harness 文件；采纳必须经过 `rsi-review approve` + `rsi-adopt`。
- 本版未做：Host `HarnessEditor` service、插件页面板内的实时审核 UI（Electron 客户端无通用 host RPC 网关，面板为静态指引，数据以文件为准）。

## 约束

- 所有工具都要求显式传 `cwd`（工作区绝对路径）；文件写入通过路径前缀校验限制在 cwd 内。
- `.rsi` 目录位置固定（不可通过插件 config 配置，本版本未导出 Config）。
- `rsi-propose` / `rsi-adopt` 红线：证据为空时拒绝；workspace 模式只允许写 AGENTS.md、.agents/**/SKILL.md、`.rsi/` 下非 bundles|evidence|state|proposals|backups 的路径；路径含 `..`、绝对路径或经符号链接逃逸一律拒绝（realpath 校验）。
- 工具 `parameters` 在 `apply()` 内统一走 `compileParameters` 编译：作者侧 DSL（属性级 `required: true`）必须转成模型端合法 JSON Schema，否则非 PTC 模式下整批工具定义会被 provider 拒绝。

## 目录布局

```
.rsi/
  runs/<runId>/
    task.md             # 统一任务 T
    rubric.json         # 评分表（passScore + items）
    config.json         # 实验元信息
    variants/<n>-<label>/harness.md   # 各候选 harness
    probes/<n>-<label>/               # 各 probe 子代理的产出目录（result.txt / report.md 视为完成）
    report.md / report.json           # rsi-collect 汇总
  memory/harness-lessons.md   # 教训记忆（rsi-adopt / rsi-lesson 追加）
  backups/<ts>/                # workspace 模式改动前的备份
  presets/<name>/              # preset-bundle 模式产物（package.json + cordis.patch.yml + README.md）
  evidence/<sessionId>.jsonl   # 自动失败证据（tool-error / agent-error / 差评反馈；超 200 行/200KB 时轮转 .1.jsonl）
  proposals/<ts>-<slug>.md     # rsi-propose 提案正文
  proposals/index.json         # 提案库与生命周期（draft/approved/rejected/applied）
  inbox/reflect-<ts>.md        # 自动反思任务卡
  inbox/digest-<ts>.md         # 自动巡检摘要（多卡聚合）
  state/reflection.json        # 反思（按会话）/摘要水位与已消化清单
```

## rubric 机器评分项

| kind | 语义 |
| --- | --- |
| `file-exists` | probe 目录内 path 文件存在 |
| `line-count` | 文件行数在 min~max 区间 |
| `regex-all-lines` | 所有行匹配 pattern 正则 |
| `regex-last-line` | 最后一行匹配 pattern 正则 |
| `contains` | 文件内容包含 pattern 子串 |
| `manual` | 人工评审（ok=null，collect 汇总进「待人工评审」清单） |

`passScore` 为加权及格分（必须是 > 0 的有限数字）；每个变体得分 = Σ(通过项 × weight)。

判定规则：**任一机器评分项失败即判该变体未通过**，`passScore` 只作分数门槛；顶层 `passed` 要求所有变体都通过。文件缺失、0 字节、只有空白字符都判该项失败。`manual` 项不进分母（只进「待人工评审」清单）。变体目录以 `variants/` 为准，缺对应 `probes/` 目录记 0 分并标 `probe 目录缺失`。

## 典型一轮 P-P-C

1. `rsi-plan`：task=T，variants=[基线, 候选规则 A]，rubric=机器可判项。
2. 模型按返回的 instructions，用 subagent 工具为每个变体启动**全新**子代理（不用 fork），任务文本完全一致，只有 harness 约束不同；probe 只能写自己的 probes/<n>-<label>/ 目录。
3. `rsi-run`：随时查看哪个 probe 还空着/只写了一半，按返回指令补跑。
4. `rsi-collect`：得到各变体得分对比。
5. 有证据差异 → `rsi-propose` 记录提案 → `rsi-review approve` → `rsi-adopt`（workspace 改 harness 文件 / preset-bundle 落盘 bundle）→ `rsi-lesson` 记下决策；无差异 → 不采纳，把结论记进 harness-lessons.md。

## 安装

### 方式一：link 到 profile（开发调试）

在 profile 目录（例如 `C:\Users\<you>\.dsh\profiles\desktop`）的 `package.json` 中：

```json
{
  "dependencies": { "dsh-rsi": "link:D:/Hermes/Workspace/10_Projects/DSH-RSI" },
  "dsh": { "profile": { "bundles": ["dsh-rsi"] } }
}
```

然后重启 DeepSeek Harness（插件代码不热更新）。

### 方式二：插件管理器

GUI 侧边栏「插件」→「+ 添加插件」，填入本地目录路径或包名；等价于 Host 工具 `plugin_manager` 的 `install_bundle`（`target` 传包名字符串）。

安装后可在「插件 → 已安装插件 → RSI 工具包」查看状态，工具会出现在新会话中。

## 版本

- 1.2.0：新增 `rsi-run`（实验状态机）、`rsi-lesson`（教训库）、turn/end 自动巡检摘要（未消化反思卡 ≥ 3 张时生成 digest 卡）、`rsi-status` 增补 `digests`/`lessonEntries`/`lastDigestAt`、`rsi-collect` 报告补充 total/maxTotal/passed。
- 1.1.0：新增提案库与生命周期、`rsi-review`、turn/end 自动反思卡、`rsi-adopt --proposalId` 标记 applied、`rsi-status` 汇总提案/反思；修复 parameters 未经编译导致的非法 JSON Schema。

## 版本

- 1.3.0（A 批修复）：采纳门禁（`rsi-adopt` 必须带 approved 提案、`applied` 只能来自 `approved`、失败回滚）；采纳白名单 fail-closed（拒绝 `..`/绝对路径/符号链接逃逸，排除自身 bundles 等目录）；证据修复（读宿主 `exec.arguments`、只采差评反馈、按会话落库）；评分表完整性（plan 记录 sha256，collect 比对，删除 `rubric` 覆盖参数，`passScore` 校验）；评分语义（空文件/空白文件失败、`file-exists` 校验非空、manual 不进分母、缺 probe 记 0、任一失败即变体未通过）；状态隔离（反思按会话、摘要用已消化清单、坏状态转存告警、证据轮转、原子写 + `.bak`）。
- 1.2.0：新增 `rsi-run`（实验状态机）、`rsi-lesson`（教训库）、turn/end 自动巡检摘要（未消化反思卡 ≥ 3 张时生成 digest 卡）、`rsi-status` 增补 `digests`/`lessonEntries`/`lastDigestAt`、`rsi-collect` 报告补充 total/maxTotal/passed。
- 1.1.0：新增提案库与生命周期、`rsi-review`、turn/end 自动反思卡、`rsi-adopt --proposalId` 标记 applied、`rsi-status` 汇总提案/反思；修复 parameters 未经编译导致的非法 JSON Schema。
