/** 把作者侧参数 DSL（属性级 required: true）编译成模型端可用的 JSON Schema。 */
export function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = compileValueSpec(value)
    if (value && value.required === true) required.push(key)
  }
  return { properties, required }
}

export function compileValueSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec
  const node = {}
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required' || key === 'properties') continue
    if (key === 'items') node.items = Array.isArray(value) ? value.map(compileValueSpec) : compileValueSpec(value)
    else node[key] = value
  }
  if (spec.properties && typeof spec.properties === 'object') {
    const { properties, required } = compilePropertyMap(spec.properties)
    node.properties = properties
    if (required.length) node.required = required
  }
  return node
}

export function compileParameters(spec) {
  const { properties, required } = compilePropertyMap(spec)
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}
