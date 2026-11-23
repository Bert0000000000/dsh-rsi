import test from 'node:test'
import assert from 'node:assert/strict'
import { safeRegexTest, assertSafePattern } from '../lib/regex-safe.js'

test('safeRegexTest 正常匹配', () => {
  assert.equal(safeRegexTest('^done$', 'done'), true)
  assert.equal(safeRegexTest('^done$', 'no'), false)
})

test('嵌套量词与反向引用被拒绝', () => {
  assert.throws(() => assertSafePattern('(a+)+$'), /灾难性回溯/)
  assert.throws(() => assertSafePattern('(\\w+)*'), /灾难性回溯/)
  assert.throws(() => assertSafePattern('(a)\\1'), /灾难性回溯/)
})

test('无效正则与超长输入被拒绝', () => {
  assert.throws(() => safeRegexTest('([a-', 'x'), /正则无效/)
  assert.throws(() => safeRegexTest('a', 'a'.repeat(600 * 1024)), /输入过长/)
})
