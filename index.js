import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const name = 'rsi-toolkit'
const inject = ['tools', 'sessions', 'workingDirectory']

function textBlock(text) {
  return { type: 'text', text }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item'
}

function resolveInside(base, target) {
  const resolved = path.resolve(base, target)
  const root = path.resolve(base)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界：'${target}' 不在工作区 '${base}' 内`)
  }
  return resolved
}

function pathExists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function writeFileSafe(base, rel, content) {
  const abs = resolveInside(base, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
function writeFileAtomic(base, rel, content) {
  const abs = resolveInside(base, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = abs + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, abs)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件清理失败不覆盖原始错误
    }
    throw error
  }
  return abs
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 已存在路径取 realpath；不存在时向上找到最近的已存在祖先再拼接。 */
function realPathOf(target) {
  let current = path.resolve(target)
  const tail = []
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      tail.push(path.basename(current))
      current = parent
    }
  }
  return path.resolve(target)
}

function readJson(p) {
  if (!pathExists(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析 JSON：${p}（${error.message}）`)
  }
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function listDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function listFiles(dir) {
  try {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) out.push(entry.name)
      else if (entry.isDirectory()) {
        for (const sub of listFiles(path.join(dir, entry.name))) out.push(`${entry.name}/${sub}`)
      }
    }
    return out
  } catch {
    return []
  }
}

function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * 把作者侧参数 DSL（属性级 required: true）编译成模型端可用的 JSON Schema。
 * ctx.tools.register 的 parameters 是原始 JSON Schema，不会再做这层编译；
 * 直接把 DSL 注册出去，provider 会收到非法 schema（property 里的 required 必须是对象根上的字符串数组）。
 */
function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = compileValueSpec(value)
    if (value && value.required === true) required.push(key)
  }
  return { properties, required }
}

function compileValueSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec
  const node = {}
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required' || key === 'properties') continue
    if (key === 'items') node.items = Array.isArray(value) ? value.map(compileValueSpec) : compileValueSpec(value)
    else node[key] = value
  }
  if (spec.properties && typeof spec.properties === 'object') {
    const { properties, required } = compilePropertyMap(spec.properties)
    node.properties = properties
    if (required.length) node.required = required
  }
  return node
}

function compileParameters(spec) {
  const { properties, required } = compilePropertyMap(spec)
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

const ADOPT_RSI_DENY = ['bundles/', 'evidence/', 'state/', 'proposals/', 'backups/']

function normalizeRel(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function hasDotDotSegment(rel) {
  return normalizeRel(rel).split('/').some((seg) => seg === '..' || seg === '.')
}

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

const EVAL_KINDS = ['file-exists', 'line-count', 'regex-all-lines', 'regex-last-line', 'contains', 'manual']

function evaluateItem(item, probeDir) {
  if (!item || typeof item !== 'object') {
    return { id: '', label: '', kind: 'manual', weight: 0, ok: false, detail: '评分项为空或非法，判失败' }
  }
  const weight = typeof item.weight === 'number' && item.weight >= 0 ? item.weight : 1
  const base = {
    id: item.id ?? '',
    label: item.label ?? item.id ?? '',
    kind: item.kind ?? 'manual',
    weight,
    ok: null,
    detail: `人工评审项${item.note ? `：${item.note}` : ''}`,
  }
  if (item.kind === 'manual' || !item.kind) return base
  if (!EVAL_KINDS.includes(item.kind)) {
    return { ...base, ok: false, detail: `未知 kind '${item.kind}'，判失败（合法值：${EVAL_KINDS.join(' | ')}）` }
  }
  const target = item.path ? resolveInside(probeDir, item.path) : null
  const missing = { ...base, ok: false, detail: `文件缺失：${item.path ?? '(无 path)'}` }
  if (item.kind === 'file-exists') {
    if (!target || !pathExists(target)) return { ...base, ok: false, detail: `文件缺失：${item.path}` }
    let size = 0
    try {
      size = fs.statSync(target).size
    } catch {
      size = 0
    }
    if (size === 0) return { ...base, ok: false, detail: `文件为空（0 字节）：${item.path}` }
    if ((readFileOrNull(target) ?? '').trim() === '') return { ...base, ok: false, detail: `文件只有空白字符：${item.path}` }
    return { ...base, ok: true, detail: `文件存在（${size} 字节）：${item.path}` }
  }
  if (!target || !pathExists(target)) return missing
  const content = readFileOrNull(target) ?? ''
  if (content.trim() === '') {
    return { ...base, ok: false, detail: `文件为空（0 非空字符）：${item.path}` }
  }
  if (item.kind === 'line-count') {
    const n = splitLines(content).length
    const ok = (item.min == null || n >= item.min) && (item.max == null || n <= item.max)
    return { ...base, ok, detail: `${item.path} 共 ${n} 行（要求 ${item.min ?? '-'}~${item.max ?? '-'}）` }
  }
  let re
  try {
    re = new RegExp(item.pattern ?? '')
  } catch {
    return { ...base, ok: false, detail: `正则无效：${item.pattern}` }
  }
  if (item.kind === 'regex-all-lines') {
    const lines = splitLines(content)
    const bad = lines.filter((line) => !re.test(line)).length
    return { ...base, ok: bad === 0, detail: `${lines.length} 行中 ${bad} 行不匹配 /${item.pattern}/` }
  }
  if (item.kind === 'regex-last-line') {
    const lines = splitLines(content)
    const last = lines[lines.length - 1] ?? ''
    return { ...base, ok: re.test(last), detail: `末行${re.test(last) ? '' : '不'}匹配 /${item.pattern}/` }
  }
  if (item.kind === 'contains') {
    const ok = content.includes(String(item.pattern ?? ''))
    return { ...base, ok, detail: ok ? `找到片段：${item.pattern}` : `未找到片段：${item.pattern}` }
  }
  return { ...base, ok: false, detail: `未知 kind '${item.kind}'，判失败` }
}

function validateRubric(rubric) {
  if (!rubric || typeof rubric !== 'object' || !Array.isArray(rubric.items) || !rubric.items.length) {
    throw new Error('rubric 必须包含至少一个评分项（items[] 非空）')
  }
  if (rubric.passScore != null) {
    if (!Number.isFinite(rubric.passScore) || rubric.passScore <= 0) {
      throw new Error(`rubric.passScore 必须是大于 0 的有限数字，收到：${JSON.stringify(rubric.passScore)}`)
    }
  }
  rubric.items.forEach((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`评分项 #${index + 1} 非法`)
    if (item.kind != null && !EVAL_KINDS.includes(item.kind)) {
      throw new Error(`评分项 #${index + 1} 的 kind '${item.kind}' 未知（合法值：${EVAL_KINDS.join(' | ')}）`)
    }
  })
  return rubric
}

function planTool() {
  return {
    name: 'rsi-plan',
    description: '创建一轮 RSI Propose 实验：给定统一任务 T 和多个候选 harness 变体，落盘任务/评分表/变体文件，并返回每个变体的 probe 子代理启动指令。本工具只写文件、不启动子代理；模型须按返回的 instructions 用 subagent 工具逐个启动全新子代理。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径；本工具的所有写入只发生在 cwd 内' },
      runId: { type: 'string', description: '实验 id（kebab-case，默认 r<时间戳>）' },
      task: { type: 'string', required: true, description: '统一任务 T 的完整文本（每个 probe 收到的任务文本必须完全一致）' },
      variants: {
        type: 'array',
        required: true,
        description: '候选 harness 变体列表',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '变体名（如 baseline、候选规则 A）' },
            harness: { type: 'string', description: '该变体的 harness 规则全文；基线可写「无附加规则」' },
          },
        },
      },
      rubric: {
        type: 'object',
        description: '评分表（缺省生成单个人工评审项）',
        properties: {
          passScore: { type: 'number', description: '及格分（加权分数）' },
          items: {
            type: 'array',
            description: '评分项',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                kind: { type: 'string', description: 'file-exists | line-count | regex-all-lines | regex-last-line | contains | manual' },
                weight: { type: 'number' },
                path: { type: 'string', description: '相对 probe 目录的文件路径' },
                pattern: { type: 'string' },
                min: { type: 'number' },
                max: { type: 'number' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          runDir: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          instructions: { type: 'string' },
        },
      },
      render: (args, value) => [textBlock(`实验 ${value.runId} 已创建。\n${value.instructions}`)],
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

      fs.mkdirSync(runDir, { recursive: true })
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'task.md'), `# 任务 T\n\n${task}\n`)
      const rubric = args.rubric && typeof args.rubric === 'object' && Array.isArray(args.rubric.items)
        ? args.rubric
        : { passScore: null, items: [{ id: 'overall', label: '总体完成度', kind: 'manual', weight: 1, note: '人工评审' }] }
      validateRubric(rubric)
      const rubricText = JSON.stringify(rubric, null, 2) + '\n'
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'rubric.json'), rubricText)
      writeFileSafe(cwd, path.join('.rsi', 'runs', runId, 'config.json'), JSON.stringify({
        cwd,
        runId,
        createdAt: new Date().toISOString(),
        variantCount: variants.length,
        rubricSha256: sha256(rubricText),
        rubricRuleVersion: 2,
      }, null, 2) + '\n')

      const labels = []
      const blocks = [`# RSI 实验 ${runId}\n\n运行目录：${runDir}\n`]
      variants.forEach((variant, index) => {
        const label = slug(variant?.label || `v${index + 1}`)
        labels.push(label)
        const num = String(index + 1)
        const variantDir = path.join(runDir, 'variants', `${num}-${label}`)
        fs.mkdirSync(variantDir, { recursive: true })
        fs.writeFileSync(path.join(variantDir, 'harness.md'), `# 候选 harness：${variant?.label ?? label}\n\n${String(variant?.harness ?? '')}\n`, 'utf8')
        const probeDir = path.join(runDir, 'probes', `${num}-${label}`)
        fs.mkdirSync(probeDir, { recursive: true })
        const harnessText = String(variant?.harness ?? '').trim() || '无附加规则（基线）'
        blocks.push(
          `## 变体 ${num}：${label}\n\n1. 启动一个全新 subagent（不用 fork，不带任何本会话的 harness 建议）。\n2. 原样发送任务文本：\n\n---\n${task}\n---\n\n3. 单独告知它的 harness 约束：\n\n---\n${harnessText}\n---\n\n4. 要求它：全部产出与最终报告写入 ${probeDir} 目录；除该目录外不得创建或修改任何文件；不读不写 .rsi 之外的任何配置。\n`
        )
      })
      blocks.push(`\n完成后调用 rsi-collect（cwd=${cwd}，runId=${runId}）汇总评分。`)
      const instructions = blocks.join('\n')
      return { runId, runDir, labels, instructions }
    },
  }
}

function collectTool() {
  return {
    name: 'rsi-collect',
    description: '汇总一轮 RSI 实验：按 rubric.json 对每个 probe 变体的产出做机器评分，生成 report.md/report.json，返回各变体得分对比。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      runId: { type: 'string', required: true, description: '实验 id' },
      // 评分表只能来自 runs/<runId>/rubric.json（并校验创建时的 sha256），不接受调用方覆盖
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
          rubricHashVerified: { type: 'boolean' },
          failedVariants: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [textBlock(`汇总完成：${value.hasPassScore ? (value.passed ? '全部变体通过' : `未全部通过（${value.failedVariants.join('、') || '无有效变体'}）`) : '待人工评审'}（总分 ${value.total}/${value.maxTotal}，评分表哈希${value.rubricHashVerified ? '已校验' : '未校验（旧实验）'}）\n报告：${value.reportPath}`)],
    },
    timeoutMs: 60000,
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
      const variantDirs = listDirNames(path.join(runDir, 'variants')).sort()
      if (!variantDirs.length) throw new Error('没有任何 variants 目录')
      const probeNames = new Set(listDirNames(path.join(runDir, 'probes')))
      const hasPassScore = Number.isFinite(rubric.passScore) && rubric.passScore > 0
      const passScore = hasPassScore ? rubric.passScore : 0
      const variants = []
      const manualItems = []
      for (const dirName of variantDirs) {
        const probeDir = path.join(runDir, 'probes', dirName)
        const label = dirName.replace(/^\d+-/, '')
        const probeExists = probeNames.has(dirName) && pathExists(probeDir)
        const rows = rubric.items.map((item) => {
          const safeItem = item && typeof item === 'object' ? item : {}
          if (probeExists) return evaluateItem(safeItem, probeDir)
          const manual = safeItem.kind == null || safeItem.kind === 'manual'
          return {
            id: safeItem.id ?? '',
            label: safeItem.label ?? safeItem.id ?? '',
            kind: safeItem.kind ?? 'manual',
            weight: typeof safeItem.weight === 'number' && safeItem.weight >= 0 ? safeItem.weight : 1,
            ok: manual ? null : false,
            detail: 'probe 目录缺失，判 0 分',
          }
        })
        let score = 0
        let max = 0
        let failed = 0
        for (const row of rows) {
          if (row.kind == null || row.kind === 'manual') {
            if (row.ok === null) manualItems.push(`[${label}] ${row.label || row.id || ''}`)
            continue
          }
          max += row.weight
          if (row.ok === true) score += row.weight
          else failed += 1
        }
        // 任一机器评分项失败即判该变体未通过：passScore 只是分数门槛，不能掩盖漏交付
        const variantPassed = hasPassScore ? score >= passScore && failed === 0 : null
        variants.push({ label, dir: dirName, probeExists, score, max, failed, passed: variantPassed, rows })
      }
      const total = variants.reduce((acc, v) => acc + v.score, 0)
      const maxTotal = variants.reduce((acc, v) => acc + v.max, 0)
      const failedVariants = variants.filter((v) => v.passed !== true).map((v) => v.label)
      const strictRule = '任一机器评分项失败即判该变体未通过（passScore 只作分数门槛）'
      const passed = hasPassScore && variants.length > 0 && variants.every((v) => v.passed === true)
      const lines = ['# RSI 实验汇总', '', `runId: ${runId}`, `评分表哈希：${rubricHashVerified ? '已校验 ' : '未校验（旧实验无记录） '}${rubricSha256}`, `判定规则：${strictRule}`, '']
      for (const v of variants) {
        lines.push(`## ${v.label} — ${v.score}/${v.max}${v.passed === true ? ' ✅ 通过' : v.passed === false ? ' ❌ 未通过' : ''}${v.probeExists ? '' : '（probe 目录缺失）'}`, '')
        lines.push('| 评分项 | 结果 | 说明 |', '| --- | --- | --- |')
        for (const row of v.rows) {
          lines.push(`| ${row.label || row.id || '-'} | ${row.ok === true ? '✅' : row.ok === false ? '❌' : '👤 人工'} | ${String(row.detail ?? '').replace(/\|/g, '\\|')} |`)
        }
        lines.push('')
      }
      if (failedVariants.length) lines.push('## 未通过变体', '', ...failedVariants.map((name) => `- ${name}`), '')
      if (manualItems.length) lines.push('## 待人工评审', '', ...manualItems.map((m) => `- ${m}`), '')
      const reportPath = path.join(runDir, 'report.md')
      fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ runId, passScore, hasPassScore, total, maxTotal, passed, rubricSha256, rubricHashVerified, failedVariants, variants, manualItems }, null, 2) + '\n', 'utf8')
      return { runId, variants, manualItems, reportPath, maxTotal, total, passScore, hasPassScore, passed, rubricHashVerified, failedVariants }
    },
  }
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
        try {
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
          note: `已采纳 ${changed.length} 个文件改动；原文件备份在 ${backupDir}；决策已追加到 .rsi/memory/harness-lessons.md；提案 ${proposal.id} 已标记 applied`,
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
      const runs = listDirNames(path.join(dir, 'runs'))
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

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[无法序列化]'
  }
}

function truncateEvidence(value) {
  const s = String(value ?? '')
  return s.length > EVIDENCE_TRUNCATE ? `${s.slice(0, EVIDENCE_TRUNCATE)}…(截断,共${s.length}字符)` : s
}

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
    out[key] = text.length > 200 ? text.slice(0, 200) + '…' : text
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

function isoNow() {
  return new Date().toISOString()
}

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

function runRoot(cwd) {
  return path.join(cwd, '.rsi', 'runs')
}

function probeStateOf(dir) {
  const files = listFiles(dir)
  if (!files.length) return { status: 'empty', files }
  const hasResult = files.some((name) => name === 'result.txt' || name === 'report.md' || name.endsWith('/result.txt') || name.endsWith('/report.md'))
  return { status: hasResult ? 'done' : 'partial', files }
}

function summarizeRun(cwd, runId) {
  const dir = path.join(runRoot(cwd), runId)
  const variants = listDirNames(path.join(dir, 'variants'))
  const probes = listDirNames(path.join(dir, 'probes')).map((variant) => {
    const state = probeStateOf(path.join(dir, 'probes', variant))
    return { variant, status: state.status, files: state.files }
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
  return {
    dir,
    variants,
    probes,
    done: probes.filter((probe) => probe.status === 'done').length,
    hasReport: pathExists(reportPath),
    score,
    maxTotal,
    verdict,
  }
}

function stripHeading(text) {
  return String(text ?? '').replace(/^#[^\n]*\n+/, '').trim()
}

function probeLaunch(cwd, runId, variant) {
  const dir = path.join(runRoot(cwd), runId)
  const task = stripHeading(readFileOrNull(path.join(dir, 'task.md')) ?? '')
  const harness = stripHeading(readFileOrNull(path.join(dir, 'variants', variant, 'harness.md')) ?? '') || '无附加规则（基线）'
  const probeDir = path.join(dir, 'probes', variant)
  return [
    '## 待补跑：' + variant,
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
    description: 'RSI 实验状态机：扫描 <cwd>/.rsi/runs 下每个变体与 probe 的产出，报告 probe 是否已产出、评分是否已汇总，并给出补跑指令。只读，不启动子代理。',
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
      const ids = wanted ? listDirNames(root).filter((id) => id === wanted || id.includes(wanted)) : listDirNames(root)
      if (!ids.length) {
        return { dir: root, runId: wanted, runs: [], probes: [], instructions: '', note: wanted ? '未找到实验：' + wanted : '还没有实验：先用 rsi-plan 创建一轮 Propose 实验。' }
      }
      const runs = ids.map((id) => {
        const summary = summarizeRun(cwd, id)
        return {
          runId: id,
          variantCount: summary.variants.length,
          probeCount: summary.probes.length,
          done: summary.done,
          missing: summary.probes.filter((probe) => probe.status !== 'done').map((probe) => probe.variant),
          hasReport: summary.hasReport,
          score: summary.score,
          maxTotal: summary.maxTotal,
          verdict: summary.verdict,
        }
      })
      const detail = wanted && runs.length === 1 ? summarizeRun(cwd, runs[0].runId) : null
      const pending = detail ? detail.probes.filter((probe) => probe.status !== 'done').map((probe) => probe.variant) : []
      const instructions = detail ? pending.map((variant) => probeLaunch(cwd, runs[0].runId, variant)).join('\n\n') : ''
      const lines = runs.map((run) => {
        const score = run.hasReport ? '已评分 ' + (run.score ?? '?') + '/' + (run.maxTotal ?? '?') + (run.verdict ? '（' + run.verdict + '）' : '') : '未评分'
        return '- ' + run.runId + '：变体 ' + run.variantCount + '、probe ' + run.done + '/' + run.probeCount + ' 完成，' + score + (run.missing.length ? '，待补跑 ' + run.missing.join('、') : '')
      })
      const note = [
        '实验状态（' + ids.length + ' 个）：',
        ...lines,
        detail ? '\n下一步：' + (pending.length ? '补跑 ' + pending.length + ' 个 probe（指令见下）' : detail.hasReport ? '已有评分报告，可用 rsi-adopt（带 proposalId）采纳改动' : '全部 probe 已产出，执行 rsi-collect 汇总评分') : '\n指定 runId 可查看单个实验的 probe 明细与补跑指令。',
      ].join('\n')
      return {
        dir: root,
        runId: detail ? runs[0].runId : wanted,
        runs,
        probes: detail ? detail.probes : [],
        instructions,
        note,
      }
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