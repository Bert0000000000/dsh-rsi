import vm from 'node:vm'

export const MAX_REGEX_INPUT = 512 * 1024
export const MAX_PATTERN_LENGTH = 1000
export const REGEX_TIMEOUT_MS = 250

// 粗略的灾难性回溯特征：括号内量词再叠加量词、或反向引用
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*{]/
const BACKREFERENCE = /\\[1-9]/

export function assertSafePattern(pattern) {
  const p = String(pattern ?? '')
  if (!p) return p
  if (p.length > MAX_PATTERN_LENGTH) {
    throw new Error(`正则过长（${p.length} > ${MAX_PATTERN_LENGTH} 字符），拒绝执行`)
  }
  if (NESTED_QUANTIFIER.test(p) || BACKREFERENCE.test(p)) {
    throw new Error(`正则疑似灾难性回溯（嵌套量词或反向引用），拒绝执行：/${p.slice(0, 80)}/`)
  }
  try {
    new RegExp(p)
  } catch (error) {
    throw new Error(`正则无效：${error instanceof Error ? error.message : String(error)}`)
  }
  return p
}

/** 在 vm 里带超时执行正则（C5）。超时抛错，由调用方判失败而不是挂死。 */
export function safeRegexTest(pattern, text, timeoutMs = REGEX_TIMEOUT_MS) {
  const p = assertSafePattern(pattern)
  const input = String(text ?? '')
  if (input.length > MAX_REGEX_INPUT) {
    throw new Error(`正则输入过长（${input.length} > ${MAX_REGEX_INPUT} 字符），拒绝执行`)
  }
  const context = vm.createContext({ source: p, input, matched: false })
  try {
    vm.runInContext('matched = new RegExp(source).test(input)', context, { timeout: timeoutMs })
  } catch (error) {
    if (error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`正则执行超时（>${timeoutMs}ms）：/${p.slice(0, 80)}/`)
    }
    throw error
  }
  return context.matched === true
}
