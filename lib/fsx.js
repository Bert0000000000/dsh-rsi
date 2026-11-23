import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 本地时间戳，精确到毫秒（C4）：YYYYMMDD-HHmmssSSS。 */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${ms}`
}

export function isoNow() {
  return new Date().toISOString()
}

export function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item'
}

export function resolveInside(base, target) {
  const resolved = path.resolve(base, target)
  const root = path.resolve(base)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界：'${target}' 不在工作区 '${base}' 内`)
  }
  return resolved
}

export function pathExists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function writeFileSafe(base, rel, content) {
  const abs = resolveInside(base, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
export function writeFileAtomic(base, rel, content) {
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

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 已存在路径取 realpath；不存在时向上找到最近的已存在祖先再拼接。 */
export function realPathOf(target) {
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

export function readJson(p) {
  if (!pathExists(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析 JSON：${p}（${error.message}）`)
  }
}

export function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function listDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function listFiles(dir) {
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

export function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

export function normalizeRel(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

export function hasDotDotSegment(rel) {
  return normalizeRel(rel).split('/').some((seg) => seg === '..' || seg === '.')
}
