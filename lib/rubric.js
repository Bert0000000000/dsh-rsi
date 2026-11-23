import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveInside, pathExists, readFileOrNull, splitLines, listDirNames, listFiles } from './fsx.js'
import { safeRegexTest } from './regex-safe.js'

export const EVAL_KINDS = ['file-exists', 'line-count', 'regex-all-lines', 'regex-last-line', 'contains', 'command', 'manual']
export const MAX_COMMAND_TIMEOUT_MS = 60000
const COMMAND_OUTPUT_LIMIT = 240

function clip(text, limit = COMMAND_OUTPUT_LIMIT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/** command 型评分项（B4）：在 probe 目录里执行命令，比对退出码与可选的正则。 */
function runCommandItem(item, probeDir) {
  const run = String(item.run ?? '').trim()
  if (!run) return { ok: false, detail: 'command 评分项缺少 run 字段' }
  const rawTimeout = Number(item.timeoutMs)
  const timeoutMs = Math.max(100, Math.min(MAX_COMMAND_TIMEOUT_MS, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10000))
  const expectExit = Number.isInteger(item.expectExit) ? item.expectExit : 0
  let result
  try {
    result = spawnSync(run, {
      cwd: probeDir,
      shell: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    return { ok: false, detail: `命令执行异常：${error instanceof Error ? error.message : String(error)}` }
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { ok: false, detail: `命令超时（${timeoutMs}ms）：${run}` }
  }
  const code = typeof result.status === 'number' ? result.status : -1
  const output = String(result.stdout ?? '') + String(result.stderr ?? '')
  if (code !== expectExit) {
    return { ok: false, detail: `命令退出码 ${code}（期望 ${expectExit}）：${run}${output ? '；输出：' + clip(output) : ''}` }
  }
  if (item.pattern != null && String(item.pattern) !== '') {
    let matched = false
    try {
      matched = safeRegexTest(item.pattern, output)
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    if (!matched) return { ok: false, detail: `命令输出未匹配 /${item.pattern}/：${run}${output ? '；输出：' + clip(output) : ''}` }
  }
  return { ok: true, detail: `命令成功（退出码 ${code}）：${run}` }
}

export function evaluateItem(item, probeDir) {
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
  if (item.kind === 'command') {
    const outcome = runCommandItem(item, probeDir)
    return { ...base, ok: outcome.ok, detail: outcome.detail }
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
  if (item.kind === 'contains') {
    const ok = content.includes(String(item.pattern ?? ''))
    return { ...base, ok, detail: ok ? `找到片段：${item.pattern}` : `未找到片段：${item.pattern}` }
  }
  const lines = splitLines(content)
  let bad = 0
  let errorText = ''
  try {
    if (item.kind === 'regex-all-lines') {
      bad = lines.filter((line) => !safeRegexTest(item.pattern ?? '', line)).length
    } else {
      const last = lines[lines.length - 1] ?? ''
      bad = safeRegexTest(item.pattern ?? '', last) ? 0 : 1
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
  }
  if (errorText) return { ...base, ok: false, detail: errorText }
  if (item.kind === 'regex-all-lines') {
    return { ...base, ok: bad === 0, detail: `${lines.length} 行中 ${bad} 行不匹配 /${item.pattern}/` }
  }
  return { ...base, ok: bad === 0, detail: `末行${bad === 0 ? '' : '不'}匹配 /${item.pattern}/` }
}

export function validateRubric(rubric) {
  if (!rubric || typeof rubric !== 'object' || !Array.isArray(rubric.items) || !rubric.items.length) {
    throw new Error('rubric 必须包含至少一个评分项（items[] 非空）')
  }
  if (rubric.passScore != null) {
    if (!Number.isFinite(rubric.passScore) || rubric.passScore <= 0) {
      throw new Error(`rubric.passScore 必须是大于 0 的有限数字，收到：${JSON.stringify(rubric.passScore)}`)
    }
  }
  if (rubric.minPassRate != null) {
    const rate = Number(rubric.minPassRate)
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
      throw new Error(`rubric.minPassRate 必须是 (0,1] 的有限数字，收到：${JSON.stringify(rubric.minPassRate)}`)
    }
  }
  rubric.items.forEach((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`评分项 #${index + 1} 非法`)
    if (item.kind != null && !EVAL_KINDS.includes(item.kind)) {
      throw new Error(`评分项 #${index + 1} 的 kind '${item.kind}' 未知（合法值：${EVAL_KINDS.join(' | ')}）`)
    }
    if (item.kind === 'command' && !String(item.run ?? '').trim()) {
      throw new Error(`评分项 #${index + 1} 是 command 类型，必须提供 run 命令`)
    }
  })
  return rubric
}

/** 列出某个变体的重复目录（r1..rN）；旧布局（直接放文件）按单次兼容。 */
export function repeatDirs(probeDir) {
  const names = listDirNames(probeDir)
    .filter((name) => /^r\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  if (!names.length) return [{ name: '', index: 1, dir: probeDir, legacy: true }]
  return names.map((name) => ({ name, index: Number(name.slice(1)), dir: path.join(probeDir, name), legacy: false }))
}

export function scoreRows(rows) {
  let score = 0
  let max = 0
  let failed = 0
  const manual = []
  for (const row of rows) {
    if (row.kind == null || row.kind === 'manual') {
      if (row.ok === null) manual.push(row.label || row.id || '')
      continue
    }
    max += row.weight
    if (row.ok === true) score += row.weight
    else failed += 1
  }
  return { score, max, failed, manual }
}

function missingRows(items, index, reason) {
  return items.map((item) => {
    const safe = item && typeof item === 'object' ? item : {}
    const manual = safe.kind == null || safe.kind === 'manual'
    return {
      id: safe.id ?? '',
      label: safe.label ?? safe.id ?? '',
      kind: safe.kind ?? 'manual',
      weight: typeof safe.weight === 'number' && safe.weight >= 0 ? safe.weight : 1,
      ok: manual ? null : false,
      detail: reason || `第 ${index} 次 probe 未产出，判 0 分`,
    }
  })
}

function round3(value) {
  return Number(Number(value).toFixed(3))
}

function stdev(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
  return round3(Math.sqrt(variance))
}

/** B1：按计划次数聚合每个变体的重复执行结果。 */
export function aggregateVariant(options) {
  const { label, dirName, probeDir, plannedRepeats, items, passScore, hasPassScore, minPassRate } = options
  const planned = Math.max(1, Math.min(9, Number(plannedRepeats) || 1))
  const found = new Map(repeatDirs(probeDir).map((entry) => [entry.index, entry]))
  const repeatRows = []
  const manualSeen = new Set()
  const manualItems = []
  let executed = 0
  const scores = []
  let maxPerRepeat = 0
  let lastRows = []
  for (let index = 1; index <= planned; index += 1) {
    const entry = found.get(index) ?? (planned === 1 ? { dir: probeDir } : null)
    const dir = entry ? entry.dir : null
    const files = dir ? listFiles(dir) : []
    const produced = Boolean(dir) && files.length > 0
    let rows
    if (!produced) {
      rows = missingRows(items, index)
    } else {
      rows = items.map((item) => evaluateItem(item && typeof item === 'object' ? item : {}, dir))
      executed += 1
    }
    const scored = scoreRows(rows)
    maxPerRepeat = Math.max(maxPerRepeat, scored.max)
    for (const name of scored.manual) {
      const key = String(name)
      if (manualSeen.has(key)) continue
      manualSeen.add(key)
      manualItems.push(`[${label}] ${key}`)
    }
    const passed = produced && scored.failed === 0 && (!hasPassScore || scored.score >= passScore)
    scores.push(produced ? scored.score : 0)
    repeatRows.push({ index, executed: produced, score: scored.score, max: scored.max, failed: scored.failed, passed, rows })
    lastRows = rows
  }
  const sum = scores.reduce((acc, value) => acc + value, 0)
  const mean = round3(sum / planned)
  const passedRepeats = repeatRows.filter((row) => row.passed).length
  const passRate = round3(passedRepeats / planned)
  const allExecuted = executed === planned
  const variantPassed = hasPassScore ? (allExecuted && passRate >= minPassRate && mean >= passScore) : null
  return {
    label,
    dir: dirName,
    probeExists: executed > 0,
    repeats: planned,
    executed,
    allExecuted,
    score: mean,
    totalScore: sum,
    max: maxPerRepeat,
    failed: repeatRows.reduce((acc, row) => acc + row.failed, 0),
    passed: variantPassed,
    passRate,
    minPassRate,
    mean,
    stdev: stdev(scores),
    scores,
    repeatRows,
    rows: lastRows,
    manualItems,
  }
}
