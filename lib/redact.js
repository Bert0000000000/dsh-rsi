import { truncateText } from './text.js'

export const EVIDENCE_TRUNCATE = 500

// 只做模式级脱敏：宁可多盖，不把密钥写进 .rsi/evidence。
const SECRET_RULES = [
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  { kind: 'credential-assignment', re: /\b(api[_-]?key|access[_-]?token|secret|password|passwd|token)\b\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{8,}/gi },
]

export function redactSecrets(value) {
  let text = String(value ?? '')
  for (const rule of SECRET_RULES) text = text.replace(rule.re, `[REDACTED:${rule.kind}]`)
  return text
}

export function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[无法序列化]'
  }
}

/** 脱敏 + 截断，用于所有写入证据库的自由文本。 */
export function truncateEvidence(value) {
  return truncateText(redactSecrets(value), EVIDENCE_TRUNCATE)
}
