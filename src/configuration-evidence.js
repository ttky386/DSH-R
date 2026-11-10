const MAX_FIELDS = 32
const MAX_SOURCE_BYTES = 65536
const MAX_DEPTH = 24

function own(object, key) {
  return object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined
}

/** 只读取直接环境变量表达式的存在性；不求值、不保存变量内容。 */
export function configurationEnvironment(config, environment) {
  const fields = []
  const visited = new Set()
  function visit(value, path, depth) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH || visited.has(value) || fields.length >= MAX_FIELDS) {
      return
    }
    visited.add(value)
    const expression = own(value, '__jsExpr')
    if (typeof expression === 'string') {
      const variable = /^\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(expression)?.[1]
      fields.push({ field: path, variable: variable || null, present: variable ? Object.hasOwn(environment, variable) : null })
      return
    }
    for (const key of Object.keys(value)) {
      visit(own(value, key), path ? `${path}.${key}` : key, depth + 1)
    }
  }
  visit(config, '', 0)
  return fields
}

/** 记录校验器实际读取到的字段是否缺值，不输出配置内容。 */
export function configurationField(config, field) {
  if (typeof field !== 'string' || !/^[\w.-]+$/.test(field)) {
    return { missing: null }
  }
  let value = config
  for (const key of field.split('.')) {
    value = own(value, key)
  }
  return { missing: value === undefined }
}

/** 有界词法读取：注释、字符串不构成代码；无法可靠识别的模板/正则拒绝推断。 */
function tokens(source) {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    return null
  }
  const result = []
  let index = 0
  while (index < source.length) {
    const tail = source.slice(index)
    const whitespace = /^\s+/.exec(tail)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    if (tail.startsWith('//')) {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (tail.startsWith('/*')) {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) {
        return null
      }
      index = end + 2
      continue
    }
    if (tail[0] === '`' || tail[0] === '/') {
      return null
    }
    if (tail[0] === '"' || tail[0] === "'") {
      const match = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(tail)
      if (!match) {
        return null
      }
      result.push({ text: match[0], string: true, offset: index })
      index += match[0].length
      continue
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(tail)
    const text = identifier?.[0] || tail[0]
    result.push({ text, offset: index })
    index += text.length
  }
  return result
}

/** 仅证明直接 Service 子类的构造声明，绝不执行构造或当作已注册服务。 */
export function declaredService(plugin, serviceClass) {
  if (typeof plugin !== 'function' || typeof serviceClass !== 'function' || Object.getPrototypeOf(plugin) !== serviceClass) {
    return null
  }
  const source = Function.prototype.toString.call(plugin)
  const parts = tokens(source)
  if (!parts || parts[0]?.text !== 'class') {
    return null
  }
  let depth = 0
  let constructor = -1
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].text === 'constructor' && depth === 1 && parts[index + 1]?.text === '(') {
      if (constructor >= 0) {
        return null
      }
      constructor = index
    }
    if (parts[index].text === '{') {
      depth += 1
    } else if (parts[index].text === '}') {
      depth -= 1
    }
  }
  if (constructor < 0 || !/^[A-Za-z_$][\w$]*$/.test(parts[constructor + 2]?.text || '')) {
    return null
  }
  const context = parts[constructor + 2].text
  const opening = parts.findIndex((part, index) => index > constructor && part.text === '{')
  if (opening < 0) {
    return null
  }
  depth = 1
  let declaration = null
  for (let index = opening + 1; index < parts.length && depth; index += 1) {
    const token = parts[index]
    if (token.text === 'super' && parts[index + 1]?.text === '(') {
      const previous = parts[index - 1]?.text
      const value = parts[index + 4]
      if (declaration || depth !== 1 || ![';', '{', '}'].includes(previous) || parts.slice(opening + 1, index).some(part => part.text === context) || parts[index + 2]?.text !== context || parts[index + 3]?.text !== ',' || !value?.string || !/^["'][A-Za-z_][\w.-]*["']$/.test(value.text) || parts[index + 5]?.text !== ')' || parts[index + 6]?.text !== ';') {
        return null
      }
      declaration = { service: value.text.slice(1, -1), source: 'loaded_constructor_declaration', offset: token.offset, sourceText: source }
    }
    if (token.text === '{') {
      depth += 1
    } else if (token.text === '}') {
      depth -= 1
    }
  }
  return declaration
}

/** 官方合成结果必须与本次运行时摘要一致；逐层配置替换才构成来源证据。 */
export function configurationSources({ observed, composed, layers, files, compose, digest, emptyRoot, locate }) {
  const result = []
  for (const row of observed || []) {
    if (!row.configuration?.field) {
      continue
    }
    const fact = { rowId: row.id, component: row.component, field: row.configuration.field, confirmed: false, reason: '' }
    const effective = composed.filter(entry => entry.id === row.id && entry.name === row.component)
    if (!emptyRoot || effective.length !== 1 || composed.some(entry => entry.group || /(?:cordis:include|cordis-plugin-include)/.test(entry.name || '')) || digest(effective[0]) !== row.optionsDigest) {
      fact.reason = '根配置、include、覆盖层或当前有效条目与本次运行时证据尚未一致核实。'
      result.push(fact)
      continue
    }
    const writers = []
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
      for (let patchIndex = 0; patchIndex < layers[layerIndex].length; patchIndex += 1) {
        const patch = layers[layerIndex][patchIndex]
        const prefix = [...layers.slice(0, layerIndex), layers[layerIndex].slice(0, patchIndex + 1)]
        const entry = compose(prefix).filter(item => item.id === row.id && item.name === row.component)
        if (entry.length !== 1) {
          continue
        }
        const insertIndex = !patch.id && Array.isArray(patch.insert) ? patch.insert.findIndex(item => item.id === row.id && item.name === row.component) : -1
        const changesConfig = insertIndex >= 0 || (patch.id === row.id && (!patch.name || patch.name === row.component) && Object.hasOwn(patch, 'config'))
        if (changesConfig) {
          writers.push({ path: files[layerIndex][0], patchIndex, insertIndex })
        }
      }
    }
    const writer = writers.at(-1)
    if (!writer) {
      fact.reason = '没有找到实际生效配置的唯一写入层。'
    } else {
      const location = locate(writer, fact.field)
      fact.confirmed = true
      fact.source = 'current_composition_matching_attempt'
      fact.path = writer.path
      fact.line = location?.line || null
      fact.fieldDeclared = location?.fieldDeclared === true
      fact.overridden = writers.slice(0, -1).map(item => item.path)
      fact.environment = row.configuration.environment || null
      fact.missing = row.configuration.missing ?? null
      if (!location?.line) {
        fact.reason = '已确认配置来源文件；字段行号或字段显式声明未核实。'
      }
    }
    result.push(fact)
  }
  return result
}
