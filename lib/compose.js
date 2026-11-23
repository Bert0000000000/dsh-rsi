export const HARNESS_COMPONENTS = [
  'system-prompt',
  'guardrails',
  'memory',
  'skills',
  'tool-guidance',
  'scripts',
  'subagents',
  'plugins',
]

export function normalizeEdits(edits) {
  if (!Array.isArray(edits)) return []
  return edits.filter((edit) => edit && typeof edit === 'object').map((edit, index) => {
    const component = String(edit.component ?? '').trim()
    if (!HARNESS_COMPONENTS.includes(component)) {
      throw new Error(`edits[${index}].component '${component}' 未知（合法值：${HARNESS_COMPONENTS.join(' | ')}）`)
    }
    const change = String(edit.change ?? '').trim()
    if (!change) throw new Error(`edits[${index}].change 不能为空`)
    return { component, change }
  })
}

/** B3：把分解后的组件编辑合成为一份 harness 文本；无 edits 时回落到整份 harness。 */
export function composeHarness(variant) {
  const edits = normalizeEdits(variant?.edits)
  if (!edits.length) return String(variant?.harness ?? '').trim()
  const byComponent = new Map()
  for (const edit of edits) {
    const list = byComponent.get(edit.component) ?? []
    list.push(edit.change)
    byComponent.set(edit.component, list)
  }
  const lines = ['# 组合 harness（按组件合成）', '']
  for (const component of HARNESS_COMPONENTS) {
    const changes = byComponent.get(component)
    if (!changes) continue
    lines.push(`## ${component}`, '')
    changes.forEach((change) => lines.push(change, ''))
  }
  return lines.join('\n').trim()
}
