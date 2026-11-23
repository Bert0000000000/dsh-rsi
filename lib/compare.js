import fs from 'node:fs'
import path from 'node:path'
import { listFiles, readFileOrNull, splitLines, sha256 } from './fsx.js'

const MAX_COMPARE_BYTES = 200 * 1024
const SAMPLE_LINES = 30

/** 裁剪公共前后缀后的逐行差异。 */
export function compareTexts(aText, bText, limit = SAMPLE_LINES) {
  const a = splitLines(aText)
  const b = splitLines(bText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const removed = a.slice(start, endA)
  const added = b.slice(start, endB)
  return {
    identical: removed.length === 0 && added.length === 0,
    removedCount: removed.length,
    addedCount: added.length,
    removed: removed.slice(0, limit),
    added: added.slice(0, limit),
    truncated: removed.length > limit || added.length > limit,
  }
}

export function compareDirs(dirA, dirB) {
  const filesA = new Map(listFiles(dirA).map((name) => [name, path.join(dirA, name)]))
  const filesB = new Map(listFiles(dirB).map((name) => [name, path.join(dirB, name)]))
  const names = Array.from(new Set([...filesA.keys(), ...filesB.keys()])).sort()
  const files = []
  for (const name of names) {
    const inA = filesA.has(name)
    const inB = filesB.has(name)
    if (!inA) { files.push({ path: name, status: 'only-b', bytesA: 0, bytesB: fileSize(filesB.get(name)) }); continue }
    if (!inB) { files.push({ path: name, status: 'only-a', bytesA: fileSize(filesA.get(name)), bytesB: 0 }); continue }
    const a = readText(filesA.get(name))
    const b = readText(filesB.get(name))
    if (a == null || b == null) { files.push({ path: name, status: 'binary', bytesA: fileSize(filesA.get(name)), bytesB: fileSize(filesB.get(name)) }); continue }
    if (sha256(a) === sha256(b)) { files.push({ path: name, status: 'same', bytesA: a.length, bytesB: b.length }); continue }
    const diff = compareTexts(a, b)
    files.push({ path: name, status: 'changed', bytesA: a.length, bytesB: b.length, addedCount: diff.addedCount, removedCount: diff.removedCount, added: diff.added, removed: diff.removed, truncated: diff.truncated })
  }
  const summary = { total: files.length, onlyA: 0, onlyB: 0, changed: 0, same: 0, binary: 0 }
  for (const file of files) {
    if (file.status === 'only-a') summary.onlyA += 1
    else if (file.status === 'only-b') summary.onlyB += 1
    else if (file.status === 'changed') summary.changed += 1
    else if (file.status === 'binary') summary.binary += 1
    else summary.same += 1
  }
  return { files, summary }
}

function fileSize(abs) {
  try {
    return fs.statSync(abs).size
  } catch {
    return 0
  }
}

function readText(abs) {
  try {
    if (fs.statSync(abs).size > MAX_COMPARE_BYTES) return null
    const text = readFileOrNull(abs)
    if (text == null) return null
    if (text.includes('\u0000')) return null
    return text
  } catch {
    return null
  }
}

export function renderCompareMarkdown(title, dirA, dirB, result) {
  const lines = ['# ' + title, '', `- A：${dirA}`, `- B：${dirB}`, '']
  const s = result.summary
  lines.push(`- 文件：${s.total}（仅 A ${s.onlyA}、仅 B ${s.onlyB}、改动 ${s.changed}、相同 ${s.same}、二进制 ${s.binary}）`, '')
  for (const file of result.files) {
    if (file.status === 'same') continue
    lines.push(`## ${file.path} — ${file.status}`, '')
    if (file.status === 'changed') {
      lines.push(`- 行差异：-${file.removedCount} / +${file.addedCount}`, '')
      if (file.removed.length) lines.push('```diff', ...file.removed.map((l) => '-' + l), '```', '')
      if (file.added.length) lines.push('```diff', ...file.added.map((l) => '+' + l), '```', '')
    } else {
      lines.push('- ' + file.status, '')
    }
  }
  lines.push('## 判定方式', '', '对比式探测（无需人工 ground truth）：把上面的差异交给裁判子代理，按「哪个变体的产出更接近任务 T 的成功行为」给出 winner 与理由，再用 judge 参数写回。', '')
  return lines.join('\n')
}
