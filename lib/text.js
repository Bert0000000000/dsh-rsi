export function truncateText(value, limit) {
  const s = String(value ?? '')
  return s.length > limit ? `${s.slice(0, limit)}…(截断,共${s.length}字符)` : s
}
