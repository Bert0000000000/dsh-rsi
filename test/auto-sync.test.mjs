import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The ledger directory is derived from os.homedir() when lib/overview.js is
// imported. Point that at a throwaway home before the dynamic import so the
// test never touches the real ~/.dsh/rsi.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-home-'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-ws-'))
process.env.USERPROFILE = home
process.env.HOME = home
fs.mkdirSync(path.join(workspace, '.rsi', 'memory'), { recursive: true })
fs.writeFileSync(
  path.join(workspace, '.rsi', 'memory', 'harness-lessons.md'),
  '## lesson one\nfirst lesson body\n',
  'utf8',
)

const { apply } = await import('../index.js')

test('successful rsi-lesson auto-syncs the lesson into the global ledger', async () => {
  const handlers = new Map()
  const session = { id: 'session-1' }
  const ctx = {
    tools: { register() {} },
    on(name, fn) { handlers.set(name, fn) },
    sessions: { get(id) { return id === 'session-1' ? session : null } },
    workingDirectory: { get(value) { return value === session ? workspace : null } },
  }

  apply(ctx)
  const onResult = handlers.get('tools/result')
  assert.equal(typeof onResult, 'function', 'tools/result handler registered')

  onResult(
    { name: 'rsi-lesson', agent: session, arguments: { title: 'lesson one' } },
    { isError: false },
  )

  const ledger = path.join(home, '.dsh', 'rsi', 'ledger.json')
  for (let i = 0; i < 60 && !fs.existsSync(ledger); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(ledger), 'ledger.json should be written')

  const data = JSON.parse(fs.readFileSync(ledger, 'utf8'))
  assert.equal(data.lessons.length, 1)
  assert.equal(data.lessons[0].title, 'lesson one')
  assert.deepEqual(data.lessons[0].sources, [workspace])
  assert.ok(fs.existsSync(path.join(home, '.dsh', 'rsi', 'lessons.md')))
})
