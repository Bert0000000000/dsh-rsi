import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stamp, slug, resolveInside, normalizeRel, hasDotDotSegment } from '../lib/fsx.js'

test('stamp 精确到毫秒', () => {
  const value = stamp(new Date(2026, 0, 2, 3, 4, 5, 6))
  assert.equal(value, '20260102-030405006')
})

test('slug 只保留安全字符', () => {
  assert.equal(slug('候选规则 A'), '候选规则-a')
  assert.equal(slug('  '), 'item')
})

test('resolveInside 拒绝越界', () => {
  const root = path.resolve('/tmp/ws')
  assert.throws(() => resolveInside(root, '../evil.md'), /路径越界/)
  assert.equal(resolveInside(root, 'a/b.md'), path.resolve(root, 'a/b.md'))
})

test('normalizeRel/hasDotDotSegment 识别逃逸写法', () => {
  assert.equal(normalizeRel('.\\a\\b.md'), 'a/b.md')
  assert.equal(hasDotDotSegment('.rsi/../evil.md'), true)
  assert.equal(hasDotDotSegment('.rsi/memory/x.md'), false)
})
