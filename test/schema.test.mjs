import test from 'node:test'
import assert from 'node:assert/strict'
import { compileParameters } from '../lib/schema.js'

test('compileParameters 把属性级 required 提升为根级数组', () => {
  const out = compileParameters({
    cwd: { type: 'string', required: true, description: '工作区' },
    limit: { type: 'number' },
    variants: {
      type: 'array',
      required: true,
      items: { type: 'object', properties: { label: { type: 'string', required: true } } },
    },
  })
  assert.equal(out.type, 'object')
  assert.deepEqual(out.required, ['cwd', 'variants'])
  assert.equal(out.properties.cwd.required, undefined)
  assert.equal(out.properties.variants.items.type, 'object')
  assert.deepEqual(out.properties.variants.items.required, ['label'])
  assert.ok(!JSON.stringify(out).includes('"required":true'))
})
