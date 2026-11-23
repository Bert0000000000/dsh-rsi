import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateItem, validateRubric, aggregateVariant } from '../lib/rubric.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-rubric-'))
}

test('evaluateItem 覆盖 file-exists/line-count/contains/regex', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'result.txt'), 'done\nline2\n', 'utf8')
  assert.equal(evaluateItem({ kind: 'file-exists', path: 'result.txt' }, dir).ok, true)
  assert.equal(evaluateItem({ kind: 'file-exists', path: 'missing.txt' }, dir).ok, false)
  assert.equal(evaluateItem({ kind: 'line-count', path: 'result.txt', min: 2 }, dir).ok, true)
  assert.equal(evaluateItem({ kind: 'line-count', path: 'result.txt', min: 5 }, dir).ok, false)
  assert.equal(evaluateItem({ kind: 'contains', path: 'result.txt', pattern: 'line2' }, dir).ok, true)
  assert.equal(evaluateItem({ kind: 'regex-all-lines', path: 'result.txt', pattern: '^\\w' }, dir).ok, true)
  assert.equal(evaluateItem({ kind: 'regex-all-lines', path: 'result.txt', pattern: '^done' }, dir).ok, false)
  assert.equal(evaluateItem({ kind: 'regex-last-line', path: 'result.txt', pattern: 'line2' }, dir).ok, true)
})

test('evaluateItem command 判定退出码与输出', () => {
  const dir = tempDir()
  const ok = evaluateItem({ kind: 'command', run: 'node --version', pattern: 'v\\d+' }, dir)
  assert.equal(ok.ok, true, ok.detail)
  const badExit = evaluateItem({ kind: 'command', run: 'node -e "process.exit(3)"', expectExit: 3 }, dir)
  assert.equal(badExit.ok, true, badExit.detail)
  const wrong = evaluateItem({ kind: 'command', run: 'node -e "process.exit(0)"', expectExit: 2 }, dir)
  assert.equal(wrong.ok, false)
  const noPattern = evaluateItem({ kind: 'command', run: 'node -e "console.log(1)"', pattern: 'zzz' }, dir)
  assert.equal(noPattern.ok, false)
})

test('evaluateItem 空文件与未知 kind 判失败', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'empty.txt'), '   ', 'utf8')
  assert.equal(evaluateItem({ kind: 'file-exists', path: 'empty.txt' }, dir).ok, false)
  assert.equal(evaluateItem({ kind: 'contains', path: 'empty.txt', pattern: 'x' }, dir).ok, false)
  assert.equal(evaluateItem({ kind: 'nope', path: 'empty.txt' }, dir).ok, false)
})

test('validateRubric 拒绝非法 passScore/minPassRate/command', () => {
  assert.throws(() => validateRubric({ passScore: 0, items: [{ kind: 'manual' }] }), /passScore/)
  assert.throws(() => validateRubric({ items: [{ kind: 'manual' }], minPassRate: 2 }), /minPassRate/)
  assert.throws(() => validateRubric({ items: [{ kind: 'bogus' }] }), /kind/)
  assert.throws(() => validateRubric({ items: [{ kind: 'command' }] }), /run/)
  assert.ok(validateRubric({ items: [{ kind: 'command', run: 'node --version' }] }))
})

test('aggregateVariant 按重复次数统计 passRate 与均值', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'r1'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'r2'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'r3'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'r1', 'result.txt'), 'done', 'utf8')
  fs.writeFileSync(path.join(dir, 'r2', 'result.txt'), 'done', 'utf8')
  const items = [{ id: 'c', kind: 'contains', path: 'result.txt', pattern: 'done', weight: 2 }]
  const result = aggregateVariant({
    label: 'v1', dirName: '1-v1', probeDir: dir, plannedRepeats: 3, items,
    passScore: 2, hasPassScore: true, minPassRate: 1,
  })
  assert.equal(result.executed, 2)
  assert.equal(result.allExecuted, false)
  assert.equal(result.passRate, 0.667)
  assert.equal(result.mean, 1.333)
  assert.equal(result.passed, false)
  assert.equal(result.repeatRows.length, 3)
  assert.equal(result.repeatRows[2].executed, false)
  const relaxed = aggregateVariant({
    label: 'v1', dirName: '1-v1', probeDir: dir, plannedRepeats: 3, items,
    passScore: 2, hasPassScore: true, minPassRate: 0.6,
  })
  assert.equal(relaxed.passed, false, '执行次数不齐必须判失败')
})

test('aggregateVariant 兼容旧布局（无 r<k> 子目录）', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'result.txt'), 'done', 'utf8')
  const result = aggregateVariant({
    label: 'legacy', dirName: '1-legacy', probeDir: dir, plannedRepeats: 1,
    items: [{ kind: 'contains', path: 'result.txt', pattern: 'done' }],
    passScore: 1, hasPassScore: true, minPassRate: 1,
  })
  assert.equal(result.executed, 1)
  assert.equal(result.passed, true)
})
