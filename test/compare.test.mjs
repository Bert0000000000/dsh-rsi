import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareTexts, compareDirs, renderCompareMarkdown } from '../lib/compare.js'

test('compareTexts 裁剪公共前后缀', () => {
  const diff = compareTexts('a\nb\nc', 'a\nx\nc')
  assert.equal(diff.identical, false)
  assert.deepEqual(diff.removed, ['b'])
  assert.deepEqual(diff.added, ['x'])
  assert.equal(compareTexts('same', 'same').identical, true)
})

test('compareDirs 汇总 only-a/only-b/changed/same', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-cmp-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-cmp-b-'))
  fs.writeFileSync(path.join(a, 'same.txt'), 'x', 'utf8')
  fs.writeFileSync(path.join(b, 'same.txt'), 'x', 'utf8')
  fs.writeFileSync(path.join(a, 'only-a.txt'), 'a', 'utf8')
  fs.writeFileSync(path.join(b, 'only-b.txt'), 'b', 'utf8')
  fs.writeFileSync(path.join(a, 'changed.txt'), 'one', 'utf8')
  fs.writeFileSync(path.join(b, 'changed.txt'), 'two', 'utf8')
  const result = compareDirs(a, b)
  assert.deepEqual(result.summary, { total: 4, onlyA: 1, onlyB: 1, changed: 1, same: 1, binary: 0 })
  const md = renderCompareMarkdown('T', a, b, result)
  assert.ok(md.includes('only-a.txt') && md.includes('changed.txt'))
  assert.ok(!md.includes('## same.txt'))
})
