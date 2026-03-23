'use strict'

// Compile a JSON Schema into a pure JS validator function.
// No eval, no new Function, CSP-safe.
// Returns null if the schema is too complex for JS compilation.

function compileToJS(schema) {
  if (typeof schema === 'boolean') {
    return schema ? () => true : () => false
  }
  if (typeof schema !== 'object' || schema === null) return null

  // Bail on features that are too complex for JS fast path
  if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf ||
      schema.not || schema.if || schema.patternProperties ||
      schema.additionalProperties === false ||
      (schema.additionalProperties && typeof schema.additionalProperties === 'object') ||
      schema.dependentRequired || schema.dependentSchemas ||
      schema.contains || schema.prefixItems || schema.uniqueItems ||
      schema.propertyNames || schema.enum || schema.const ||
      schema.$defs || schema.definitions) {
    return null
  }

  const checks = []

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    checks.push(buildTypeCheck(types))
  }

  // required
  if (schema.required && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      checks.push((d) => typeof d === 'object' && d !== null && key in d)
    }
  }

  // properties
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const propCheck = compileToJS(prop)
      if (!propCheck) return null // bail if sub-schema too complex
      checks.push((d) => {
        if (typeof d !== 'object' || d === null || !(key in d)) return true
        return propCheck(d[key])
      })
    }
  }

  // items
  if (schema.items) {
    const itemCheck = compileToJS(schema.items)
    if (!itemCheck) return null
    checks.push((d) => {
      if (!Array.isArray(d)) return true
      for (let i = 0; i < d.length; i++) {
        if (!itemCheck(d[i])) return false
      }
      return true
    })
  }

  // numeric
  if (schema.minimum !== undefined) {
    const min = schema.minimum
    checks.push((d) => typeof d !== 'number' || d >= min)
  }
  if (schema.maximum !== undefined) {
    const max = schema.maximum
    checks.push((d) => typeof d !== 'number' || d <= max)
  }
  if (schema.exclusiveMinimum !== undefined) {
    const min = schema.exclusiveMinimum
    checks.push((d) => typeof d !== 'number' || d > min)
  }
  if (schema.exclusiveMaximum !== undefined) {
    const max = schema.exclusiveMaximum
    checks.push((d) => typeof d !== 'number' || d < max)
  }
  if (schema.multipleOf !== undefined) {
    const div = schema.multipleOf
    checks.push((d) => typeof d !== 'number' || d % div === 0)
  }

  // string
  if (schema.minLength !== undefined) {
    const min = schema.minLength
    checks.push((d) => typeof d !== 'string' || d.length >= min)
  }
  if (schema.maxLength !== undefined) {
    const max = schema.maxLength
    checks.push((d) => typeof d !== 'string' || d.length <= max)
  }
  if (schema.pattern) {
    try {
      const re = new RegExp(schema.pattern)
      checks.push((d) => typeof d !== 'string' || re.test(d))
    } catch {
      return null
    }
  }

  // format — hand-written fast checks
  if (schema.format) {
    const fc = FORMAT_CHECKS[schema.format]
    if (fc) checks.push((d) => typeof d !== 'string' || fc(d))
  }

  // array size
  if (schema.minItems !== undefined) {
    const min = schema.minItems
    checks.push((d) => !Array.isArray(d) || d.length >= min)
  }
  if (schema.maxItems !== undefined) {
    const max = schema.maxItems
    checks.push((d) => !Array.isArray(d) || d.length <= max)
  }

  // object size
  if (schema.minProperties !== undefined) {
    const min = schema.minProperties
    checks.push((d) => typeof d !== 'object' || d === null || Object.keys(d).length >= min)
  }
  if (schema.maxProperties !== undefined) {
    const max = schema.maxProperties
    checks.push((d) => typeof d !== 'object' || d === null || Object.keys(d).length <= max)
  }

  if (checks.length === 0) return () => true
  if (checks.length === 1) return checks[0]

  // Flatten to a single function — V8 JIT will inline
  return (data) => {
    for (let i = 0; i < checks.length; i++) {
      if (!checks[i](data)) return false
    }
    return true
  }
}

function buildTypeCheck(types) {
  if (types.length === 1) {
    return TYPE_CHECKS[types[0]] || (() => true)
  }
  const fns = types.map(t => TYPE_CHECKS[t]).filter(Boolean)
  return (d) => {
    for (let i = 0; i < fns.length; i++) {
      if (fns[i](d)) return true
    }
    return false
  }
}

const TYPE_CHECKS = {
  string: (d) => typeof d === 'string',
  number: (d) => typeof d === 'number' && isFinite(d),
  integer: (d) => Number.isInteger(d),
  boolean: (d) => typeof d === 'boolean',
  null: (d) => d === null,
  array: (d) => Array.isArray(d),
  object: (d) => typeof d === 'object' && d !== null && !Array.isArray(d),
}

const FORMAT_CHECKS = {
  email: (s) => { const at = s.indexOf('@'); return at > 0 && at < s.length - 1 && s.indexOf('.', at) > at + 1 },
  date: (s) => s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s),
  uuid: (s) => s.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => { const p = s.split('.'); return p.length === 4 && p.every(n => { const v = +n; return v >= 0 && v <= 255 && String(v) === n }) },
  hostname: (s) => s.length > 0 && s.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(s),
}

// --- Codegen mode: generates a single Function (NOT CSP-safe) ---
// This matches ajv's approach: one monolithic function, V8 JIT fully inlines it
function compileToJSCodegen(schema) {
  if (typeof schema === 'boolean') return schema ? () => true : () => false
  if (typeof schema !== 'object' || schema === null) return null
  if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf ||
      schema.not || schema.if || schema.patternProperties ||
      schema.dependentRequired || schema.dependentSchemas ||
      schema.contains || schema.prefixItems || schema.uniqueItems ||
      schema.propertyNames || schema.enum || schema.const ||
      schema.$defs || schema.definitions) return null

  const lines = []
  genCode(schema, 'd', lines)
  if (lines.length === 0) return () => true

  const body = lines.join('\n  ') + '\n  return true'
  try {
    return new Function('d', body)
  } catch {
    return null
  }
}

function genCode(schema, v, lines) {
  if (typeof schema !== 'object' || schema === null) return

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  if (types) {
    const conds = types.map(t => {
      switch (t) {
        case 'object': return `(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
        case 'array': return `Array.isArray(${v})`
        case 'string': return `typeof ${v}==='string'`
        case 'number': return `(typeof ${v}==='number'&&isFinite(${v}))`
        case 'integer': return `Number.isInteger(${v})`
        case 'boolean': return `typeof ${v}==='boolean'`
        case 'null': return `${v}===null`
        default: return 'true'
      }
    })
    lines.push(`if(!(${conds.join('||')}))return false`)
  }

  if (schema.required) {
    for (const key of schema.required) {
      lines.push(`if(typeof ${v}!=='object'||${v}===null||!('${esc(key)}' in ${v}))return false`)
    }
  }

  if (schema.minimum !== undefined) lines.push(`if(typeof ${v}==='number'&&${v}<${schema.minimum})return false`)
  if (schema.maximum !== undefined) lines.push(`if(typeof ${v}==='number'&&${v}>${schema.maximum})return false`)
  if (schema.exclusiveMinimum !== undefined) lines.push(`if(typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum})return false`)
  if (schema.exclusiveMaximum !== undefined) lines.push(`if(typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum})return false`)
  if (schema.minLength !== undefined) lines.push(`if(typeof ${v}==='string'&&${v}.length<${schema.minLength})return false`)
  if (schema.maxLength !== undefined) lines.push(`if(typeof ${v}==='string'&&${v}.length>${schema.maxLength})return false`)
  if (schema.minItems !== undefined) lines.push(`if(Array.isArray(${v})&&${v}.length<${schema.minItems})return false`)
  if (schema.maxItems !== undefined) lines.push(`if(Array.isArray(${v})&&${v}.length>${schema.maxItems})return false`)

  if (schema.pattern) {
    lines.push(`if(typeof ${v}==='string'&&!/${schema.pattern.replace(/\//g, '\\/')}/.test(${v}))return false`)
  }

  if (schema.additionalProperties === false && schema.properties) {
    const allowed = Object.keys(schema.properties).map(k => `'${esc(k)}'`).join(',')
    lines.push(`if(typeof ${v}==='object'&&${v}!==null){const _k=Object.keys(${v});const _a=new Set([${allowed}]);for(let _i=0;_i<_k.length;_i++)if(!_a.has(_k[_i]))return false}`)
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const pv = `${v}['${esc(key)}']`
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&'${esc(key)}' in ${v}){`)
      genCode(prop, pv, lines)
      lines.push(`}`)
    }
  }

  if (schema.items) {
    lines.push(`if(Array.isArray(${v})){for(let _j=0;_j<${v}.length;_j++){const _e=${v}[_j]`)
    genCode(schema.items, '_e', lines)
    lines.push(`}}`)
  }
}

function esc(s) { return s.replace(/'/g, "\\'").replace(/\\/g, '\\\\') }

module.exports = { compileToJS, compileToJSCodegen }
