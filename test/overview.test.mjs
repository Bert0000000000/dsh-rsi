import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGlobalOverview } from '../lib/overview.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-overview-'))
const wsA = join(root, 'workspace-a')
const wsB = join(root, 'workspace-b')

function seedWorkspace(workspace, evidenceLines, lessons) {
  mkdirSync(join(workspace, '.rsi', 'evidence'), { recursive: true })
  mkdirSync(join(workspace, '.rsi', 'memory'), { recursive: true })
  writeFileSync(join(workspace, '.rsi', 'evidence', 'events.jsonl'), evidenceLines.join('\n') + '\n')
  writeFileSync(join(workspace, '.rsi', 'memory', 'harness-lessons.md'), lessons)
}

seedWorkspace(wsA, [
  JSON.stringify({ ts: '2026-11-25T00:00:00Z', source: 'tool-error', tool: 'rsi-plan' }),
  JSON.stringify({ ts: '2026-11-25T00:01:00Z', source: 'feedback' }),
], '# 全局教训\n\n## A1\nbody a1\n\n## A2\nbody a2\n')

seedWorkspace(wsB, [
  JSON.stringify({ ts: '2026-11-25T00:02:00Z', source: 'agent-error' }),
], '# 全局教训\n\n## B1\nbody b1\n')

after(() => rmSync(root, { recursive: true, force: true }))

test('readGlobalOverview 合并多个工作区，并排除没有 .rsi 的候选', async () => {
  const result = await readGlobalOverview([wsA, wsB, join(root, 'missing')])
  assert.equal(result.scope, 'global')
  assert.equal(result.exists, true)
  assert.equal(result.summary.workspaces, 2)
  assert.equal(result.summary.evidence.count, 3)
  assert.equal(result.summary.evidence.files, 2)
  assert.equal(result.summary.lessons.count, 3)
  assert.equal(result.workspaces.length, 2)
  assert.deepEqual(result.workspaces.map((item) => item.name).sort(), ['workspace-a', 'workspace-b'])
  assert.ok(result.workspaces.every((item) => item.exists === true))
  assert.ok(result.evidence.items.every((item) => typeof item.workspace === 'string' && item.workspace.length > 0))
  assert.ok(result.lessons.items.every((item) => typeof item.workspace === 'string' && item.workspace.length > 0))
})

test('readGlobalOverview 对空候选返回 no-global-workspace', async () => {
  const result = await readGlobalOverview([])
  assert.equal(result.summary.workspaces, 0)
  assert.equal(result.workspaces.length, 0)
  assert.equal(result.summary.evidence.count, 0)
  assert.equal(result.summary.lessons.count, 0)
})
