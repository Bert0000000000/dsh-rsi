import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { listDirNames, pathExists, readFileOrNull, readJson, splitLines, stamp, writeFileAtomic } from './fsx.js'

export const RUNS_DIR = '.rsi/runs'
export const ARCHIVE_DIR = '.rsi/runs/_archive'
const INDEX_REL = '.rsi/runs/index.json'

export function runRoot(cwd) {
  return path.join(cwd, RUNS_DIR)
}

export function listRuns(cwd) {
  return listDirNames(runRoot(cwd)).filter((name) => name !== '_archive')
}

export function readRunIndex(cwd) {
  const file = path.join(cwd, INDEX_REL)
  const text = readFileOrNull(file)
  if (text == null) return { runs: [] }
  try {
    const raw = JSON.parse(text)
    if (raw && typeof raw === 'object' && Array.isArray(raw.runs)) return raw
    return { runs: [] }
  } catch {
    try {
      fs.copyFileSync(file, file + '.corrupt-' + stamp() + '.bak')
    } catch {
      // 备份失败不阻塞
    }
    return { runs: [] }
  }
}

export function writeRunIndex(cwd, index) {
  writeFileAtomic(cwd, INDEX_REL, JSON.stringify(index, null, 2) + '\n')
}

export function upsertRun(cwd, record) {
  const index = readRunIndex(cwd)
  const at = index.runs.findIndex((item) => item && item.runId === record.runId)
  if (at >= 0) index.runs[at] = Object.assign({}, index.runs[at], record)
  else index.runs.push(record)
  writeRunIndex(cwd, index)
  return index
}

export function runRecord(cwd, runId) {
  return readRunIndex(cwd).runs.find((item) => item && item.runId === runId) ?? null
}

export function childrenOf(cwd, runId) {
  return readRunIndex(cwd).runs.filter((item) => item && item.parent === runId).map((item) => item.runId)
}

/** 复现元数据（B5）：node/platform/gitHead 等，足以判断「同一实验能否复现」。 */
export function runMeta(cwd) {
  let gitHead = ''
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    gitHead = ''
  }
  return { node: process.version, platform: process.platform, arch: process.arch, gitHead, cwd, createdAt: new Date().toISOString() }
}

/** B6：归档（移动目录 + 索引标记）。 */
export function archiveRun(cwd, runId) {
  const from = path.join(runRoot(cwd), runId)
  if (!pathExists(from)) throw new Error('实验不存在：' + runId)
  const archiveRoot = path.join(cwd, ARCHIVE_DIR)
  fs.mkdirSync(archiveRoot, { recursive: true })
  const targetName = stamp() + '-' + runId
  const to = path.join(archiveRoot, targetName)
  fs.renameSync(from, to)
  const rel = path.relative(cwd, to).replace(/\\/g, '/')
  upsertRun(cwd, { runId, archived: true, archivePath: rel, archivedAt: new Date().toISOString() })
  return { to, rel }
}

export function restoreRun(cwd, runId) {
  const index = readRunIndex(cwd)
  const record = index.runs.find((item) => item && item.runId === runId)
  if (!record || !record.archivePath) throw new Error('索引中没有该实验的归档记录：' + runId)
  const from = path.join(cwd, record.archivePath)
  if (!pathExists(from)) throw new Error('归档目录不存在：' + record.archivePath)
  const to = path.join(runRoot(cwd), runId)
  if (pathExists(to)) throw new Error('同名实验目录已存在，拒绝恢复：' + runId)
  fs.renameSync(from, to)
  upsertRun(cwd, { runId, archived: false, archivePath: '', restoredAt: new Date().toISOString() })
  return { to }
}

export function probeStateOf(dir) {
  const names = listDirNames(dir)
  if (!names.length) {
    const files = listFilesShallow(dir)
    return { status: files.length ? 'partial' : 'empty', files }
  }
  return { status: 'done', files: names }
}

function listFilesShallow(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

export function readRunConfig(cwd, runId) {
  const file = path.join(runRoot(cwd), runId, 'config.json')
  const text = readFileOrNull(file)
  if (text == null) return {}
  try {
    const raw = JSON.parse(text)
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    throw new Error('config.json 解析失败：' + file)
  }
}

export function plannedRepeats(config) {
  const repeats = Number(config?.repeats)
  return Number.isFinite(repeats) && repeats >= 1 ? Math.min(9, Math.floor(repeats)) : 1
}

export function plannedMinPassRate(config) {
  const rate = Number(config?.minPassRate)
  return Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 1
}
