import fs from 'node:fs'
import path from 'node:path'

const IGNORED_DIRS = new Set(['.git', '.rsi', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache'])
const MAX_FILES = 20000

/** C2：按 mtime 扫描 plan 之后的写入，用于发现 probe 越界写工作区。 */
export function scanWrites(cwd, sinceIso, options = {}) {
  const since = Date.parse(String(sinceIso ?? ''))
  const ignored = new Set([...(options.ignoreDirs ?? []), ...IGNORED_DIRS])
  const maxFiles = Number(options.maxFiles) || MAX_FILES
  const hits = []
  let scanned = 0
  let truncated = false
  const walk = (dir, depth) => {
    if (truncated || depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue
        walk(path.join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      if (scanned > maxFiles) {
        truncated = true
        return
      }
      const abs = path.join(dir, entry.name)
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (Number.isFinite(since) && stat.mtimeMs > since) {
        hits.push({
          path: path.relative(cwd, abs).replace(/\\/g, '/'),
          mtime: new Date(stat.mtimeMs).toISOString(),
          bytes: stat.size,
        })
      }
    }
  }
  walk(cwd, 0)
  hits.sort((a, b) => String(a.mtime).localeCompare(String(b.mtime)))
  return { since: Number.isFinite(since) ? new Date(since).toISOString() : '', scanned, truncated, hits }
}
