import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, truncateEvidence, safeJson } from '../lib/redact.js'

test('redactSecrets 覆盖常见密钥形态', () => {
  const cases = [
    'sk-abcdefghijklmnopqrst',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwx',
    'Bearer abcdefghijklmnop',
    'password=hunter2hunter2',
  ]
  for (const value of cases) {
    const out = redactSecrets('前缀 ' + value + ' 后缀')
    assert.ok(out.includes('[REDACTED:'), value + ' 未被脱敏：' + out)
    assert.ok(!out.includes(value), value + ' 仍残留')
  }
})

test('truncateEvidence 先脱敏再截断', () => {
  const out = truncateEvidence('sk-abcdefghijklmnopqrst ' + 'x'.repeat(600))
  assert.ok(out.includes('[REDACTED:openai-key]'))
  assert.ok(out.includes('截断'))
})

test('safeJson 不抛错', () => {
  const circular = {}
  circular.self = circular
  assert.equal(safeJson(circular), '[无法序列化]')
})
