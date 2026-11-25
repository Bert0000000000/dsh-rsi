import test from 'node:test'
import assert from 'node:assert/strict'
import { registerOverview } from '../lib/overview-server.js'

test('registerOverview 注册只读的 prefix 路由', () => {
  let captured = null
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({
        webServer: {
          register(options) {
            captured = options
            return () => {}
          },
        },
        effect(fn) {
          return fn()
        },
      })
    },
  }
  registerOverview(ctx)
  assert.ok(captured)
  assert.equal(captured.kind, 'prefix')
  assert.equal(captured.path, '/rsi-overview/api')
  assert.equal(captured.auth, 'required')
  assert.equal(typeof captured.handler, 'function')
})

test('registerOverview 在缺少 inject 的空 ctx 上不抛错', () => {
  assert.doesNotThrow(() => registerOverview({}))
  assert.doesNotThrow(() => registerOverview(null))
})
