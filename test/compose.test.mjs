import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEdits, composeHarness, HARNESS_COMPONENTS } from '../lib/compose.js'

test('normalizeEdits 校验组件名与改动', () => {
  assert.throws(() => normalizeEdits([{ component: 'nope', change: 'x' }]), /未知/)
  assert.throws(() => normalizeEdits([{ component: 'memory', change: ' ' }]), /change/)
  assert.equal(normalizeEdits([{ component: 'memory', change: '记事实' }]).length, 1)
})

test('composeHarness 按组件合成，无 edits 时回落整份 harness', () => {
  assert.equal(composeHarness({ harness: '原规则' }), '原规则')
  const text = composeHarness({ edits: [{ component: 'memory', change: 'A' }, { component: 'guardrails', change: 'B' }] })
  assert.ok(text.indexOf('## guardrails') < text.indexOf('## memory'), '按固定组件顺序输出')
  assert.ok(text.includes('A') && text.includes('B'))
  assert.equal(HARNESS_COMPONENTS.length, 8)
})
