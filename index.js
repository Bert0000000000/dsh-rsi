import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stamp, isoNow, slug, resolveInside, pathExists, writeFileSafe, writeFileAtomic, sha256, realPathOf, readJson, readFileOrNull, listDirNames, listFiles, splitLines, normalizeRel, hasDotDotSegment } from './lib/fsx.js'
import { compileParameters } from './lib/schema.js'
import { EVAL_KINDS, evaluateItem, validateRubric, aggregateVariant } from './lib/rubric.js'
import { redactSecrets, truncateEvidence, safeJson } from './lib/redact.js'
import { HARNESS_COMPONENTS, normalizeEdits, composeHarness } from './lib/compose.js'
import { compareDirs, renderCompareMarkdown } from './lib/compare.js'
import { runRoot, listRuns, readRunIndex, writeRunIndex, upsertRun, runRecord, childrenOf, runMeta, archiveRun, restoreRun, readRunConfig, plannedRepeats, plannedMinPassRate } from './lib/runs.js'
import { scanWrites } from './lib/audit.js'

const name = 'rsi-toolkit'
const inject = ['tools', 'sessions', 'workingDirectory']

function textBlock(text) {
  return { type: 'text', text }
}

const ADOPT_RSI_DENY = ['bundles/', 'evidence/', 'state/', 'proposals/', 'backups/']


/** 白名单 + 归一化 + realpath 三重校验；任何越界一律抛错（fail-closed）。 */
function resolveAllowedAdoptPath(cwd, rel) {
  const r = normalizeRel(rel)
  if (!r) throw new Error('采纳路径为空')
  if (path.isAbsolute(r) || /^[a-zA-Z]:/.test(r)) throw new Error(`采纳路径必须是相对路径：'${rel}'`)
  if (hasDotDotSegment(r)) throw new Error(`采纳路径不得包含 '.' 或 '..' 段：'${rel}'`)
  const allowed = r === 'AGENTS.md'
    || (r.startsWith('.agents/') && r.endsWith('/SKILL.md'))
    || (r.startsWith('.rsi/') && !ADOPT_RSI_DENY.some((deny) => r.startsWith('.rsi/' + deny)))
  if (!allowed) {
    throw new Error(`采纳路径不在白名单内：'${rel}'（仅允许 AGENTS.md、.agents/**/SKILL.md，以及 .rsi/ 下非 bundles|evidence|state|proposals|backups 的路径）`)
  }
  const abs = path.resolve(cwd, r)
  const realBase = realPathOf(cwd)
  const realTarget = realPathOf(abs)
  const inside = realTarget === realBase || realTarget.startsWith(realBase + path.sep)
  if (!inside) throw new Error(`采纳路径经符号链接逃逸出工作区：'${rel}' → '${realTarget}'`)
  return abs
}

function isAllowedAdoptPath(cwd, rel) {
  try {
    resolveAllowedAdoptPath(cwd, rel)
    return true
  } catch {
    return false
  }
}


function planTool() {
  return {
    name: 'rsi-plan',
    description: '创建一轮 RSI Propose 实验：给定统一任务 T 与多个候选 harness 变体（可整份 harness，也可按 8 个组件分解为 edits），落盘任务/评分表/变体与重复执行目录，返回每个 probe 的启动指令。本工具只写文件、不启动子代理。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径；本工具的所有写入只发生在 cwd 内' },
      runId: { type: 'string', description: '实验 id（kebab-case，默认 r<时间戳>）' },
      task: { type: 'string', required: true, description: '统一任务 T 的完整文本（每个 probe 收到的任务文本必须完全一致）' },
      variants: {
        type: 'array',
        required: true,
        description: '候选 harness 变体列表（label 必须唯一）',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '变体名（如 baseline、候选规则 A）' },
            harness: { type: 'string', description: '该变体的 harness 规则全文；与 edits 二选一，edits 优先' },
            edits: {
              type: 'array',
              description: '按组件分解的改动（B3）；给出后 harness 由这些组件合成',
              items: {
                type: 'object',
                properties: {
                  component: { type: 'string', description: '组件：' + HARNESS_COMPONENTS.join(' | ') },
                  change: { type: 'string', description: '该组件的具体改动' },
                },
              },
            },
          },
        },
      },
      rubric: {
        type: 'object',
        description: '评分表（缺省生成单个人工评审项）',
        properties: {
          passScore: { type: 'number', description: '及格分（加权分数，每次重复单独判定）' },
          minPassRate: { type: 'number', description: '变体通过所需的重复通过率（0~1，默认 1）' },
          items: {
            type: 'array',
            description: '评分项',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                kind: { type: 'string', description: 'file-exists | line-count | regex-all-lines | regex-last-line | contains | command | manual' },
                weight: { type: 'number' },
                path: { type: 'string', description: '相对 probe 目录的文件路径' },
                pattern: { type: 'string' },
                min: { type: 'number' },
                max: { type: 'number' },
                note: { type: 'string' },
                run: { type: 'string', description: 'command 类型：在 probe 目录执行的命令（shell）' },
                expectExit: { type: 'number', description: 'command 类型：期望退出码（默认 0）' },
                timeoutMs: { type: 'number', description: 'command 类型：超时毫秒（默认 10000，最大 60000）' },
              },
            },
          },
        },
      },
      repeats: { type: 'number', description: '每个变体重复执行次数（1~9，默认 3；B1 统计判定需要 ≥3）' },
      mode: { type: 'string', enum: ['parallel', 'sequential'], description: 'probe 启动模式（默认 parallel）' },
      budget: { type: 'number', description: '本次实验最多允许的 probe 次数（默认 24；变体数×重复次数不得超出）' },
      minPassRate: { type: 'number', description: '变体通过所需的重复通过率（0~1，默认取 rubric.minPassRate 或 1）' },
      parent: { type: 'string', description: '父代实验 id（B6 血缘）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          runDir: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          repeats: { type: 'number' },
          totalProbes: { type: 'number' },
          instructions: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(`实验 ${value.runId} 已创建（${value.labels.length} 变体 × ${value.repeats} 次 = ${value.totalProbes} 个 probe）。\n${value.instructions}`)],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error(`工作区不存在：${cwd}`)
      const task = String(args.task ?? '').trim()
      if (!task) throw new Error('task 不能为空')
      const variants = Array.isArray(args.variants) && args.variants.length ? args.variants : null
      if (!variants) throw new Error('variants 至少需要一个变体')
      const runId = slug(String(args.runId ?? `r${Date.now()}`))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) throw new Error(`runId 无效：${runId}`)
      const runDir = resolveInside(cwd, path.join('.rsi', 'runs', runId))
      if (pathExists(runDir)) throw new Error(`runId 已存在：${runId}`)
      const repeats = Math.max(1, Math.min(9, Math.floor(Number(args.repeats ?? 3)) || 3))
      const mode = args.mode === 'sequential' ? 'sequential' : 'parallel'
      const totalProbes = variants.length * repeats
      const rawBudget = Number(args.budget)
      const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 24
      if (totalProbes > budget) {
        throw new Error(`预算不足：${variants.length} 个变体 × ${repeats} 次 = ${totalProbes} 次 probe，超过 budget=${budget}（调大 budget 或减少 repeats）`)
      }
      const parent = String(args.parent ?? '').trim()
      if (parent && !pathExists(path.join(runRoot(cwd), parent))) throw new Error(`父代实验不存在：${parent}`)
      const rubric = args.rubric && typeof args.rubric === 'object' && Array.isArray(args.rubric.items)
        ? args.rubric
        : { passScore: null, items: [{ id: 'overall', label: '总体完成度', kind: 'manual', weight: 1, note: '人工评审' }] }
      validateRubric(rubric)
      const rawRate = Number(args.minPassRate ?? rubric.minPassRate ?? 1)
      const minPassRate = Number.isFinite(rawRate) && rawRate > 0 && rawRate <= 1 ? rawRate : 1
      const prepared = []
      const seen = new Set()
      variants.forEach((variant, index) => {
        const label = slug(variant?.label || `v${index + 1}`)
        if (seen.has(label)) throw new Error(`变体 label 重复：${label}`)
        seen.add(label)
        const edits = Array.isArray(variant?.edits) ? normalizeEdits(variant.edits) : []
        prepared.push({ index, label, edits, harnessText: composeHarness({ harness: variant?.harness, edits }) })
      })
      const rubricText = JSON.stringify(rubric, null, 2) + '\n'
      fs.mkdirSync(runDir, { recursive: true })
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'task.md'), `# 任务 T\n\n${task}\n`)
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'rubric.json'), rubricText)
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'config.json'), JSON.stringify({
        cwd,
        runId,
        createdAt: isoNow(),
        variantCount: variants.length,
        repeats,
        minPassRate,
        mode,
        budget,
        totalProbes,
        parent,
        rubricSha256: sha256(rubricText),
        rubricRuleVersion: 3,
        meta: runMeta(cwd),
      }, null, 2) + '\n')
      upsertRun(cwd, {
        runId,
        parent,
        planTs: isoNow(),
        variants: prepared.map((item) => item.label),
        repeats,
        mode,
        budget,
        archived: false,
      })
      const blocks = [`# RSI 实验 ${runId}\n\n运行目录：${runDir}\n\n- 变体：${prepared.length} 个\n- 重复：每个变体 ${repeats} 次（共 ${totalProbes} 个 probe）\n- 模式：${mode}\n- 预算：${budget} 次\n- 父代：${parent || '（无）'}\n`]
      blocks.push(mode === 'parallel'
        ? '启动模式：parallel —— 下面的 probe 可同时启动（各自独立子代理）。'
        : '启动模式：sequential —— 按顺序逐个启动，前一个结束后再启动下一个。')
      prepared.forEach((item) => {
        const num = String(item.index + 1)
        const variantDir = path.join(runDir, 'variants', `${num}-${item.label}`)
        fs.mkdirSync(variantDir, { recursive: true })
        fs.writeFileSync(path.join(variantDir, 'harness.md'), `# 候选 harness：${item.label}\n\n${item.harnessText || '无附加规则（基线）'}\n`, 'utf8')
        if (item.edits.length) {
          fs.writeFileSync(path.join(variantDir, 'edits.json'), JSON.stringify(item.edits, null, 2) + '\n', 'utf8')
        }
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          const probeDir = repeats > 1
            ? path.join(runDir, 'probes', `${num}-${item.label}`, 'r' + repeat)
            : path.join(runDir, 'probes', `${num}-${item.label}`)
          fs.mkdirSync(probeDir, { recursive: true })
          blocks.push([
            `## 变体 ${num}：${item.label} · 第 ${repeat}/${repeats} 次`,
            '',
            '1. 启动一个全新 subagent（不用 fork，不带任何本会话的 harness 建议）。',
            '2. 原样发送任务文本：',
            '',
            '---',
            task,
            '---',
            '3. 单独告知它的 harness 约束：',
            '',
            '---',
            item.harnessText || '无附加规则（基线）',
            '---',
            `4. 要求它：全部产出与最终报告写入 ${probeDir} 目录；除该目录外不得创建或修改任何文件；不读不写 .rsi 之外的任何配置。`,
            '',
          ].join('\n'))
        }
      })
      blocks.push(`\n完成后调用 rsi-collect（cwd=${cwd}，runId=${runId}）汇总评分；需要成对比较时用 rsi-compare。`)
      const instructions = blocks.join('\n')
      return { runId, runDir, labels: prepared.map((item) => item.label), repeats, totalProbes, instructions }
    },
  }
}

function collectTool() {
  return {
    name: 'rsi-collect',
    description: '汇总一轮 RSI 实验：按 rubric.json 对每个变体的每次重复执行（r1..rN）做机器评分，按 passRate/均值判定变体是否通过，生成 report.md/report.json。评分表只能来自实验目录并校验创建时哈希。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      runId: { type: 'string', required: true, description: '实验 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          variants: { type: 'array', items: { type: 'object' } },
          manualItems: { type: 'array', items: { type: 'string' } },
          reportPath: { type: 'string' },
          maxTotal: { type: 'number' },
          total: { type: 'number' },
          passScore: { type: 'number' },
          hasPassScore: { type: 'boolean' },
          passed: { type: 'boolean' },
          repeats: { type: 'number' },
          minPassRate: { type: 'number' },
          rubricHashVerified: { type: 'boolean' },
          failedVariants: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [textBlock(`汇总完成：${value.hasPassScore ? (value.passed ? '全部变体通过' : `未全部通过（${value.failedVariants.join('、') || '无有效变体'}）`) : '待人工评审'}（总分 ${value.total}/${value.maxTotal}，重复 ${value.repeats} 次，要求通过率 ≥ ${value.minPassRate}，评分表哈希${value.rubricHashVerified ? '已校验' : '未校验（旧实验）'}）\n报告：${value.reportPath}`)],
    },
    timeoutMs: 120000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      const runId = String(args.runId ?? '').trim()
      if (!runId) throw new Error('runId 不能为空')
      const runDir = resolveInside(cwd, path.join('.rsi', 'runs', runId))
      if (!pathExists(runDir)) throw new Error(`实验不存在：${runDir}`)
      const rubricPath = path.join(runDir, 'rubric.json')
      const rubricText = readFileOrNull(rubricPath)
      if (rubricText == null) throw new Error('rubric.json 缺失，拒绝汇总')
      let rubric
      try {
        rubric = JSON.parse(rubricText)
      } catch (error) {
        throw new Error(`rubric.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
      validateRubric(rubric)
      const configPath = path.join(runDir, 'config.json')
      let config = {}
      if (pathExists(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        } catch {
          throw new Error(`config.json 解析失败：${configPath}`)
        }
      }
      const rubricSha256 = sha256(rubricText)
      let rubricHashVerified = false
      if (typeof config?.rubricSha256 === 'string' && config.rubricSha256) {
        if (config.rubricSha256 !== rubricSha256) {
          throw new Error(`rubric.json 与创建实验时的哈希不一致（记录 ${config.rubricSha256.slice(0, 12)}…，当前 ${rubricSha256.slice(0, 12)}…），评分表被改动，拒绝汇总`)
        }
        rubricHashVerified = true
      }
      const repeats = plannedRepeats(config)
      const minPassRate = plannedMinPassRate(config)
      const variantDirs = listDirNames(path.join(runDir, 'variants')).sort()
      if (!variantDirs.length) throw new Error('没有任何 variants 目录')
      const hasPassScore = Number.isFinite(rubric.passScore) && rubric.passScore > 0
      const passScore = hasPassScore ? rubric.passScore : 0
      const variants = []
      const manualItems = []
      for (const dirName of variantDirs) {
        const label = dirName.replace(/^\d+-/, '')
        const aggregate = aggregateVariant({
          label,
          dirName,
          probeDir: path.join(runDir, 'probes', dirName),
          plannedRepeats: repeats,
          items: rubric.items,
          passScore,
          hasPassScore,
          minPassRate,
        })
        manualItems.push(...aggregate.manualItems)
        variants.push(aggregate)
      }
      const total = variants.reduce((acc, value) => acc + value.score, 0)
      const maxTotal = variants.reduce((acc, value) => acc + value.max, 0)
      const failedVariants = variants.filter((value) => value.passed !== true).map((value) => value.label)
      const strictRule = '每次重复中任一机器评分项失败即判该次未通过；变体需执行齐全部重复、passRate ≥ 要求且均值 ≥ passScore'
      const passed = hasPassScore && variants.length > 0 && variants.every((value) => value.passed === true)
      const lines = [
        '# RSI 实验汇总',
        '',
        `runId: ${runId}`,
        `重复次数：${repeats}（要求通过率 ≥ ${minPassRate}）`,
        `评分表哈希：${rubricHashVerified ? '已校验 ' : '未校验（旧实验无记录） '}${rubricSha256}`,
        `判定规则：${strictRule}`,
        '',
      ]
      for (const variant of variants) {
        const verdict = variant.passed === true ? ' ✅ 通过' : variant.passed === false ? ' ❌ 未通过' : ''
        lines.push(
          `## ${variant.label} — 均分 ${variant.score}/${variant.max}（通过率 ${variant.passRate}，执行 ${variant.executed}/${variant.repeats}）${verdict}`,
          '',
          '| 次数 | 执行 | 得分 | 未通过项 | 本次判定 |',
          '| --- | --- | --- | --- | --- |',
        )
        for (const row of variant.repeatRows) {
          lines.push(`| 第 ${row.index} 次 | ${row.executed ? '是' : '否'} | ${row.score}/${row.max} | ${row.failed} | ${row.executed ? (row.passed ? '通过' : '未通过') : '未产出'} |`)
        }
        lines.push('', `- 分数：均值 ${variant.mean}、标准差 ${variant.stdev}、逐次 [${variant.scores.join(', ')}]`, '')
        lines.push('| 评分项 | 结果 | 说明 |', '| --- | --- | --- |')
        for (const row of variant.rows) {
          lines.push(`| ${row.label || row.id || '-'} | ${row.ok === true ? '✅' : row.ok === false ? '❌' : '👤 人工'} | ${String(row.detail ?? '').replace(/\|/g, '\\|')} |`)
        }
        lines.push('')
      }
      if (failedVariants.length) lines.push('## 未通过变体', '', ...failedVariants.map((name) => `- ${name}`), '')
      if (manualItems.length) lines.push('## 待人工评审', '', ...manualItems.map((m) => `- ${m}`), '')
      const reportPath = path.join(runDir, 'report.md')
      fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({
        runId,
        passScore,
        hasPassScore,
        repeats,
        minPassRate,
        total,
        maxTotal,
        passed,
        rubricSha256,
        rubricHashVerified,
        failedVariants,
        variants,
        manualItems,
      }, null, 2) + '\n', 'utf8')
      return { runId, variants, manualItems, reportPath, maxTotal, total, passScore, hasPassScore, passed, repeats, minPassRate, rubricHashVerified, failedVariants }
    },
  }
}

/** C1：采纳后的冒烟校验（语法/JSON/非空 + 可选自定义命令），失败即触发回滚。 */
function runAdoptSmoke(cwd, changed, smoke) {
  const details = []
  for (const rel of changed) {
    const abs = path.join(cwd, rel)
    if (/\.(mjs|cjs|js)$/i.test(rel)) {
      const result = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      if (result.error) {
        if (result.error.code === 'ENOENT') {
          details.push(`${rel}: 跳过语法检查（node 不可用）`)
          continue
        }
        throw new Error(`冒烟校验失败：${rel} 无法执行 node --check —— ${result.error.message}`)
      }
      if (result.status !== 0) {
        const message = (String(result.stderr ?? '') + String(result.stdout ?? '')).trim().slice(0, 400)
        throw new Error(`冒烟校验失败：${rel} 语法错误 —— ${message}`)
      }
      details.push(`${rel}: node --check 通过`)
      continue
    }
    if (/\.json$/i.test(rel)) {
      try {
        JSON.parse(fs.readFileSync(abs, 'utf8'))
      } catch (error) {
        throw new Error(`冒烟校验失败：${rel} 不是合法 JSON —— ${error instanceof Error ? error.message : String(error)}`)
      }
      details.push(`${rel}: JSON 解析通过`)
      continue
    }
    const text = readFileOrNull(abs) ?? ''
    if (!text.trim()) throw new Error(`冒烟校验失败：${rel} 内容为空`)
    details.push(`${rel}: 非空检查通过`)
  }
  const command = String(smoke?.command ?? '').trim()
  if (command) {
    const timeoutMs = Math.max(1000, Math.min(120000, Math.floor(Number(smoke?.timeoutMs ?? 30000)) || 30000))
    const result = spawnSync(command, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    if (result.error && result.error.code === 'ETIMEDOUT') throw new Error(`冒烟命令超时（${timeoutMs}ms）：${command}`)
    if (result.error) throw new Error(`冒烟命令无法执行：${command}（${result.error.message}）`)
    if (result.status !== 0) {
      const output = (String(result.stdout ?? '') + String(result.stderr ?? '')).trim().slice(0, 400)
      throw new Error(`冒烟命令失败（退出码 ${result.status}）：${command}${output ? '；输出：' + output : ''}`)
    }
    details.push(`smoke: ${command} → 退出码 0`)
  }
  return details
}

function adoptTool() {
  return {
    name: 'rsi-adopt',
    description: '在证据充分的前提下采纳 harness 改动。workspace 模式只准写 AGENTS.md、.agents/**/SKILL.md、.rsi/**，先备份到 .rsi/backups/<ts>/ 再写，并把决策追加进 .rsi/memory/harness-lessons.md；preset-bundle 模式只把完整 cordis.patch.yml 写入 .rsi/presets/<name>/，返回 plugin_manager 安装指令（由用户人工批准执行）。没有证据的修改会被拒绝。',
    parameters: {
      mode: { type: 'string', required: true, enum: ['workspace', 'preset-bundle'], description: '采纳模式' },
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      evidence: { type: 'string', required: true, description: '证据文本（probe 对比结论；必须非空）' },
      runId: { type: 'string', description: '关联实验 id' },
      label: { type: 'string', description: '本次改动的标签' },
      files: {
        type: 'array',
        description: 'workspace 模式要写入的文件',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的路径（仅限 AGENTS.md、.agents/**/SKILL.md、.rsi/**）' },
            content: { type: 'string' },
          },
        },
      },
      name: { type: 'string', description: 'preset-bundle 模式的 bundle 名（kebab-case）' },
      patch: { type: 'string', description: 'preset-bundle 模式的完整 cordis.patch.yml 内容' },
      rowId: { type: 'string', description: 'preset-bundle 模式 Loader 行 id（如 preset-<id>）' },
      proposalId: { type: 'string', description: '关联提案 ID（采纳成功后自动把该提案标记为 applied）' },
      smoke: {
        type: 'object',
        description: '采纳后冒烟校验（C1）：写入的 .js 用 node --check、.json 解析、其余非空；可选 command 在 cwd 执行，任一失败自动回滚',
        properties: {
          command: { type: 'string', description: '自定义冒烟命令（退出码必须为 0）' },
          timeoutMs: { type: 'number', description: '命令超时毫秒（默认 30000，最大 120000）' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string' },
          changed: { type: 'array', items: { type: 'string' } },
          backupDir: { type: 'string' },
          bundleDir: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note ?? '已采纳。')],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error(`工作区不存在：${cwd}`)
      const evidence = String(args.evidence ?? '').trim()
      if (!evidence) throw new Error('RSI 红线：没有证据的 harness 修改被拒绝')
      const proposal = requireApprovedProposal(cwd, args.proposalId)
      const ts = stamp()
      const tag = String(args.label ?? '').trim() || String(proposal.title ?? '').trim() || String(args.runId ?? '').trim() || proposal.id
      const lessonsRel = path.join('.rsi', 'memory', 'harness-lessons.md')
      const lessonsAbs = path.join(cwd, lessonsRel)
      const lessonsBefore = readFileOrNull(lessonsAbs)
      const appendLesson = (mode, changed) => {
        const existing = lessonsBefore ?? ''
        const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
        const block = `## ${ts} — ${tag}（已采纳，${mode}）\n\n- 证据：${evidence.replace(/\r?\n/g, ' ')}\n- 采纳改动：${changed.join('、') || '（无文件）'}\n`
        writeFileSafe(cwd, lessonsRel, existing + prefix + block + '\n')
      }
      const restoreLessons = () => {
        try {
          if (lessonsBefore == null) {
            if (pathExists(lessonsAbs)) fs.unlinkSync(lessonsAbs)
          } else {
            writeFileSafe(cwd, lessonsRel, lessonsBefore)
          }
        } catch {
          // 教训库回滚尽力而为
        }
      }
      if (args.mode === 'workspace') {
        const files = Array.isArray(args.files) && args.files.length ? args.files : null
        if (!files) throw new Error('files 不能为空（workspace 模式）')
        const backupDir = path.join(cwd, '.rsi', 'backups', ts)
        const changed = []
        const touched = []
        for (const file of files) {
          const rel = normalizeRel(file?.path)
          const abs = resolveAllowedAdoptPath(cwd, rel)
          const existed = pathExists(abs)
          if (existed) {
            const backupAbs = path.join(backupDir, rel)
            fs.mkdirSync(path.dirname(backupAbs), { recursive: true })
            fs.copyFileSync(abs, backupAbs)
          }
          writeFileSafe(cwd, rel, String(file?.content ?? ''))
          changed.push(rel)
          touched.push({ rel, existed })
        }
        const rollback = () => {
          for (const entry of touched) {
            const abs = path.join(cwd, entry.rel)
            const backupAbs = path.join(backupDir, entry.rel)
            try {
              if (entry.existed && pathExists(backupAbs)) fs.copyFileSync(backupAbs, abs)
              else if (!entry.existed && pathExists(abs)) fs.unlinkSync(abs)
            } catch {
              // 回滚尽力而为；备份目录仍保留供人工恢复
            }
          }
          restoreLessons()
        }
        let smokeDetails = []
        try {
          smokeDetails = runAdoptSmoke(cwd, changed, args.smoke)
          appendLesson('workspace', changed)
          markProposalApplied(cwd, proposal.id)
        } catch (error) {
          rollback()
          throw new Error(`采纳未能完成，已回滚文件改动（备份保留在 ${backupDir}）：${error instanceof Error ? error.message : String(error)}`)
        }
        return {
          mode: 'workspace',
          changed,
          backupDir,
          bundleDir: '',
          note: `已采纳 ${changed.length} 个文件改动；冒烟校验 ${smokeDetails.length} 项通过；原文件备份在 ${backupDir}；决策已追加到 .rsi/memory/harness-lessons.md；提案 ${proposal.id} 已标记 applied`,
        }
      }
      const bundleName = slug(String(args.name ?? 'rsi-preset'))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(bundleName)) throw new Error(`bundle 名无效：${bundleName}`)
      const patch = String(args.patch ?? '').trim()
      if (!patch) throw new Error('patch 不能为空（preset-bundle 模式）')
      const bundleDir = path.join(cwd, '.rsi', 'presets', bundleName)
      if (pathExists(bundleDir)) throw new Error(`preset bundle 目录已存在：${bundleDir}`)
      const packageName = `@local/${bundleName}`
      const removeBundle = () => {
        try {
          fs.rmSync(bundleDir, { recursive: true, force: true })
        } catch {
          // bundle 目录清理尽力而为
        }
      }
      writeFileSafe(cwd, path.join('.rsi', 'presets', bundleName, 'package.json'), JSON.stringify({
        name: packageName,
        version: '1.0.0',
        private: true,
        type: 'module',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2) + '\n')
      writeFileSafe(cwd, path.join('.rsi', 'presets', bundleName, 'cordis.patch.yml'), patch + '\n')
      writeFileSafe(cwd, path.join('.rsi', 'presets', bundleName, 'README.md'), `# ${bundleName}\n\n由 rsi-adopt 生成（${ts}，实验 ${args.runId ?? '-'}）。\n\n安装（需人工批准）：plugin_manager action=install_bundle，target=${bundleDir}\n`)
      try {
        appendLesson('preset-bundle', [`.rsi/presets/${bundleName}/`])
        markProposalApplied(cwd, proposal.id)
      } catch (error) {
        removeBundle()
        restoreLessons()
        throw new Error(`采纳未能完成，已删除生成的 bundle：${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        mode: 'preset-bundle',
        changed: [`.rsi/presets/${bundleName}/`],
        backupDir: '',
        bundleDir,
        note: `bundle 已写入 ${bundleDir}（包名 ${packageName}）。下一步（需你人工批准）：plugin_manager action=install_bundle，target=${bundleDir}。安装前请审阅 cordis.patch.yml。提案 ${proposal.id} 已标记 applied。`,
      }
    },
  }
}


function statusTool() {
  return {
    name: 'rsi-status',
    description: '查看 RSI 状态：已有实验、教训条目、备份数、preset bundles。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          runs: { type: 'array', items: { type: 'string' } },
          lessonsPath: { type: 'string' },
          lessonLines: { type: 'number' },
          backupCount: { type: 'number' },
          presets: { type: 'array', items: { type: 'string' } },
          proposals: {
            type: 'object',
            additionalProperties: false,
            properties: {
              draft: { type: 'number' },
              approved: { type: 'number' },
              rejected: { type: 'number' },
              applied: { type: 'number' },
            },
          },
          inbox: { type: 'number' },
          digests: { type: 'number' },
          lessonEntries: { type: 'number' },
          lastReflectionAt: { type: 'string' },
          lastDigestAt: { type: 'string' },
          stateError: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(`runs: ${value.runs.length}、教训 ${value.lessonEntries} 条/${value.lessonLines} 行、备份 ${value.backupCount}、presets ${value.presets.length}、提案 draft ${value.proposals.draft}/approved ${value.proposals.approved}/applied ${value.proposals.applied}、反思卡 ${value.inbox}、巡检摘要 ${value.digests}`)],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      const dir = path.join(cwd, '.rsi')
      const runs = listDirNames(path.join(dir, 'runs')).filter((name) => name !== '_archive')
      const lessonsPath = path.join(dir, 'memory', 'harness-lessons.md')
      const lessonLines = splitLines(readFileOrNull(lessonsPath) ?? '').length
      const backupCount = listDirNames(path.join(dir, 'backups')).length
      const presets = listDirNames(path.join(dir, 'presets'))
      const all = readProposalIndex(cwd).proposals
      const proposals = {}
      for (const status of PROPOSAL_STATUSES) proposals[status] = all.filter((item) => (item && (item.status || 'draft')) === status).length
      const inbox = listFiles(path.join(dir, 'inbox')).filter((name) => name.endsWith('.md')).length
      const digests = listFiles(path.join(dir, 'inbox')).filter((name) => /^digest-.+\.md$/.test(name)).length
      const lessonEntries = lessonBlocks(readFileOrNull(lessonsPath) ?? '').length
      const { state, error: stateError } = readReflectStateSafe(cwd)
      const sessions = state.sessions && typeof state.sessions === 'object' ? Object.values(state.sessions) : []
      const sessionTimes = sessions.map((entry) => String(entry?.lastReflectAt ?? '')).filter(Boolean).sort()
      const lastReflectionAt = sessionTimes.length ? sessionTimes[sessionTimes.length - 1] : String(state.lastReflectAt || '')
      const lastDigestAt = String(state.lastDigestAt || '')
      return { dir, runs, lessonsPath, lessonLines, backupCount, presets, proposals, inbox, digests, lessonEntries, lastReflectionAt, lastDigestAt, stateError }
    },
  }
}

// ---- Tier 3：自动失败证据收集 ----

const EVIDENCE_MAX_LINES = 200
const EVIDENCE_MAX_BYTES = 200 * 1024
const EVIDENCE_TRUNCATE = 500


function sessionIdOf(value) {
  if (!value) return null
  if (typeof value === 'string') return value.trim() || null
  return value.id ?? value.sessionId ?? value.session?.id ?? value.agent?.session?.id ?? null
}

const EVIDENCE_ARG_KEYS = ['cwd', 'runId', 'action', 'proposalId', 'mode', 'path', 'query', 'url', 'command', 'pattern', 'label']

/** 只保留白名单键，每值截断 200 字符，避免把整份文件写进证据。 */
function pickArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const keys = Object.keys(value)
  const ordered = [...keys.filter((key) => EVIDENCE_ARG_KEYS.includes(key)), ...keys.filter((key) => !EVIDENCE_ARG_KEYS.includes(key))]
  const out = {}
  for (const key of ordered.slice(0, 8)) {
    const raw = value[key]
    const text = typeof raw === 'string' ? raw : safeJson(raw)
    out[key] = redactSecrets(text.length > 200 ? text.slice(0, 200) + '…' : text)
  }
  return out
}

function evidenceCwd(ctx, sessionId) {
  try {
    const session = ctx.sessions.get(sessionId)
    if (!session) return null
    return ctx.workingDirectory.get(session) || null
  } catch {
    return null
  }
}

/** 超过行数/字节上限时转存为 .1.jsonl，保留最近一半记录（A6）。 */
function rotateEvidence(file) {
  try {
    const text = readFileOrNull(file) ?? ''
    const lines = splitLines(text)
    if (lines.length <= EVIDENCE_MAX_LINES && Buffer.byteLength(text, 'utf8') <= EVIDENCE_MAX_BYTES) return
    fs.copyFileSync(file, file.replace(/\.jsonl$/, '.1.jsonl'))
    const keep = lines.slice(-Math.floor(EVIDENCE_MAX_LINES / 2))
    fs.writeFileSync(file, keep.join('\n') + '\n', 'utf8')
  } catch {
    // 轮转失败时保留原文件，不影响主流程
  }
}

function appendEvidence(ctx, sessionId, record) {
  const cwd = evidenceCwd(ctx, sessionId)
  if (!cwd) return
  try {
    const dir = path.join(cwd, '.rsi', 'evidence')
    fs.mkdirSync(dir, { recursive: true })
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
    const file = path.join(dir, `${safe}.jsonl`)
    fs.appendFileSync(file, JSON.stringify(Object.assign({ session: sessionId }, record)) + '\n', 'utf8')
    rotateEvidence(file)
  } catch {
    // 证据收集失败不影响任务执行
  }
}

// ---- Tier 3：提案库与自动反思闭环 ----

const PROPOSAL_STATUSES = ['draft', 'approved', 'rejected', 'applied']
const REFLECT_THRESHOLD = 3
const REFLECT_MIN_GAP_MS = 5 * 60 * 1000


function proposalIndexPath(cwd) {
  return path.join(cwd, '.rsi', 'proposals', 'index.json')
}

/** 严格读：坏 JSON 直接抛错，绝不静默清空提案库。 */
function readProposalIndexStrict(cwd) {
  const file = proposalIndexPath(cwd)
  if (!pathExists(file)) return { proposals: [] }
  const text = fs.readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`提案索引损坏（${file}）：${error instanceof Error ? error.message : String(error)}；原文件已保留，请人工修复或删除后重建`)
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.proposals)) {
    throw new Error(`提案索引结构非法（${file}）：缺少 proposals 数组`)
  }
  return raw
}

function readProposalIndex(cwd) {
  return readProposalIndexStrict(cwd)
}

function writeProposalIndex(cwd, index) {
  const rel = path.join('.rsi', 'proposals', 'index.json')
  const abs = path.join(cwd, rel)
  if (pathExists(abs)) {
    try {
      fs.copyFileSync(abs, abs + '.bak')
    } catch {
      // .bak 只是兜底，失败不阻塞写入
    }
  }
  writeFileAtomic(cwd, rel, JSON.stringify(index, null, 2) + '\n')
}

function upsertProposal(cwd, entry) {
  const index = readProposalIndex(cwd)
  const at = index.proposals.findIndex((item) => item && item.id === entry.id)
  if (at >= 0) index.proposals[at] = Object.assign({}, index.proposals[at], entry)
  else index.proposals.push(entry)
  writeProposalIndex(cwd, index)
  return index
}

function findProposal(cwd, id) {
  const key = String(id ?? '').trim()
  if (!key) return null
  const index = readProposalIndexStrict(cwd)
  return index.proposals.find((item) => item && item.id === key) ?? null
}

function requireApprovedProposal(cwd, proposalId) {
  const id = String(proposalId ?? '').trim()
  if (!id) throw new Error('RSI 红线：rsi-adopt 必须提供 proposalId，且该提案必须已通过 rsi-review approve')
  const proposal = findProposal(cwd, id)
  if (!proposal) throw new Error(`提案不存在：${id}（先用 rsi-propose 创建）`)
  if (proposal.status !== 'approved') {
    throw new Error(`提案 ${id} 当前状态为 ${proposal.status ?? 'unknown'}，只有 approved 才能采纳（先执行 rsi-review action=approve）`)
  }
  return proposal
}

const PROPOSAL_TRANSITIONS = {
  draft: ['approved', 'rejected'],
  approved: ['applied', 'rejected'],
  rejected: ['draft'],
  applied: [],
}

function assertProposalTransition(from, to) {
  const allowed = PROPOSAL_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(`提案状态不允许从 ${from} 变为 ${to}（允许：${allowed.length ? allowed.join('、') : '无'}）`)
  }
}

function annotateProposalFile(cwd, proposal, status, note) {
  const fallback = path.join('.rsi', 'proposals', proposal.id + '.md')
  const rel = normalizeRel(proposal.file || fallback)
  if (rel.split('/').includes('..') || !rel.startsWith('.rsi/proposals/')) {
    throw new Error(`提案文件路径非法：${rel}（必须位于 .rsi/proposals/ 下）`)
  }
  const text = readFileOrNull(path.join(cwd, rel))
  if (text == null) return
  const replaced = /^- 状态：.*$/m.test(text)
    ? text.replace(/^- 状态：.*$/m, '- 状态：' + status + '（' + isoNow() + '）')
    : text + `\n- 状态：${status}（${isoNow()}）\n`
  writeFileSafe(cwd, rel, note ? replaced + '\n> 审核备注：' + note + '\n' : replaced)
}

function setProposalStatus(cwd, id, status, note) {
  if (!PROPOSAL_STATUSES.includes(status)) throw new Error('未知提案状态：' + status)
  const index = readProposalIndexStrict(cwd)
  const target = index.proposals.find((item) => item && item.id === id)
  if (!target) throw new Error('提案不存在：' + id)
  const from = target.status ?? 'draft'
  assertProposalTransition(from, status)
  const previous = { status: from, updatedAt: target.updatedAt, reviewNote: target.reviewNote }
  target.status = status
  target.updatedAt = isoNow()
  if (note) target.reviewNote = note
  writeProposalIndex(cwd, index)
  try {
    annotateProposalFile(cwd, target, status, note)
  } catch (error) {
    target.status = previous.status
    target.updatedAt = previous.updatedAt
    if (previous.reviewNote == null) delete target.reviewNote
    else target.reviewNote = previous.reviewNote
    try {
      writeProposalIndex(cwd, index)
    } catch {
      // 回滚状态写入失败时保留原始异常
    }
    throw error
  }
  return target
}

function markProposalApplied(cwd, proposalId) {
  const id = String(proposalId ?? '').trim()
  if (!id) throw new Error('markProposalApplied 需要提案 id')
  const target = setProposalStatus(cwd, id, 'applied', 'rsi-adopt 已执行')
  return target.file || path.join('.rsi', 'proposals', id + '.md')
}

function evidenceRecords(cwd) {
  const dir = path.join(cwd, '.rsi', 'evidence')
  const out = []
  for (const file of listFiles(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const text = readFileOrNull(path.join(dir, file)) || ''
    for (const line of splitLines(text)) {
      let rec = null
      try {
        rec = JSON.parse(line)
      } catch {
        rec = null
      }
      if (!rec || typeof rec !== 'object' || typeof rec.ts !== 'string') continue
      out.push(Object.assign({ file }, rec))
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  return out
}

function reflectStatePath(cwd) {
  return path.join(cwd, '.rsi', 'state', 'reflection.json')
}

/** 状态文件损坏时转存 .corrupt-<stamp>.json 并抛错，不再静默当空对象。 */
function readReflectState(cwd) {
  const file = reflectStatePath(cwd)
  if (!pathExists(file)) return {}
  const text = fs.readFileSync(file, 'utf8')
  let state
  try {
    state = JSON.parse(text)
  } catch (error) {
    const saved = file.replace(/\.json$/, '') + '.corrupt-' + stamp() + '.json'
    try {
      fs.renameSync(file, saved)
    } catch {
      // 转存失败时保留原文件
    }
    throw new Error(`反思状态文件损坏（${file}）：${error instanceof Error ? error.message : String(error)}；已转存为 ${saved}`)
  }
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {}
}

function readReflectStateSafe(cwd) {
  try {
    return { state: readReflectState(cwd), error: '' }
  } catch (error) {
    return { state: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

function sessionReflectState(state, sessionId) {
  const sessions = state && typeof state.sessions === 'object' && state.sessions ? state.sessions : {}
  const entry = sessions[String(sessionId)]
  return entry && typeof entry === 'object' ? entry : {}
}

function writeReflectState(cwd, state) {
  writeFileAtomic(cwd, path.join('.rsi', 'state', 'reflection.json'), JSON.stringify(state, null, 2) + '\n')
}

function summarizeRecords(records) {
  const bySource = {}
  const byTool = {}
  for (const rec of records) {
    const source = String(rec.source || 'unknown')
    bySource[source] = (bySource[source] || 0) + 1
    if (rec.tool) byTool[String(rec.tool)] = (byTool[String(rec.tool)] || 0) + 1
  }
  return { bySource, byTool }
}

function renderReflectCard(cwd, records, state, sessionId) {
  const ts = stamp()
  const { bySource, byTool } = summarizeRecords(records)
  const sourceText = Object.entries(bySource).map(([key, value]) => key + '×' + value).join('、') || '（无）'
  const toolText = Object.entries(byTool).map(([key, value]) => key + '×' + value).join('、') || '（无）'
  const recent = records.slice(-10).map((rec) => '- [' + rec.ts + '] ' + rec.source + (rec.tool ? ' / ' + rec.tool : '') + '：' + truncateEvidence(rec.error || rec.feedback || rec.args || rec.message || ''))
  const lines = [
    '# 反思任务卡（' + ts + '）',
    '',
    '- 工作区：' + cwd,
    '- 会话：' + String(sessionId),
    '- 触发：新增 ' + records.length + ' 条失败证据（阈值 ' + REFLECT_THRESHOLD + ' 条）',
    '- 上次反思：' + (state.lastReflectAt || '（无）'),
    '- 证据来源：' + sourceText,
    '- 涉及工具：' + toolText,
    '',
    '## 最近证据',
    '',
    ...(recent.length ? recent : ['- （无）']),
    '',
    '## 下一步',
    '',
    '1. 用 rsi-evidence（file 参数）确认失败模式是否重复；',
    '2. 用 rsi-propose 起草提案（basedOnEvidence 必填）；',
    '3. 用 rsi-review approve 审核，再由 rsi-adopt 执行。',
    '',
  ]
  const rel = path.join('.rsi', 'inbox', 'reflect-' + ts + '.md')
  writeFileSafe(cwd, rel, lines.join('\n'))
  return path.join(cwd, rel)
}

function maybeReflect(ctx, sessionId) {
  try {
    const cwd = evidenceCwd(ctx, sessionId)
    if (!cwd) return
    maybeDigest(cwd)
    const { state } = readReflectStateSafe(cwd)
    const entry = sessionReflectState(state, sessionId)
    const lastAt = typeof entry.lastReflectAt === 'string' ? entry.lastReflectAt : ''
    const lastMs = lastAt ? Date.parse(lastAt) : NaN
    if (Number.isFinite(lastMs) && Date.now() - lastMs < REFLECT_MIN_GAP_MS) return
    const mine = evidenceRecords(cwd).filter((rec) => String(rec.session ?? '') === String(sessionId))
    const fresh = lastAt ? mine.filter((rec) => String(rec.ts) > lastAt) : mine
    if (fresh.length < REFLECT_THRESHOLD) return
    const cardPath = renderReflectCard(cwd, fresh, entry, sessionId)
    const rel = path.relative(cwd, cardPath).replace(/\\/g, '/')
    const sessions = Object.assign({}, state.sessions && typeof state.sessions === 'object' ? state.sessions : {})
    sessions[String(sessionId)] = {
      lastReflectAt: isoNow(),
      lastEvidenceCount: mine.length,
      lastCard: rel,
    }
    writeReflectState(cwd, Object.assign({}, state, { sessions, lastReflectAt: isoNow(), lastSession: String(sessionId) }))
  } catch {
    // 反思触发失败不影响任务执行
  }
}

function reviewTool() {
  return {
    name: 'rsi-review',
    description: '审核 RSI 提案：列出提案库（.rsi/proposals/index.json）与状态，approve/reject 单个提案。只有 approved 的提案才应由 rsi-adopt 执行；本工具不改动任何 harness 文件。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      action: { type: 'string', required: true, enum: ['list', 'approve', 'reject'], description: '操作' },
      proposalId: { type: 'string', description: '提案 ID（approve/reject 必填）' },
      note: { type: 'string', description: '审核备注（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          action: { type: 'string' },
          proposals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                ts: { type: 'string' },
                file: { type: 'string' },
              },
            },
          },
          updated: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note)],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error('工作区不存在：' + cwd)
      const action = String(args.action ?? 'list')
      const dir = path.join(cwd, '.rsi', 'proposals')
      if (action === 'list') {
        const proposals = readProposalIndex(cwd).proposals.map((item) => ({
          id: String(item.id || ''),
          title: String(item.title || ''),
          status: String(item.status || 'draft'),
          ts: String(item.ts || ''),
          file: String(item.file || ''),
        }))
        const counts = {}
        for (const item of proposals) counts[item.status] = (counts[item.status] || 0) + 1
        const summary = Object.entries(counts).map(([key, value]) => key + '×' + value).join('、')
        return { dir, action, proposals, updated: '', note: proposals.length ? '共 ' + proposals.length + ' 个提案：' + summary : '提案库为空：先用 rsi-propose 起草。' }
      }
      const id = String(args.proposalId ?? '').trim()
      if (!id) throw new Error('approve/reject 需要 proposalId')
      const status = action === 'approve' ? 'approved' : 'rejected'
      const target = setProposalStatus(cwd, id, status, String(args.note ?? ''))
      return {
        dir,
        action,
        proposals: [],
        updated: String(target.id),
        note: '提案 ' + id + ' 已标记为 ' + status + '。' + (status === 'approved' ? '下一步：rsi-adopt（带 proposalId）执行改动。' : '该提案不会被执行。'),
      }
    },
  }
}
function evidenceTool() {
  return {
    name: 'rsi-evidence',
    description: '列出或读取自动收集的 RSI 失败证据（工具执行失败、负向反馈、agent 错误会自动写入 <cwd>/.rsi/evidence/*.jsonl）。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      file: { type: 'string', description: '指定证据文件名（省略则列出所有文件及行数）' },
      limit: { type: 'number', description: '读取最近多少条记录（默认 20，最多 100）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          files: { type: 'array', items: { type: 'object' } },
          records: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(`证据文件 ${value.files.length} 个${value.records.length ? `，已读取最近 ${value.records.length} 条` : ''}\n${value.note ?? ''}`)],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      const dir = path.join(cwd, '.rsi', 'evidence')
      const wanted = String(args.file ?? '').trim()
      const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20) || 20))
      if (wanted) {
        const abs = resolveInside(dir, wanted)
        const lines = splitLines(readFileOrNull(abs) ?? '')
        const records = lines.slice(-limit).map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { raw: truncateEvidence(line) }
          }
        })
        return { dir, files: [{ file: wanted, lines: lines.length }], records, note: records.length ? '' : '无证据记录' }
      }
      const files = listFiles(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ file: f, lines: splitLines(readFileOrNull(path.join(dir, f)) ?? '').length }))
      return { dir, files, records: [], note: files.length ? '用 file 参数读取具体文件' : '暂无证据（工具执行失败后会自动收集）' }
    },
  }
}

function proposeTool() {
  return {
    name: 'rsi-propose',
    description: '基于证据起草 harness 改进提案并写入 <cwd>/.rsi/proposals/<ts>-<slug>.md。basedOnEvidence 必须非空（RSI 红线）。本工具只写提案文件；采纳须经用户批准后调用 rsi-adopt。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      title: { type: 'string', required: true, description: '提案标题' },
      hypothesis: { type: 'string', required: true, description: '改进假设（要解决的失败模式）' },
      changes: {
        type: 'array',
        required: true,
        description: '拟改动列表',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '目标文件相对路径' },
            description: { type: 'string', description: '改动描述' },
            before: { type: 'string', description: '现状摘录' },
            after: { type: 'string', description: '拟改为' },
          },
        },
      },
      basedOnEvidence: { type: 'string', required: true, description: '证据引用（证据文件与记录摘要；必须非空）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposalPath: { type: 'string' },
          proposalId: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(`${value.note}\n提案：${value.proposalPath}`)],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error(`工作区不存在：${cwd}`)
      const evidence = String(args.basedOnEvidence ?? '').trim()
      if (!evidence) throw new Error('RSI 红线：没有证据的提案被拒绝')
      const title = String(args.title ?? '').trim()
      const hypothesis = String(args.hypothesis ?? '').trim()
      const changes = Array.isArray(args.changes) && args.changes.length ? args.changes : null
      if (!title || !hypothesis || !changes) throw new Error('title/hypothesis/changes 均不能为空')
      const ts = stamp()
      const proposalId = `${ts}-${slug(title)}`
      const lines = [
        `# 提案：${title}`,
        '',
        `- 提案 ID：${proposalId}`,
        `- 创建时间：${ts}`,
        `- 状态：待审核`,
        '',
        '## 假设',
        '',
        hypothesis,
        '',
        '## 证据依据',
        '',
        evidence,
        '',
        '## 拟改动',
        '',
        ...changes.map((c, i) => `### ${i + 1}. ${String(c?.file ?? '(未指明文件)')}\n\n- 描述：${String(c?.description ?? '')}\n- 现状：${String(c?.before ?? '')}\n- 拟改为：${String(c?.after ?? '')}\n`),
        '## 采纳方式',
        '',
        '由用户审核批准后，调用 rsi-adopt（workspace 或 preset-bundle 模式）执行。',
        '',
      ]
      const relPath = path.join('.rsi', 'proposals', `${proposalId}.md`)
      writeFileSafe(cwd, relPath, lines.join('\n'))
      upsertProposal(cwd, {
        id: proposalId,
        ts,
        createdAt: isoNow(),
        title,
        hypothesis,
        status: 'draft',
        evidence,
        changes: changes.map((change) => ({ file: String(change?.file ?? ''), description: String(change?.description ?? '') })),
        file: relPath.replace(/\\/g, '/'),
      })
      return { proposalPath: path.join(cwd, relPath), proposalId, note: '提案已写入并登记到 .rsi/proposals/index.json（状态 draft）：approve 用 rsi-review，执行用 rsi-adopt。' }
    },
  }
}

// ---- Tier 4：实验状态机、教训库与自动巡检 ----

const DIGEST_THRESHOLD = 3
const DIGEST_WINDOW = 200

function probeStateOf(dir) {
  const files = listFiles(dir)
  if (!files.length) return { status: 'empty', files }
  const hasResult = files.some((name) => name === 'result.txt' || name === 'report.md' || name.endsWith('/result.txt') || name.endsWith('/report.md'))
  return { status: hasResult ? 'done' : 'partial', files }
}

/** 每次重复执行的产出状态（r1..rN）；旧布局没有 r<k> 时按单次处理。 */
function repeatProgress(dir, repeats) {
  const nested = listDirNames(dir).filter((name) => /^r\d+$/.test(name))
  if (!nested.length) {
    const legacy = probeStateOf(dir)
    return [{ repeat: 1, status: legacy.status, files: legacy.files.length }]
  }
  const out = []
  for (let index = 1; index <= repeats; index += 1) {
    const files = listFiles(path.join(dir, 'r' + index))
    out.push({ repeat: index, status: files.length ? 'done' : 'empty', files: files.length })
  }
  return out
}

function summarizeRun(cwd, runId) {
  const dir = path.join(runRoot(cwd), runId)
  const config = readRunConfig(cwd, runId)
  const repeats = plannedRepeats(config)
  const record = runRecord(cwd, runId) || {}
  const variants = listDirNames(path.join(dir, 'variants'))
  const probes = listDirNames(path.join(dir, 'probes')).map((variant) => {
    const progress = repeatProgress(path.join(dir, 'probes', variant), repeats)
    return {
      variant,
      repeats: progress,
      done: progress.filter((item) => item.status === 'done').length,
      total: progress.length,
    }
  })
  const reportPath = path.join(dir, 'report.json')
  let score = null
  let maxTotal = null
  let verdict = ''
  if (pathExists(reportPath)) {
    try {
      const report = readJson(reportPath) || {}
      if (Number.isFinite(report.total)) score = report.total
      if (Number.isFinite(report.maxTotal)) maxTotal = report.maxTotal
      if (report.hasPassScore === true) {
        verdict = report.passed === true ? '通过' : '未通过'
      } else if (Array.isArray(report.variants) && report.variants.length) {
        const decided = report.variants.filter((item) => item && item.passed != null)
        verdict = decided.length
          ? (decided.some((item) => item.passed === true) ? '通过' : '未通过')
          : '待人工评审'
      }
      if (score == null && Array.isArray(report.variants)) {
        score = report.variants.reduce((acc, item) => acc + (Number(item?.score) || 0), 0)
        maxTotal = report.variants.reduce((acc, item) => acc + (Number(item?.max) || 0), 0)
      }
    } catch {
      score = null
    }
  }
  const done = probes.reduce((acc, probe) => acc + probe.done, 0)
  const totalProbes = probes.reduce((acc, probe) => acc + probe.total, 0)
  return {
    dir,
    config,
    repeats,
    mode: String(config.mode ?? 'parallel'),
    budget: Number.isFinite(Number(config.budget)) ? Number(config.budget) : 0,
    parent: String(record.parent ?? config.parent ?? ''),
    archived: record.archived === true,
    meta: config.meta && typeof config.meta === 'object' ? config.meta : {},
    variants,
    probes,
    done,
    totalProbes,
    hasReport: pathExists(reportPath),
    score,
    maxTotal,
    verdict,
    children: childrenOf(cwd, runId),
  }
}

function stripHeading(text) {
  return String(text ?? '').replace(/^#[^\n]*\n+/, '').trim()
}

function probeLaunch(cwd, runId, variant, repeat, repeats) {
  const dir = path.join(runRoot(cwd), runId)
  const task = stripHeading(readFileOrNull(path.join(dir, 'task.md')) ?? '')
  const harness = stripHeading(readFileOrNull(path.join(dir, 'variants', variant, 'harness.md')) ?? '') || '无附加规则（基线）'
  const probeDir = repeats > 1 ? path.join(dir, 'probes', variant, 'r' + repeat) : path.join(dir, 'probes', variant)
  return [
    '## 待补跑：' + variant + (repeats > 1 ? '（第 ' + repeat + '/' + repeats + ' 次）' : ''),
    '',
    '1. 启动一个全新 subagent（不用 fork，不带本会话的 harness 建议）。',
    '2. 原样发送任务文本：',
    '',
    '---',
    task,
    '---',
    '3. 单独告知它的 harness 约束：',
    '',
    '---',
    harness,
    '---',
    '4. 要求它：全部产出与最终报告写入 ' + probeDir + ' 目录；除该目录外不得创建或修改任何文件。',
  ].join('\n')
}

function runTool() {
  return {
    name: 'rsi-run',
    description: 'RSI 实验状态机：扫描 <cwd>/.rsi/runs 下每个变体与重复执行（r1..rN）的产出，报告进度、预算、模式、父代血缘与评分状态，并给出补跑指令。只读，不启动子代理。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      runId: { type: 'string', description: '实验 id（省略则汇总全部实验）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          runId: { type: 'string' },
          runs: { type: 'array', items: { type: 'object' } },
          probes: { type: 'array', items: { type: 'object' } },
          instructions: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note + (value.instructions ? '\n\n' + value.instructions : ''))],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error('工作区不存在：' + cwd)
      const root = runRoot(cwd)
      const rawRun = String(args.runId ?? '').trim()
      const wanted = rawRun ? slug(rawRun) : ''
      const ids = wanted ? listRuns(cwd).filter((id) => id === wanted || id.includes(wanted)) : listRuns(cwd)
      if (!ids.length) {
        return { dir: root, runId: wanted, runs: [], probes: [], instructions: '', note: wanted ? '未找到实验：' + wanted : '还没有实验：先用 rsi-plan 创建一轮 Propose 实验。' }
      }
      const runs = ids.map((id) => {
        const summary = summarizeRun(cwd, id)
        return {
          runId: id,
          variantCount: summary.variants.length,
          probeCount: summary.totalProbes,
          done: summary.done,
          repeats: summary.repeats,
          mode: summary.mode,
          budget: summary.budget,
          parent: summary.parent,
          children: summary.children,
          archived: summary.archived,
          missing: summary.probes.filter((probe) => probe.done < probe.total).map((probe) => probe.variant),
          hasReport: summary.hasReport,
          score: summary.score,
          maxTotal: summary.maxTotal,
          verdict: summary.verdict,
        }
      })
      const detail = wanted && runs.length === 1 ? summarizeRun(cwd, runs[0].runId) : null
      const pending = detail
        ? detail.probes.flatMap((probe) => probe.repeats
          .filter((item) => item.status !== 'done')
          .map((item) => ({ variant: probe.variant, repeat: item.repeat })))
        : []
      const instructions = detail
        ? pending.map((item) => probeLaunch(cwd, runs[0].runId, item.variant, item.repeat, detail.repeats)).join('\n\n')
        : ''
      const lines = runs.map((run) => {
        const score = run.hasReport ? '已评分 ' + (run.score ?? '?') + '/' + (run.maxTotal ?? '?') + (run.verdict ? '（' + run.verdict + '）' : '') : '未评分'
        const extras = [
          '重复 ' + run.repeats + ' 次',
          '模式 ' + run.mode,
          run.budget ? '预算 ' + run.budget : '',
          run.parent ? '父代 ' + run.parent : '',
          run.archived ? '已归档' : '',
        ].filter(Boolean).join('、')
        return '- ' + run.runId + '：变体 ' + run.variantCount + '、probe ' + run.done + '/' + run.probeCount + ' 完成（' + extras + '），' + score + (run.missing.length ? '，待补跑 ' + run.missing.join('、') : '')
      })
      const note = [
        '实验状态（' + ids.length + ' 个）：',
        ...lines,
        detail
          ? '\n下一步：' + (pending.length
            ? '补跑 ' + pending.length + ' 个 probe（指令见下）'
            : detail.hasReport
              ? '已有评分报告，可用 rsi-compare 做对比式探测，或用 rsi-adopt（带 proposalId）采纳改动'
              : '全部 probe 已产出，执行 rsi-collect 汇总评分')
          : '\n指定 runId 可查看单个实验的 probe 明细与补跑指令。',
      ].join('\n')
      return { dir: root, runId: detail ? runs[0].runId : wanted, runs, probes: detail ? detail.probes : [], instructions, note }
    },
  }
}

function resolveVariantDir(runDir, wanted) {
  const names = listDirNames(path.join(runDir, 'variants'))
  const key = slug(wanted)
  const found = names.find((name) => name === wanted)
    ?? names.find((name) => slug(name.replace(/^\d+-/, '')) === key)
  if (!found) throw new Error(`变体不存在：${wanted}（可选：${names.join('、')}）`)
  return found
}

function variantProbeDir(runDir, variantDir, repeat, repeats) {
  const base = path.join(runDir, 'probes', variantDir)
  if (repeats > 1) return path.join(base, 'r' + repeat)
  const nested = listDirNames(base).filter((name) => /^r\d+$/.test(name))
  return nested.length ? path.join(base, 'r' + repeat) : base
}

function compareTool() {
  return {
    name: 'rsi-compare',
    description: '对比式探测（B2）：把两个变体同一任务的产出做逐文件差异对比，写出 compare.md/json，并可回写裁判结论（winner=a|b|tie）。不需要预先定义 ground truth，用于「哪个 harness 行为更好」的成对比较。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      runId: { type: 'string', required: true, description: '实验 id' },
      a: { type: 'string', required: true, description: '变体 A（label 或目录名）' },
      b: { type: 'string', required: true, description: '变体 B（label 或目录名）' },
      repeat: { type: 'number', description: '第几次重复对比（默认 1）' },
      judge: {
        type: 'object',
        description: '裁判结论（可选）：由裁判子代理给出后回写',
        properties: {
          winner: { type: 'string', enum: ['a', 'b', 'tie'], description: '胜者' },
          reason: { type: 'string', description: '理由' },
          confidence: { type: 'number', description: '置信度 0~1' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          a: { type: 'string' },
          b: { type: 'string' },
          repeat: { type: 'number' },
          summary: { type: 'object' },
          comparePath: { type: 'string' },
          judge: { type: 'object' },
          instructions: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note + (value.instructions ? '\n\n' + value.instructions : ''))],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      const runId = slug(String(args.runId ?? ''))
      if (!pathExists(path.join(runRoot(cwd), runId))) throw new Error('实验不存在：' + runId)
      const runDir = path.join(runRoot(cwd), runId)
      const config = readRunConfig(cwd, runId)
      const repeats = plannedRepeats(config)
      const repeat = Math.max(1, Math.min(repeats, Math.floor(Number(args.repeat ?? 1)) || 1))
      const dirA = resolveVariantDir(runDir, String(args.a ?? ''))
      const dirB = resolveVariantDir(runDir, String(args.b ?? ''))
      if (dirA === dirB) throw new Error('a 与 b 不能是同一个变体')
      const probeA = variantProbeDir(runDir, dirA, repeat, repeats)
      const probeB = variantProbeDir(runDir, dirB, repeat, repeats)
      const result = compareDirs(probeA, probeB)
      const labelA = dirA.replace(/^\d+-/, '')
      const labelB = dirB.replace(/^\d+-/, '')
      const title = `对比式探测：${labelA} vs ${labelB}（第 ${repeat} 次）`
      const rel = path.join('.rsi', 'runs', runId, 'compare', `${slug(labelA)}__vs__${slug(labelB)}`, 'r' + repeat)
      writeFileSafe(cwd, path.join(rel, 'compare.md'), renderCompareMarkdown(title, probeA, probeB, result) + '\n')
      let judge = null
      if (args.judge && typeof args.judge === 'object') {
        const winner = String(args.judge.winner ?? '').toLowerCase()
        if (!['a', 'b', 'tie'].includes(winner)) throw new Error(`judge.winner 必须是 a|b|tie，收到：${args.judge.winner}`)
        const confidence = Number(args.judge.confidence)
        judge = {
          winner,
          reason: String(args.judge.reason ?? ''),
          confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
          recordedAt: isoNow(),
        }
      }
      const payload = { runId, a: labelA, b: labelB, repeat, summary: result.summary, files: result.files, judge }
      writeFileSafe(cwd, path.join(rel, 'compare.json'), JSON.stringify(payload, null, 2) + '\n')
      const instructions = judge
        ? ''
        : [
          '## 下一步：启动裁判子代理（全新 subagent）',
          '',
          '1. 发给它任务文本（runId ' + runId + ' 的 task.md）与两个变体的 harness；',
          '2. 让它分别读 ' + probeA + ' 与 ' + probeB + ' 的产出；',
          '3. 要求只返回 JSON：{"winner":"a|b|tie","reason":"...","confidence":0.0~1.0}；',
          '4. 把该 JSON 作为 judge 参数再次调用 rsi-compare 回写结论。',
        ].join('\n')
      const diffText = `仅 A ${result.summary.onlyA}、仅 B ${result.summary.onlyB}、改动 ${result.summary.changed}、相同 ${result.summary.same}`
      return {
        runId,
        a: labelA,
        b: labelB,
        repeat,
        summary: result.summary,
        comparePath: path.join(cwd, rel, 'compare.md'),
        judge,
        instructions,
        note: '对比完成（' + diffText + '）' + (judge ? '；裁判结论：' + judge.winner + '（已回写）' : '；等待裁判子代理结论') + '\n报告：' + path.join(cwd, rel, 'compare.md'),
      }
    },
  }
}

function archiveTool() {
  return {
    name: 'rsi-archive',
    description: '归档 RSI 实验（B6）：把 .rsi/runs/<runId> 移到 .rsi/runs/_archive/<时间戳>-<runId> 并在索引里标记；也支持恢复与列出归档。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      action: { type: 'string', required: true, enum: ['archive', 'restore', 'list'], description: '操作' },
      runId: { type: 'string', description: '实验 id（archive/restore 必填）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          runId: { type: 'string' },
          path: { type: 'string' },
          runs: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note)],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error('工作区不存在：' + cwd)
      const action = String(args.action ?? 'list')
      const rawRun = slug(String(args.runId ?? ''))
      if (action === 'list') {
        const index = readRunIndex(cwd)
        const runs = index.runs.map((item) => ({
          runId: String(item.runId ?? ''),
          parent: String(item.parent ?? ''),
          archived: item.archived === true,
          archivePath: String(item.archivePath ?? ''),
          planTs: String(item.planTs ?? ''),
        }))
        const archived = runs.filter((item) => item.archived).length
        return { action, runId: '', path: '', runs, note: `索引中共 ${runs.length} 个实验，已归档 ${archived} 个。` }
      }
      if (!rawRun) throw new Error('archive/restore 需要 runId')
      if (action === 'archive') {
        const result = archiveRun(cwd, rawRun)
        return { action, runId: rawRun, path: result.to, runs: [], note: `实验 ${rawRun} 已归档到 ${result.rel}（仍在 .rsi 内，可 restore）。` }
      }
      if (action === 'restore') {
        const result = restoreRun(cwd, rawRun)
        return { action, runId: rawRun, path: result.to, runs: [], note: `实验 ${rawRun} 已恢复到 ${result.to}。` }
      }
      throw new Error('未知 action：' + action + '（支持 archive/restore/list）')
    },
  }
}

function auditTool() {
  return {
    name: 'rsi-audit',
    description: 'probe 写隔离审计（C2）：按实验创建时间扫描工作区内（排除 .rsi/.git/node_modules）被修改的文件，列出可能的 probe 越界写入。只读启发式检查，不自动改文件。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      runId: { type: 'string', description: '实验 id（用它创建时间作为起点）' },
      since: { type: 'string', description: 'ISO 时间起点（省略则取 runId 的创建时间）' },
      limit: { type: 'number', description: '最多返回多少条命中（默认 200）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: { type: 'string' },
          scanned: { type: 'number' },
          truncated: { type: 'boolean' },
          hits: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note)],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error('工作区不存在：' + cwd)
      const runId = slug(String(args.runId ?? ''))
      let since = String(args.since ?? '').trim()
      if (!since && runId) since = String(readRunConfig(cwd, runId).createdAt ?? '')
      if (!since) throw new Error('需要 runId 或 since（ISO 时间）作为审计起点')
      const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit ?? 200)) || 200))
      const result = scanWrites(cwd, since)
      const hits = result.hits.slice(0, limit)
      const note = hits.length
        ? `自 ${result.since} 起发现 ${result.hits.length} 个 .rsi 之外的写入（扫描 ${result.scanned} 个文件${result.truncated ? '，已截断' : ''}）：请逐条确认是否 probe 越界。`
        : `自 ${result.since} 起未发现 .rsi 之外的写入（扫描 ${result.scanned} 个文件）。`
      return { since: result.since, scanned: result.scanned, truncated: result.truncated, hits, note }
    },
  }
}

function lessonsFilePath(cwd) {
  return path.join(cwd, '.rsi', 'memory', 'harness-lessons.md')
}

function lessonBlocks(text) {
  const blocks = []
  let current = null
  for (const line of splitLines(text)) {
    if (/^##\s+/.test(line)) {
      if (current) blocks.push(current)
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push(current)
  return blocks.map((block) => {
    const body = block.lines.join('\n').trim()
    const parts = block.title.split(/[·—]/).map((part) => part.trim())
    return { title: block.title, ts: parts[0] || '', tag: parts.slice(1).join('·') || 'manual', text: body }
  })
}

function lessonTool() {
  return {
    name: 'rsi-lesson',
    description: 'RSI 教训库：手动追加或列读 <cwd>/.rsi/memory/harness-lessons.md（同一正文去重，不覆盖已有条目）。rsi-adopt 采纳改动时也会自动追加。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      action: { type: 'string', enum: ['add', 'list'], description: 'add 追加一条教训；list 列出最近条目（默认 list）' },
      text: { type: 'string', description: '教训正文（add 必填）' },
      tag: { type: 'string', description: '标签（add 可选，默认 manual）' },
      limit: { type: 'number', description: 'list 返回最近多少条（默认 10，最多 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          action: { type: 'string' },
          added: { type: 'boolean' },
          total: { type: 'number' },
          entries: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(value.note)],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = path.resolve(String(args.cwd ?? ''))
      if (!pathExists(cwd)) throw new Error('工作区不存在：' + cwd)
      const abs = lessonsFilePath(cwd)
      const existing = readFileOrNull(abs) ?? ''
      const action = String(args.action ?? 'list')
      const blocks = lessonBlocks(existing)
      if (action === 'add') {
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('text 不能为空（add）')
        const normalized = text.replace(/\s+/g, ' ')
        const duplicated = blocks.some((block) => block.text.replace(/\s+/g, ' ') === normalized)
        if (duplicated) {
          return { path: abs, action, added: false, total: blocks.length, entries: [], note: '该教训已存在，未重复追加（共 ' + blocks.length + ' 条）。' }
        }
        const tag = slug(String(args.tag ?? 'manual')) || 'manual'
        const entry = '## ' + isoNow() + ' · ' + tag + '\n\n' + text + '\n'
        const header = existing.trim() ? '' : '# Harness 教训库\n\n'
        writeFileSafe(cwd, path.join('.rsi', 'memory', 'harness-lessons.md'), (existing ? existing.replace(/\n+$/, '\n') + '\n' : header) + entry)
        return { path: abs, action, added: true, total: blocks.length + 1, entries: [], note: '教训已追加（标签 ' + tag + '），当前共 ' + (blocks.length + 1) + ' 条：' + abs }
      }
      if (action !== 'list') throw new Error('未知 action：' + action + '（支持 add/list）')
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10))
      const entries = blocks.slice(-limit).map((block) => ({ ts: block.ts, tag: block.tag, text: block.text.length > 300 ? block.text.slice(0, 300) + '…' : block.text }))
      return {
        path: abs,
        action,
        added: false,
        total: blocks.length,
        entries,
        note: blocks.length ? '共 ' + blocks.length + ' 条教训（显示最近 ' + entries.length + ' 条）。' : '教训库为空：rsi-adopt 采纳改动时会自动记录，也可用 rsi-lesson add 手动追加。',
      }
    },
  }
}

/** 未消化 = inbox 中不在 state.digestConsumed 里的反思卡（按文件名，不依赖 mtime）。 */
function pendingCards(cwd, consumed) {
  const dir = path.join(cwd, '.rsi', 'inbox')
  const seen = new Set(Array.isArray(consumed) ? consumed : [])
  const out = []
  for (const name of listFiles(dir)) {
    if (!/^reflect-.+\.md$/.test(name)) continue
    if (seen.has(name)) continue
    out.push({ name, mtime: 0 })
  }
  out.sort((x, y) => x.name.localeCompare(y.name))
  return out
}

function renderDigestCard(cwd, cards) {
  const ts = stamp()
  const records = evidenceRecords(cwd).slice(-DIGEST_WINDOW)
  const { bySource, byTool } = summarizeRecords(records)
  const toolRank = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const drafts = readProposalIndex(cwd).proposals.filter((item) => (item && (item.status || 'draft')) === 'draft')
  const lines = [
    '# RSI 巡检摘要（' + ts + '）',
    '',
    '- 工作区：' + cwd,
    '- 未消化反思卡：' + cards.length + ' 张（阈值 ' + DIGEST_THRESHOLD + '）',
    '- 证据总量：' + records.length + ' 条（窗口最近 ' + DIGEST_WINDOW + ' 条）',
    '- 证据来源：' + (Object.entries(bySource).map(([key, value]) => key + '×' + value).join('、') || '（无）'),
    '- 失败高发工具：' + (toolRank.map(([key, value]) => key + '×' + value).join('、') || '（无）'),
    '- 待审核提案：' + drafts.length + ' 个',
    '',
    '## 未消化反思卡',
    '',
    ...cards.map((card) => '- ' + path.join('.rsi', 'inbox', card.name)),
    '',
    '## 待审核提案',
    '',
    ...(drafts.length ? drafts.map((item) => '- ' + item.id + '：' + (item.title || '')) : ['- （无）']),
    '',
    '## 下一步',
    '',
    '1. 逐张处理反思卡：rsi-evidence 确认模式 → rsi-propose 起草 → rsi-review approve；',
    '2. 复盘完成后把每张卡的结论用 rsi-lesson add 记入教训库；',
    '3. 提案批准后由 rsi-adopt 执行，采纳后本摘要不再提示该提案。',
    '',
  ]
  const rel = path.join('.rsi', 'inbox', 'digest-' + ts + '.md')
  writeFileSafe(cwd, rel, lines.join('\n'))
  return path.join(cwd, rel)
}

function maybeDigest(cwd) {
  try {
    const { state } = readReflectStateSafe(cwd)
    const consumed = Array.isArray(state.digestConsumed) ? state.digestConsumed : []
    const cards = pendingCards(cwd, consumed)
    if (cards.length < DIGEST_THRESHOLD) return
    const cardPath = renderDigestCard(cwd, cards)
    writeReflectState(cwd, Object.assign({}, state, {
      lastDigestAt: isoNow(),
      lastDigestCount: cards.length,
      lastDigestCard: path.relative(cwd, cardPath).replace(/\\/g, '/'),
      digestConsumed: consumed.concat(cards.map((card) => card.name)),
    }))
  } catch {
    // 巡检摘要失败不影响任务执行
  }
}

export function apply(ctx) {
  // parameters 必须是编译后的 JSON Schema，否则非 PTC 模式下整批工具定义会被 provider 拒绝。
  const register = (makeTool) => {
    const tool = makeTool()
    ctx.tools.register({ ...tool, parameters: compileParameters(tool.parameters) })
  }
  register(planTool)
  register(collectTool)
  register(adoptTool)
  register(statusTool)
  register(evidenceTool)
  register(proposeTool)
  register(reviewTool)
  register(runTool)
  register(lessonTool)
  register(compareTool)
  register(archiveTool)
  register(auditTool)

  ctx.on('tools/result', (exec, result) => {
    if (!result || result.isError !== true) return
    // 宿主 exec 的参数字段是 arguments（不是 args），且 agent 才带 session id
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return
    appendEvidence(ctx, sessionId, {
      ts: new Date().toISOString(),
      source: 'tool-error',
      tool: exec?.name ?? 'unknown',
      error: truncateEvidence(result.error?.message ?? ''),
      args: pickArguments(exec?.arguments),
      argKeys: Object.keys(exec?.arguments ?? {}).slice(0, 8),
    })
  })

  ctx.on('feedback/committed', (inspection) => {
    if (!inspection) return
    const events = Array.isArray(inspection.events) ? inspection.events : []
    const last = events[events.length - 1]
    if (!last || last.type !== 'feedback/message-put' || !last.data) return
    const item = last.data.item
    // 只把明确差评当作改进证据，普通过赞/取消不算
    if (!item || item.rating !== 'negative') return
    const sessionId = sessionIdOf(last.data.sessionId ?? inspection.meta?.id ?? inspection)
    if (!sessionId) return
    appendEvidence(ctx, sessionId, {
      ts: new Date().toISOString(),
      source: 'feedback',
      rating: item.rating,
      messageId: item.messageId ?? null,
      category: item.category ?? null,
      note: truncateEvidence(item.note ?? ''),
    })
  })

  ctx.on('agent/error', (payload) => {
    if (!payload) return
    appendEvidence(ctx, sessionIdOf(payload.agent ?? payload), {
      ts: new Date().toISOString(),
      source: 'agent-error',
      error: truncateEvidence(payload.error instanceof Error ? payload.error.message : String(payload.error ?? '')),
      turn: typeof payload.turn === 'number' ? payload.turn : null,
      step: typeof payload.step === 'number' ? payload.step : null,
    })
  })

  // turn/end 不是 Cordis 事件，而是 session.append 写入的会话事件，所以监听 session/event。
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end') return
    const sessionId = sessionIdOf(session)
    if (sessionId) maybeReflect(ctx, sessionId)
  })
}

export { name, inject }