import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-it-'))
}

function makeCtx(overrides = {}) {
  const tools = new Map()
  const handlers = new Map()
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    on(name, fn) { handlers.set(name, fn) },
    sessions: { get() { return null } },
    workingDirectory: { get() { return null } },
    ...overrides,
  }
  apply(ctx)
  return { tools, handlers }
}

async function call(tools, name, args) {
  const tool = tools.get(name)
  assert.ok(tool, '工具未注册：' + name)
  return tool.execute(args)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('12 个工具全部注册且参数是合法 JSON Schema', () => {
  const { tools } = makeCtx()
  const names = [...tools.keys()].sort()
  assert.deepEqual(names, ['rsi-adopt', 'rsi-archive', 'rsi-audit', 'rsi-collect', 'rsi-compare', 'rsi-evidence', 'rsi-lesson', 'rsi-plan', 'rsi-propose', 'rsi-review', 'rsi-run', 'rsi-status'].sort())
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object', name)
    assert.ok(tool.parameters.properties, name)
    const text = JSON.stringify(tool.parameters)
    assert.ok(!text.includes('"required":true'), name + ' 残留属性级 required')
    if (tool.parameters.required) {
      assert.ok(Array.isArray(tool.parameters.required), name + ' required 必须是数组')
      for (const key of tool.parameters.required) assert.ok(key in tool.parameters.properties, name + ' required 键必须存在属性')
    }
  }
})

test('plan → 重复执行 → collect 全链路（含 command 评分项）', async () => {
  const cwd = workspace()
  const { tools } = makeCtx()
  const plan = await call(tools, 'rsi-plan', {
    cwd,
    runId: 'it-run',
    task: '写 result.txt 内容为 done',
    repeats: 2,
    budget: 10,
    variants: [
      { label: 'base', harness: '无附加规则' },
      { label: 'cand', edits: [{ component: 'memory', change: '先记事实再动手' }] },
    ],
    rubric: {
      passScore: 2,
      minPassRate: 1,
      items: [
        { id: 'content', kind: 'contains', path: 'result.txt', pattern: 'done', weight: 2 },
        { id: 'node', kind: 'command', run: 'node --version', pattern: 'v\\d+', weight: 1 },
      ],
    },
  })
  assert.equal(plan.repeats, 2)
  assert.equal(plan.totalProbes, 4)
  const runDir = path.join(cwd, '.rsi', 'runs', 'it-run')
  assert.ok(fs.existsSync(path.join(runDir, 'variants', '2-cand', 'edits.json')))
  const config = readJson(path.join(runDir, 'config.json'))
  assert.equal(config.repeats, 2)
  assert.equal(config.mode, 'parallel')
  assert.equal(config.budget, 10)
  assert.equal(config.rubricRuleVersion, 3)
  assert.ok(config.meta && typeof config.meta.node === 'string')
  assert.ok(plan.instructions.includes('第 1/2 次') && plan.instructions.includes('parallel')
    , '指令应包含重复次数与模式')

  const write = (variant, repeat, content) => {
    const dir = path.join(runDir, 'probes', variant, 'r' + repeat)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'result.txt'), content, 'utf8')
  }
  write('1-base', 1, 'done')
  write('1-base', 2, 'done')
  write('2-cand', 1, 'done plus extra')

  const collect = await call(tools, 'rsi-collect', { cwd, runId: 'it-run' })
  assert.equal(collect.repeats, 2)
  assert.equal(collect.hasPassScore, true)
  assert.equal(collect.passed, false)
  assert.deepEqual(collect.failedVariants, ['cand'])
  const baseVariant = collect.variants.find((v) => v.label === 'base')
  assert.equal(baseVariant.executed, 2)
  assert.equal(baseVariant.passed, true)
  assert.equal(baseVariant.passRate, 1)
  const cand = collect.variants.find((v) => v.label === 'cand')
  assert.equal(cand.executed, 1)
  assert.equal(cand.passRate, 0.5)
  assert.equal(cand.passed, false, '重复次数不齐必须失败')
  const report = readJson(path.join(runDir, 'report.json'))
  assert.equal(report.repeats, 2)
  assert.ok(fs.existsSync(path.join(runDir, 'report.md')))

  const run = await call(tools, 'rsi-run', { cwd, runId: 'it-run' })
  assert.ok(run.note.includes('重复 2 次'))
  assert.ok(run.instructions.includes('第 2/2 次'), '缺跑的重复应给出补跑指令')

  const compare = await call(tools, 'rsi-compare', { cwd, runId: 'it-run', a: 'base', b: 'cand', repeat: 1 })
  assert.equal(compare.summary.changed, 1)
  assert.equal(compare.judge, null)
  assert.ok(fs.existsSync(compare.comparePath))
  const judged = await call(tools, 'rsi-compare', {
    cwd, runId: 'it-run', a: 'base', b: 'cand', repeat: 1,
    judge: { winner: 'a', reason: 'base 更简洁', confidence: 0.8 },
  })
  assert.equal(judged.judge.winner, 'a')
  const compareJson = readJson(path.join(path.dirname(judged.comparePath), 'compare.json'))
  assert.equal(compareJson.judge.winner, 'a')
})

test('plan 拒绝超预算与非法组件编辑', async () => {
  const cwd = workspace()
  const { tools } = makeCtx()
  await assert.rejects(call(tools, 'rsi-plan', {
    cwd, runId: 'over', task: 't', repeats: 9, budget: 5,
    variants: [{ label: 'a' }, { label: 'b' }],
  }), /预算不足/)
  await assert.rejects(call(tools, 'rsi-plan', {
    cwd, runId: 'bad-edit', task: 't', variants: [{ label: 'a', edits: [{ component: 'nope', change: 'x' }] }],
  }), /未知/)
})

test('archive/restore 与索引血缘', async () => {
  const cwd = workspace()
  const { tools } = makeCtx()
  await call(tools, 'rsi-plan', { cwd, runId: 'parent-run', task: 't', repeats: 1, variants: [{ label: 'a' }], budget: 5 })
  await call(tools, 'rsi-plan', { cwd, runId: 'child-run', task: 't', repeats: 1, parent: 'parent-run', variants: [{ label: 'a' }], budget: 5 })
  const list = await call(tools, 'rsi-archive', { cwd, action: 'list' })
  assert.equal(list.runs.length, 2)
  const archived = await call(tools, 'rsi-archive', { cwd, action: 'archive', runId: 'parent-run' })
  assert.ok(fs.existsSync(archived.path))
  assert.ok(!fs.existsSync(path.join(cwd, '.rsi', 'runs', 'parent-run')))
  const run = await call(tools, 'rsi-run', { cwd, runId: 'child-run' })
  assert.ok(run.runs[0].parent === 'parent-run' || run.runs[0].parent === '')
  const restored = await call(tools, 'rsi-archive', { cwd, action: 'restore', runId: 'parent-run' })
  assert.ok(fs.existsSync(path.join(cwd, '.rsi', 'runs', 'parent-run')))
  assert.ok(restored.path.includes('parent-run'))
})

test('audit 发现 run 目录之外的写入', async () => {
  const cwd = workspace()
  const { tools } = makeCtx()
  await call(tools, 'rsi-plan', { cwd, runId: 'audit-run', task: 't', repeats: 1, variants: [{ label: 'a' }], budget: 5 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(path.join(cwd, 'outside.md'), '# 越界写入\n', 'utf8')
  const audit = await call(tools, 'rsi-audit', { cwd, runId: 'audit-run' })
  assert.ok(audit.hits.some((hit) => hit.path === 'outside.md'), JSON.stringify(audit.hits))
  assert.equal(audit.hits.every((hit) => !hit.path.startsWith('.rsi/')), true)
})

test('adopt 冒烟失败自动回滚，成功后不可重复采纳', async () => {
  const cwd = workspace()
  const { tools } = makeCtx()
  const proposal = await call(tools, 'rsi-propose', {
    cwd,
    title: '记录失败模式',
    hypothesis: '每次任务前先看教训库',
    changes: [{ file: '.rsi/memory/good.js', description: '加一行', before: '', after: 'export const ok = 1' }],
    basedOnEvidence: 'evidence: tool-error ×3',
  })
  await assert.rejects(call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: 'AGENTS.md', content: 'x' }],
  }), /只有 approved/)
  await call(tools, 'rsi-review', { cwd, action: 'approve', proposalId: proposal.proposalId, note: '通过' })
  await assert.rejects(call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: '.rsi/bundles/x.js', content: 'x' }],
  }), /白名单/)
  await assert.rejects(call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: '.rsi/memory/bad.js', content: 'const x = ;' }],
  }), /冒烟校验失败/)
  assert.equal(fs.existsSync(path.join(cwd, '.rsi', 'memory', 'bad.js')), false, '语法错误文件应被回滚')
  await assert.rejects(call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: '.rsi/memory/good.js', content: 'export const ok = 1\n' }],
    smoke: { command: 'node -e "process.exit(1)"' },
  }), /冒烟命令失败/)
  assert.equal(fs.existsSync(path.join(cwd, '.rsi', 'memory', 'good.js')), false)
  const adopted = await call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: '.rsi/memory/good.js', content: 'export const ok = 1\n' }],
  })
  assert.ok(adopted.note.includes('冒烟校验'))
  assert.ok(fs.existsSync(path.join(cwd, '.rsi', 'memory', 'good.js')))
  const review = await call(tools, 'rsi-review', { cwd, action: 'list' })
  assert.equal(review.proposals[0].status, 'applied')
  await assert.rejects(call(tools, 'rsi-adopt', {
    cwd, mode: 'workspace', evidence: 'e', proposalId: proposal.proposalId,
    files: [{ path: '.rsi/memory/good.js', content: 'export const ok = 2\n' }],
  }), /只有 approved/)
})

test('证据钩子会脱敏密钥', async () => {
  const cwd = workspace()
  const { handlers } = makeCtx({
    sessions: { get: () => ({ id: 's1' }) },
    workingDirectory: { get: () => cwd },
  })
  const onToolResult = handlers.get('tools/result')
  assert.ok(onToolResult, '缺少 tools/result 钩子')
  onToolResult(
    { agent: { session: { id: 's1' } }, name: 'run_code', arguments: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop"' } },
    { isError: true, error: { message: '失败：sk-abcdefghijklmnopqrst' } },
  )
  const dir = path.join(cwd, '.rsi', 'evidence')
  const file = path.join(dir, fs.readdirSync(dir)[0])
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('[REDACTED:'), text)
  assert.ok(!text.includes('sk-abcdefghijklmnopqrst'))
  assert.ok(!text.includes('abcdefghijklmnop'))
})
