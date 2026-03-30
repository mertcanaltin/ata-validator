'use strict'

// Compile a JSON Schema into a pure JS validator function.
// Closure-based validator — no new Function() or eval().
// Returns null if the schema is too complex for JS compilation.

function compileToJS(schema, defs, schemaMap) {
  if (typeof schema === 'boolean') {
    return schema ? () => true : () => false
  }
  if (typeof schema !== 'object' || schema === null) return null

  // Bail if schema has edge cases that JS fast path gets wrong
  if (!defs && !codegenSafe(schema, schemaMap)) return null

  // Collect $defs early so sub-schemas can resolve $ref
  const rootDefs = defs || collectDefs(schema)

  // Bail on features that are too complex for JS fast path
  if (schema.patternProperties ||
      schema.dependentSchemas ||
      schema.propertyNames) {
    return null
  }

  const checks = []

  // $ref (local only)
  if (schema.$ref) {
    const refFn = resolveRef(schema.$ref, rootDefs, schemaMap)
    if (!refFn) return null
    checks.push(refFn)
  }

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    checks.push(buildTypeCheck(types))
  }

  // enum
  if (schema.enum) {
    const vals = schema.enum
    const primitives = vals.filter(v => v === null || typeof v !== 'object')
    const objects = vals.filter(v => v !== null && typeof v === 'object')
    const primSet = new Set(primitives.map(v => v === null ? 'null' : typeof v === 'string' ? 's:' + v : 'n:' + v))
    const objStrs = objects.map(v => JSON.stringify(v))
    checks.push((d) => {
      // Fast primitive check
      const key = d === null ? 'null' : typeof d === 'string' ? 's:' + d : typeof d === 'number' || typeof d === 'boolean' ? 'n:' + d : null
      if (key !== null && primSet.has(key)) return true
      // Slow object check
      const ds = JSON.stringify(d)
      for (let i = 0; i < objStrs.length; i++) {
        if (ds === objStrs[i]) return true
      }
      // Also check primitives by stringify for edge cases (boolean in enum)
      for (let i = 0; i < primitives.length; i++) {
        if (d === primitives[i]) return true
      }
      return false
    })
  }

  // const
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      checks.push((d) => d === cv)
    } else {
      const cs = JSON.stringify(cv)
      checks.push((d) => JSON.stringify(d) === cs)
    }
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
      const propCheck = compileToJS(prop, rootDefs)
      if (!propCheck) return null // bail if sub-schema too complex
      checks.push((d) => {
        if (typeof d !== 'object' || d === null || !(key in d)) return true
        return propCheck(d[key])
      })
    }
  }

  // additionalProperties
  if (schema.additionalProperties !== undefined && schema.properties) {
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties))
      checks.push((d) => {
        if (typeof d !== 'object' || d === null || Array.isArray(d)) return true
        const keys = Object.keys(d)
        for (let i = 0; i < keys.length; i++) {
          if (!allowed.has(keys[i])) return false
        }
        return true
      })
    } else if (typeof schema.additionalProperties === 'object') {
      const apCheck = compileToJS(schema.additionalProperties, rootDefs)
      if (!apCheck) return null
      const known = new Set(Object.keys(schema.properties || {}))
      checks.push((d) => {
        if (typeof d !== 'object' || d === null || Array.isArray(d)) return true
        const keys = Object.keys(d)
        for (let i = 0; i < keys.length; i++) {
          if (!known.has(keys[i]) && !apCheck(d[keys[i]])) return false
        }
        return true
      })
    }
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      checks.push((d) => {
        if (typeof d !== 'object' || d === null || !(key in d)) return true
        for (let i = 0; i < deps.length; i++) {
          if (!(deps[i] in d)) return false
        }
        return true
      })
    }
  }

  // items
  if (schema.items) {
    const itemCheck = compileToJS(schema.items, rootDefs)
    if (!itemCheck) return null
    checks.push((d) => {
      if (!Array.isArray(d)) return true
      for (let i = 0; i < d.length; i++) {
        if (!itemCheck(d[i])) return false
      }
      return true
    })
  }

  // prefixItems
  if (schema.prefixItems) {
    const prefixChecks = []
    for (const ps of schema.prefixItems) {
      const pc = compileToJS(ps, rootDefs)
      if (!pc) return null
      prefixChecks.push(pc)
    }
    checks.push((d) => {
      if (!Array.isArray(d)) return true
      for (let i = 0; i < prefixChecks.length && i < d.length; i++) {
        if (!prefixChecks[i](d[i])) return false
      }
      return true
    })
  }

  // contains
  if (schema.contains) {
    const containsCheck = compileToJS(schema.contains, rootDefs)
    if (!containsCheck) return null
    const minC = schema.minContains !== undefined ? schema.minContains : 1
    const maxC = schema.maxContains !== undefined ? schema.maxContains : Infinity
    checks.push((d) => {
      if (!Array.isArray(d)) return true
      let count = 0
      for (let i = 0; i < d.length; i++) {
        if (containsCheck(d[i])) count++
      }
      return count >= minC && count <= maxC
    })
  }

  // uniqueItems — sorted-key canonical form for correct object comparison
  if (schema.uniqueItems) {
    const canonical = (x) => {
      if (x === null || typeof x !== 'object') return typeof x + ':' + x
      if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']'
      return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'
    }
    checks.push((d) => {
      if (!Array.isArray(d)) return true
      const seen = new Set()
      for (let i = 0; i < d.length; i++) {
        const key = canonical(d[i])
        if (seen.has(key)) return false
        seen.add(key)
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

  // allOf
  if (schema.allOf) {
    const subs = []
    for (const s of schema.allOf) {
      const fn = compileToJS(s, rootDefs)
      if (!fn) return null
      subs.push(fn)
    }
    checks.push((d) => {
      for (let i = 0; i < subs.length; i++) {
        if (!subs[i](d)) return false
      }
      return true
    })
  }

  // anyOf
  if (schema.anyOf) {
    const subs = []
    for (const s of schema.anyOf) {
      const fn = compileToJS(s, rootDefs)
      if (!fn) return null
      subs.push(fn)
    }
    checks.push((d) => {
      for (let i = 0; i < subs.length; i++) {
        if (subs[i](d)) return true
      }
      return false
    })
  }

  // oneOf
  if (schema.oneOf) {
    const subs = []
    for (const s of schema.oneOf) {
      const fn = compileToJS(s, rootDefs)
      if (!fn) return null
      subs.push(fn)
    }
    checks.push((d) => {
      let count = 0
      for (let i = 0; i < subs.length; i++) {
        if (subs[i](d)) count++
        if (count > 1) return false
      }
      return count === 1
    })
  }

  // not
  if (schema.not) {
    const notFn = compileToJS(schema.not, rootDefs)
    if (!notFn) return null
    checks.push((d) => !notFn(d))
  }

  // if/then/else
  if (schema.if) {
    const ifFn = compileToJS(schema.if, rootDefs)
    if (!ifFn) return null
    const thenFn = schema.then ? compileToJS(schema.then, rootDefs) : null
    const elseFn = schema.else ? compileToJS(schema.else, rootDefs) : null
    if (schema.then && !thenFn) return null
    if (schema.else && !elseFn) return null
    checks.push((d) => {
      if (ifFn(d)) {
        return thenFn ? thenFn(d) : true
      } else {
        return elseFn ? elseFn(d) : true
      }
    })
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

function collectDefs(schema) {
  const defs = {}
  const raw = schema.$defs || schema.definitions
  if (raw && typeof raw === 'object') {
    for (const [name, def] of Object.entries(raw)) {
      // Lazy compile with circular guard — return true (permissive) on cycle
      let cached = undefined
      defs[name] = {
        get fn() {
          if (cached === undefined) {
            cached = null // sentinel: compilation in progress
            cached = compileToJS(def, defs)
          }
          // cached===null means circular ref or compile failure — be permissive
          return cached || (() => true)
        },
        raw: def
      }
    }
  }
  return defs
}

function resolveRef(ref, defs, schemaMap) {
  // 1. Local ref
  if (defs) {
    const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m) {
      const name = m[1]
      const entry = defs[name]
      if (entry) return (d) => { const fn = entry.fn; return fn ? fn(d) : true }
    }
  }
  // 2. Cross-schema ref
  if (schemaMap && schemaMap.has(ref)) {
    const resolved = schemaMap.get(ref)
    const fn = compileToJS(resolved, null, schemaMap)
    return fn || (() => true)
  }
  return null
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

// Dangerous JS property names that exist on Object.prototype
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'])

// Recursively check if a schema can be safely compiled to JS codegen.
// Returns false if any sub-schema contains features codegen gets wrong.
function codegenSafe(schema, schemaMap) {
  if (typeof schema === 'boolean') return true
  if (typeof schema !== 'object' || schema === null) return true

  // Boolean sub-schemas anywhere cause bail — codegen doesn't handle schema=false correctly
  if (schema.items === false || schema.items === true) return false
  if (schema.additionalProperties === true) return true // permissive — fine
  if (schema.properties) {
    for (const v of Object.values(schema.properties)) {
      if (typeof v === 'boolean') return false
      if (!codegenSafe(v, schemaMap)) return false
    }
  }

  // Keys that collide with Object.prototype
  if (schema.required) {
    for (const k of schema.required) {
      if (UNSAFE_KEYS.has(k)) return false
    }
  }
  if (schema.properties) {
    for (const k of Object.keys(schema.properties)) {
      if (UNSAFE_KEYS.has(k)) return false
      if (k === '$ref') return false // property named "$ref" — confusing
    }
  }

  // Unicode property escapes in pattern need 'u' flag — codegen uses RegExp without it
  if (schema.pattern && /\\[pP]\{/.test(schema.pattern)) return false

  // $ref — allow local refs (#/$defs/Name) and non-local refs if in schemaMap
  if (schema.$ref) {
    const isLocal = /^#\/(?:\$defs|definitions)\/[^/]+$/.test(schema.$ref)
    const isResolvable = !isLocal && schemaMap && schemaMap.has(schema.$ref)
    if (!isLocal && !isResolvable) return false
    // Bail if $ref has sibling keywords (complex interaction)
    const siblings = Object.keys(schema).filter(k => k !== '$ref' && k !== '$defs' && k !== 'definitions' && k !== '$schema' && k !== '$id')
    if (siblings.length > 0) return false
  }

  // additionalProperties as schema — bail entirely, too many edge cases with allOf interaction
  if (typeof schema.additionalProperties === 'object') return false
  if (schema.additionalProperties === false && !schema.properties) return false

  // propertyNames: false — codegen doesn't handle this
  if (schema.propertyNames === false) return false

  // Check $defs: targets must be safe, names must be simple, no nested $ref chains
  const defs = schema.$defs || schema.definitions
  if (defs) {
    for (const [name, def] of Object.entries(defs)) {
      if (/[~/"']/.test(name)) return false // special chars in def name
      if (typeof def === 'boolean') return false
      if (typeof def === 'object' && def !== null) {
        if (def.$id) return false // $id in $defs creates new resolution scope — bail
        if (def.$ref) return false // nested ref chain — bail
        if (!codegenSafe(def, schemaMap)) return false
      }
    }
  }

  // Recurse into sub-schemas — bail on boolean schemas in any position
  const subs = [
    schema.items, schema.contains, schema.not,
    schema.if, schema.then, schema.else,
    ...(schema.prefixItems || []),
    ...(schema.allOf || []),
    ...(schema.anyOf || []),
    ...(schema.oneOf || []),
  ]
  if (typeof schema.additionalProperties === 'object') subs.push(schema.additionalProperties)
  for (const s of subs) {
    if (s === undefined || s === null) continue
    if (typeof s === 'boolean') return false // boolean sub-schema
    if (!codegenSafe(s, schemaMap)) return false
  }

  return true
}

// --- Codegen mode: generates a single Function (NOT CSP-safe) ---
// This matches ajv's approach: one monolithic function, V8 JIT fully inlines it
function compileToJSCodegen(schema, schemaMap) {
  if (typeof schema === 'boolean') return schema ? () => true : () => false
  if (typeof schema !== 'object' || schema === null) return null

  // Bail if schema contains features that codegen can't handle correctly
  if (!codegenSafe(schema, schemaMap)) return null

  // Collect defs for $ref resolution
  const rootDefs = schema.$defs || schema.definitions || null

  // Bail only on truly unsupported features
  // patternProperties: bail only on boolean sub-schemas or unicode property escapes
  if (schema.patternProperties) {
    for (const [pat, sub] of Object.entries(schema.patternProperties)) {
      if (typeof sub === 'boolean') return null
      if (/\\[pP]\{/.test(pat)) return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  // dependentSchemas: bail on boolean sub-schemas
  if (schema.dependentSchemas) {
    for (const sub of Object.values(schema.dependentSchemas)) {
      if (typeof sub === 'boolean') return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  // propertyNames: only codegen simple string constraints
  if (schema.propertyNames) {
    if (typeof schema.propertyNames === 'boolean') return null
    const pn = schema.propertyNames
    const supported = ['maxLength', 'minLength', 'pattern', 'const', 'enum']
    const keys = Object.keys(pn).filter(k => k !== '$schema')
    if (keys.some(k => !supported.includes(k))) return null
  }

  const ctx = { varCounter: 0, helpers: [], helperCode: [], closureVars: [], closureVals: [], rootDefs, refStack: new Set(), schemaMap: schemaMap || null }
  const lines = []
  genCode(schema, 'd', lines, ctx)
  if (lines.length === 0) return () => true

  // Append deferred checks (additionalProperties) at the end
  if (ctx.deferredChecks) {
    for (const dc of ctx.deferredChecks) lines.push(dc)
  }

  const checkStr = lines.join('\n  ')

  // Regex and helpers are passed as closure variables (not re-created per call)
  const closureNames = ctx.closureVars
  const closureValues = ctx.closureVals

  // Pre-create regex objects once
  for (const code of ctx.helperCode) {
    const match = code.match(/^const (_re\d+)=new RegExp\((.+)\)$/)
    if (match) {
      closureNames.push(match[1])
      closureValues.push(new RegExp(JSON.parse(match[2])))
    }
  }

  const body = checkStr + '\n  return true'

  try {
    let boolFn
    if (closureNames.length > 0) {
      const factory = new Function(...closureNames, `return function(d){${body}}`)
      boolFn = factory(...closureValues)
    } else {
      boolFn = new Function('d', body)
    }

    // Build hybrid: same body, return R instead of true, return E(d) instead of false.
    const hybridBody = replaceTopLevel(checkStr + '\n  return R')
    try {
      const hybridFactory = new Function(...closureNames, 'R', 'E', `return function(d){${hybridBody}}`)
      boolFn._hybridFactory = (R, E) => hybridFactory(...closureValues, R, E)
    } catch {}

    // Store source for standalone compilation (includes regex inline for file output)
    const helperStr = ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : ''
    boolFn._source = helperStr + body
    boolFn._hybridSource = helperStr + hybridBody

    return boolFn
  } catch {
    return null
  }
}

// Replace top-level `return false` → `return E(d)` and `return true` → `return R`.
// Tracks function nesting depth to preserve nested function internals.
function replaceTopLevel(code) {
  let fnDepth = 0, result = '', i = 0
  while (i < code.length) {
    if (code.startsWith('function', i) && (i === 0 || /[^a-zA-Z_$]/.test(code[i - 1]))) {
      // Found a nested function — skip to opening brace, track all braces inside
      let j = i + 8
      while (j < code.length && code[j] !== '{') j++
      result += code.slice(i, j + 1)
      i = j + 1
      // Track braces inside this function body
      let braceDepth = 1
      while (i < code.length && braceDepth > 0) {
        if (code[i] === '{') braceDepth++
        else if (code[i] === '}') braceDepth--
        if (braceDepth > 0) result += code[i]
        else result += '}'  // closing brace of function
        i++
      }
    } else if (code.startsWith('return false', i)) {
      result += 'return E(d)'
      i += 12
    } else if (code.startsWith('return true', i) && (i + 11 >= code.length || !/[a-zA-Z_$]/.test(code[i + 11]))) {
      result += 'return R'
      i += 11
    } else {
      result += code[i]
      i++
    }
  }
  return result
}

// knownType: if parent already verified the type, skip redundant guards.
// 'object' = we know v is a non-null non-array object
// 'array'  = we know v is an array
// 'string' / 'number' / 'integer' = we know the primitive type
function genCode(schema, v, lines, ctx, knownType) {
  if (typeof schema !== 'object' || schema === null) return

  // $ref — guard against circular references
  if (schema.$ref) {
    // 1. Local ref
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCode(ctx.rootDefs[m[1]], v, lines, ctx, knownType)
      ctx.refStack.delete(schema.$ref)
      return
    }
    // 2. Cross-schema ref
    if (ctx.schemaMap && ctx.schemaMap.has(schema.$ref)) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCode(ctx.schemaMap.get(schema.$ref), v, lines, ctx, knownType)
      ctx.refStack.delete(schema.$ref)
      return
    }
    return
  }

  // Determine the single known type after this schema's type check
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  let effectiveType = knownType
  if (types) {
    if (!knownType) {
      // Emit the type check
      const conds = types.map(t => {
        switch (t) {
          case 'object': return `(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
          case 'array': return `Array.isArray(${v})`
          case 'string': return `typeof ${v}==='string'`
          case 'number': return `(typeof ${v}==='number'&&isFinite(${v}))`
          case 'integer': return `Number.isInteger(${v})`
          case 'boolean': return `(${v}===true||${v}===false)`
          case 'null': return `${v}===null`
          default: return 'true'
        }
      })
      lines.push(`if(!(${conds.join('||')}))return false`)
    }
    // If single type, downstream checks can skip guards
    if (types.length === 1) effectiveType = types[0]
  }

  const isObj = effectiveType === 'object'
  const isArr = effectiveType === 'array'
  const isStr = effectiveType === 'string'
  const isNum = effectiveType === 'number' || effectiveType === 'integer'
  const objGuard = isObj ? '' : `typeof ${v}==='object'&&${v}!==null&&`
  const objCheck = isObj ? '' : `if(typeof ${v}!=='object'||${v}===null)return false;`

  // enum
  if (schema.enum) {
    const vals = schema.enum
    const primitives = vals.filter(v => v === null || typeof v !== 'object')
    const objects = vals.filter(v => v !== null && typeof v === 'object')
    const primChecks = primitives.map(p => `${v}===${JSON.stringify(p)}`).join('||')
    const objChecks = objects.map(o => `JSON.stringify(${v})===${JSON.stringify(JSON.stringify(o))}`).join('||')
    const allChecks = [primChecks, objChecks].filter(Boolean).join('||')
    lines.push(`if(!(${allChecks || 'false'}))return false`)
  }

  // const
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      lines.push(`if(${v}!==${JSON.stringify(cv)})return false`)
    } else {
      lines.push(`if(JSON.stringify(${v})!==${JSON.stringify(JSON.stringify(cv))})return false`)
    }
  }

  // Collect required keys so property checks can skip 'in' guard
  const requiredSet = new Set(schema.required || [])

  // required: skip explicit check if property has a type constraint
  // (type check on undefined returns false anyway: Number.isInteger(undefined) === false)
  const hoisted = {} // key -> access expression
  if (schema.required && schema.properties && isObj) {
    const reqChecks = []
    for (const key of schema.required) {
      hoisted[key] = `${v}[${JSON.stringify(key)}]`
      const prop = schema.properties[key]
      const hasTypeCheck = prop && (prop.type || prop.enum || prop.const !== undefined)
      if (!hasTypeCheck) {
        reqChecks.push(`${v}[${JSON.stringify(key)}]===undefined`)
      }
    }
    if (reqChecks.length > 0) {
      lines.push(`if(${reqChecks.join('||')})return false`)
    }
  } else if (schema.required) {
    if (isObj) {
      const checks = schema.required.map(key => `${v}[${JSON.stringify(key)}]===undefined`)
      lines.push(`if(${checks.join('||')})return false`)
    } else {
      for (const key of schema.required) {
        lines.push(`if(typeof ${v}!=='object'||${v}===null||!(${JSON.stringify(key)} in ${v}))return false`)
      }
    }
  }

  // numeric — skip type guard if known numeric
  if (schema.minimum !== undefined) lines.push(isNum ? `if(${v}<${schema.minimum})return false` : `if(typeof ${v}==='number'&&${v}<${schema.minimum})return false`)
  if (schema.maximum !== undefined) lines.push(isNum ? `if(${v}>${schema.maximum})return false` : `if(typeof ${v}==='number'&&${v}>${schema.maximum})return false`)
  if (schema.exclusiveMinimum !== undefined) lines.push(isNum ? `if(${v}<=${schema.exclusiveMinimum})return false` : `if(typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum})return false`)
  if (schema.exclusiveMaximum !== undefined) lines.push(isNum ? `if(${v}>=${schema.exclusiveMaximum})return false` : `if(typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum})return false`)
  if (schema.multipleOf !== undefined) lines.push(isNum ? `if(${v}%${schema.multipleOf}!==0)return false` : `if(typeof ${v}==='number'&&${v}%${schema.multipleOf}!==0)return false`)

  // string — skip type guard if known string
  if (schema.minLength !== undefined) lines.push(isStr ? `if(${v}.length<${schema.minLength})return false` : `if(typeof ${v}==='string'&&${v}.length<${schema.minLength})return false`)
  if (schema.maxLength !== undefined) lines.push(isStr ? `if(${v}.length>${schema.maxLength})return false` : `if(typeof ${v}==='string'&&${v}.length>${schema.maxLength})return false`)

  // array size — skip guard if known array
  if (schema.minItems !== undefined) lines.push(isArr ? `if(${v}.length<${schema.minItems})return false` : `if(Array.isArray(${v})&&${v}.length<${schema.minItems})return false`)
  if (schema.maxItems !== undefined) lines.push(isArr ? `if(${v}.length>${schema.maxItems})return false` : `if(Array.isArray(${v})&&${v}.length>${schema.maxItems})return false`)

  // object size
  if (schema.minProperties !== undefined) lines.push(`if(${objGuard}Object.keys(${v}).length<${schema.minProperties})return false`)
  if (schema.maxProperties !== undefined) lines.push(`if(${objGuard}Object.keys(${v}).length>${schema.maxProperties})return false`)

  if (schema.pattern) {
    // Use RegExp constructor via helper to avoid injection from untrusted patterns
    const ri = ctx.varCounter++
    ctx.helperCode.push(`const _re${ri}=new RegExp(${JSON.stringify(schema.pattern)})`)
    lines.push(isStr ? `if(!_re${ri}.test(${v}))return false` : `if(typeof ${v}==='string'&&!_re${ri}.test(${v}))return false`)
  }

  if (schema.format) {
    const fc = FORMAT_CODEGEN[schema.format]
    if (fc) lines.push(fc(v, isStr))
  }

  // uniqueItems — tiered strategy based on expected array size
  if (schema.uniqueItems) {
    const si = ctx.varCounter++
    const itemType = schema.items && typeof schema.items === 'object' && schema.items.type
    const isPrimItems = itemType === 'string' || itemType === 'number' || itemType === 'integer'
    const maxItems = schema.maxItems
    // Small primitive arrays (maxItems <= 16): nested loop is 6x faster than Set
    // No allocation, no hash computation — just direct === comparison
    const inner = isPrimItems && maxItems && maxItems <= 16
      ? `for(let _i=1;_i<${v}.length;_i++){for(let _k=0;_k<_i;_k++){if(${v}[_i]===${v}[_k])return false}}`
      : isPrimItems
        ? `const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){if(_s${si}.has(${v}[_i]))return false;_s${si}.add(${v}[_i])}`
        : `const _cn${si}=function(x){if(x===null||typeof x!=='object')return typeof x+':'+x;if(Array.isArray(x))return'['+x.map(_cn${si}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+_cn${si}(x[k])}).join(',')+'}'};const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){const _k=_cn${si}(${v}[_i]);if(_s${si}.has(_k))return false;_s${si}.add(_k)}`
    lines.push(isArr ? `{${inner}}` : `if(Array.isArray(${v})){${inner}}`)
  }

  // additionalProperties -- deferred to end of function for better V8 optimization
  // (type checks run first in hot path, expensive prop count check last)
  // Skip if patternProperties is present — it will handle additionalProperties in a unified loop
  if (schema.additionalProperties === false && schema.properties && !schema.patternProperties) {
    const propCount = Object.keys(schema.properties).length
    const allRequired = schema.required && schema.required.length === propCount
    const inner = allRequired
      ? `var _n=0;for(var _k in ${v})_n++;if(_n!==${propCount})return false`
      : `for(var _k in ${v})if(${Object.keys(schema.properties).map(k => `_k!==${JSON.stringify(k)}`).join('&&')})return false`
    if (!ctx.deferredChecks) ctx.deferredChecks = []
    ctx.deferredChecks.push(isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      const depChecks = deps.map(d => `!('${esc(d)}' in ${v})`).join('||')
      lines.push(`if(${objGuard}'${esc(key)}' in ${v}&&(${depChecks}))return false`)
    }
  }

  // patternProperties
  if (schema.patternProperties) {
    const ppEntries = Object.entries(schema.patternProperties)
    if (schema.additionalProperties === false && schema.properties) {
      // Unified loop: validate matching patterns and reject keys not in properties or patterns
      ctx._ppHandledAdditional = true
      const allowedProps = new Set(Object.keys(schema.properties))
      const pi = ctx.varCounter++
      // Build closure vars for each pattern regex
      const reVars = []
      for (const [pat] of ppEntries) {
        const ri = ctx.varCounter++
        ctx.closureVars.push(`_re${ri}`)
        ctx.closureVals.push(new RegExp(pat))
        reVars.push(`_re${ri}`)
      }
      const allowedSet = `_as${pi}`
      ctx.closureVars.push(allowedSet)
      ctx.closureVals.push(allowedProps)
      // Generate sub-schema validators for each pattern — compile once as closure vars
      for (let i = 0; i < ppEntries.length; i++) {
        const [, sub] = ppEntries[i]
        const subLines = []
        genCode(sub, `_ppv`, subLines, ctx)
        const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
        const fnVar = `_ppf${pi}_${i}`
        ctx.closureVars.push(fnVar)
        ctx.closureVals.push(new Function('_ppv', fnBody))
      }
      // Emit the unified for..in loop — no per-call allocation
      const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
      lines.push(`${guard}{for(const _ppk${pi} in ${v}){`)
      lines.push(`let _ppm${pi}=${allowedSet}.has(_ppk${pi})`)
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${reVars[i]}.test(_ppk${pi})){_ppm${pi}=true;if(!_ppf${pi}_${i}(${v}[_ppk${pi}]))return false}`)
      }
      lines.push(`if(!_ppm${pi})return false`)
      lines.push(`}}`)
    } else {
      // No additionalProperties: just validate keys that match each pattern
      const pi = ctx.varCounter++
      const reVars = []
      for (const [pat] of ppEntries) {
        const ri = ctx.varCounter++
        ctx.closureVars.push(`_re${ri}`)
        ctx.closureVals.push(new RegExp(pat))
        reVars.push(`_re${ri}`)
      }
      for (let i = 0; i < ppEntries.length; i++) {
        const [, sub] = ppEntries[i]
        const subLines = []
        genCode(sub, `_ppv`, subLines, ctx)
        const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
        const fnVar = `_ppf${pi}_${i}`
        ctx.closureVars.push(fnVar)
        ctx.closureVals.push(new Function('_ppv', fnBody))
      }
      const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
      lines.push(`${guard}{for(const _ppk${pi} in ${v}){`)
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${reVars[i]}.test(_ppk${pi})&&!_ppf${pi}_${i}(${v}[_ppk${pi}]))return false`)
      }
      lines.push(`}}`)
    }
  }

  // dependentSchemas
  if (schema.dependentSchemas) {
    for (const [key, depSchema] of Object.entries(schema.dependentSchemas)) {
      const guard = isObj ? '' : `typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&`
      lines.push(`if(${guard}${JSON.stringify(key)} in ${v}){`)
      genCode(depSchema, v, lines, ctx, effectiveType)
      lines.push(`}`)
    }
  }

  // propertyNames — validate string constraints on each key
  if (schema.propertyNames && typeof schema.propertyNames === 'object') {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
    lines.push(`${guard}{for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) lines.push(`if(_k${ki}.length<${pn.minLength})return false`)
    if (pn.maxLength !== undefined) lines.push(`if(_k${ki}.length>${pn.maxLength})return false`)
    if (pn.pattern) {
      const ri = ctx.varCounter++
      ctx.closureVars.push(`_re${ri}`)
      ctx.closureVals.push(new RegExp(pn.pattern))
      lines.push(`if(!_re${ri}.test(_k${ki}))return false`)
    }
    if (pn.const !== undefined) lines.push(`if(_k${ki}!==${JSON.stringify(pn.const)})return false`)
    if (pn.enum) {
      const ei = ctx.varCounter++
      ctx.closureVars.push(`_es${ei}`)
      ctx.closureVals.push(new Set(pn.enum))
      lines.push(`if(!_es${ei}.has(_k${ki}))return false`)
    }
    lines.push(`}}`)
  }

  // properties — use hoisted vars for required props, hoist optional to locals too
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (requiredSet.has(key) && isObj) {
        // Required + type:object — property exists, use destructured local
        genCode(prop, hoisted[key] || `${v}[${JSON.stringify(key)}]`, lines, ctx)
      } else if (isObj) {
        // Optional — hoist to local, check undefined
        const oi = ctx.varCounter++
        const local = `_o${oi}`
        lines.push(`{const ${local}=${v}[${JSON.stringify(key)}];if(${local}!==undefined){`)
        genCode(prop, local, lines, ctx)
        lines.push(`}}`)
      } else {
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}){`)
        genCode(prop, `${v}[${JSON.stringify(key)}]`, lines, ctx)
        lines.push(`}`)
      }
    }
  }

  // items — pass known type info to children
  if (schema.items) {
    const idx = `_j${ctx.varCounter}`
    const elem = `_e${ctx.varCounter}`
    ctx.varCounter++
    lines.push(isArr
      ? `for(let ${idx}=0;${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`
      : `if(Array.isArray(${v})){for(let ${idx}=0;${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`)
    genCode(schema.items, elem, lines, ctx)
    lines.push(isArr ? `}` : `}}`)
  }

  // prefixItems
  if (schema.prefixItems) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const elem = `_p${ctx.varCounter}_${i}`
      lines.push(isArr
        ? `if(${v}.length>${i}){const ${elem}=${v}[${i}]`
        : `if(Array.isArray(${v})&&${v}.length>${i}){const ${elem}=${v}[${i}]`)
      genCode(schema.prefixItems[i], elem, lines, ctx)
      lines.push(`}`)
    }
    ctx.varCounter++
  }

  // contains — use helper function to avoid try/catch overhead
  if (schema.contains) {
    const ci = ctx.varCounter++
    const minC = schema.minContains !== undefined ? schema.minContains : 1
    const maxC = schema.maxContains !== undefined ? schema.maxContains : Infinity
    const subLines = []
    genCode(schema.contains, `_cv`, subLines, ctx)
    const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
    const guard = isArr ? '' : `if(!Array.isArray(${v})){}else `
    lines.push(`${guard}{const _cf${ci}=function(_cv){${fnBody}};let _cc${ci}=0`)
    lines.push(`for(let _ci${ci}=0;_ci${ci}<${v}.length;_ci${ci}++){if(_cf${ci}(${v}[_ci${ci}]))_cc${ci}++}`)
    if (maxC === Infinity) {
      lines.push(`if(_cc${ci}<${minC})return false}`)
    } else {
      lines.push(`if(_cc${ci}<${minC}||_cc${ci}>${maxC})return false}`)
    }
  }

  // allOf — pass known type through
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      genCode(sub, v, lines, ctx, effectiveType)
    }
  }

  // anyOf — need function wrappers since genCode uses return false
  if (schema.anyOf) {
    const fns = []
    for (let i = 0; i < schema.anyOf.length; i++) {
      const subLines = []
      genCode(schema.anyOf[i], '_av', subLines, ctx)
      if (subLines.length === 0) {
        fns.push(`function(_av){return true}`)
      } else {
        fns.push(`function(_av){${subLines.join(';')};return true}`)
      }
    }
    const fi = ctx.varCounter++
    lines.push(`{const _af${fi}=[${fns.join(',')}];let _am${fi}=false;for(let _ai=0;_ai<_af${fi}.length;_ai++){if(_af${fi}[_ai](${v})){_am${fi}=true;break}}if(!_am${fi})return false}`)
  }

  // oneOf
  if (schema.oneOf) {
    const fns = []
    for (let i = 0; i < schema.oneOf.length; i++) {
      const subLines = []
      genCode(schema.oneOf[i], '_ov', subLines, ctx)
      if (subLines.length === 0) {
        fns.push(`function(_ov){return true}`)
      } else {
        fns.push(`function(_ov){${subLines.join(';')};return true}`)
      }
    }
    const fi = ctx.varCounter++
    lines.push(`{const _of${fi}=[${fns.join(',')}];let _oc${fi}=0;for(let _oi=0;_oi<_of${fi}.length;_oi++){if(_of${fi}[_oi](${v}))_oc${fi}++;if(_oc${fi}>1)return false}if(_oc${fi}!==1)return false}`)
  }

  // not
  if (schema.not) {
    const subLines = []
    genCode(schema.not, '_nv', subLines, ctx)
    if (subLines.length === 0) {
      lines.push(`return false`) // not:{} means nothing is valid
    } else {
      const fi = ctx.varCounter++
      lines.push(`{const _nf${fi}=(function(_nv){${subLines.join(';')};return true});if(_nf${fi}(${v}))return false}`)
    }
  }

  // if/then/else
  if (schema.if) {
    const ifLines = []
    genCode(schema.if, '_iv', ifLines, ctx)
    const fi = ctx.varCounter++
    const ifFn = ifLines.length === 0
      ? `function(_iv){return true}`
      : `function(_iv){${ifLines.join(';')};return true}`

    let thenFn = 'null', elseFn = 'null'
    if (schema.then) {
      const thenLines = []
      genCode(schema.then, '_tv', thenLines, ctx)
      thenFn = thenLines.length === 0
        ? `function(_tv){return true}`
        : `function(_tv){${thenLines.join(';')};return true}`
    }
    if (schema.else) {
      const elseLines = []
      genCode(schema.else, '_ev', elseLines, ctx)
      elseFn = elseLines.length === 0
        ? `function(_ev){return true}`
        : `function(_ev){${elseLines.join(';')};return true}`
    }
    lines.push(`{const _if${fi}=${ifFn};const _th${fi}=${thenFn};const _el${fi}=${elseFn}`)
    lines.push(`if(_if${fi}(${v})){if(_th${fi}&&!_th${fi}(${v}))return false}else{if(_el${fi}&&!_el${fi}(${v}))return false}}`)
  }
}

const FORMAT_CODEGEN = {
  email: (v, isStr) => {
    const guard = isStr ? '' : `typeof ${v}==='string'&&`
    return isStr
      ? `{const _at=${v}.indexOf('@');if(_at<=0||_at>=${v}.length-1||${v}.indexOf('.',_at)<=_at+1)return false}`
      : `if(typeof ${v}==='string'){const _at=${v}.indexOf('@');if(_at<=0||_at>=${v}.length-1||${v}.indexOf('.',_at)<=_at+1)return false}`
  },
  date: (v, isStr) => isStr
    ? `if(${v}.length!==10||!/^\\d{4}-\\d{2}-\\d{2}$/.test(${v}))return false`
    : `if(typeof ${v}==='string'&&(${v}.length!==10||!/^\\d{4}-\\d{2}-\\d{2}$/.test(${v})))return false`,
  uuid: (v, isStr) => isStr
    ? `if(${v}.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(${v}))return false`
    : `if(typeof ${v}==='string'&&(${v}.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(${v})))return false`,
  'date-time': (v, isStr) => isStr
    ? `if(!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/.test(${v})||isNaN(Date.parse(${v})))return false`
    : `if(typeof ${v}==='string'&&(!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/.test(${v})||isNaN(Date.parse(${v}))))return false`,
  time: (v, isStr) => isStr
    ? `if(!/^([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$/.test(${v}))return false`
    : `if(typeof ${v}==='string'&&!/^([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$/.test(${v}))return false`,
  duration: (v, isStr) => isStr
    ? `if(!/^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+W)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$/.test(${v})||${v}==='P')return false`
    : `if(typeof ${v}==='string'&&(!/^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+W)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$/.test(${v})||${v}==='P'))return false`,
  uri: (v, isStr) => isStr
    ? `if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(${v}))return false`
    : `if(typeof ${v}==='string'&&!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(${v}))return false`,
  'uri-reference': (v, isStr) => isStr
    ? `if(${v}===''||/\\s/.test(${v}))return false`
    : `if(typeof ${v}==='string'&&(${v}===''||/\\s/.test(${v})))return false`,
  ipv4: (v, isStr) => isStr
    ? `{const _p=${v}.split('.');if(_p.length!==4||!_p.every(function(n){var x=+n;return x>=0&&x<=255&&String(x)===n}))return false}`
    : `if(typeof ${v}==='string'){const _p=${v}.split('.');if(_p.length!==4||!_p.every(function(n){var x=+n;return x>=0&&x<=255&&String(x)===n}))return false}`,
  ipv6: (v, isStr) => isStr
    ? `{const _s=${v};if(_s===''||!/^[0-9a-fA-F:]+$/.test(_s)||_s.split(':').length<3||_s.split(':').length>8)return false}`
    : `if(typeof ${v}==='string'){const _s=${v};if(_s===''||!/^[0-9a-fA-F:]+$/.test(_s)||_s.split(':').length<3||_s.split(':').length>8)return false}`,
  hostname: (v, isStr) => isStr
    ? `if(!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(${v}))return false`
    : `if(typeof ${v}==='string'&&!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(${v}))return false`,
}

// Safe key escaping: use JSON.stringify to handle all special chars (newlines, null bytes, etc.)
function esc(s) { return JSON.stringify(s).slice(1, -1) }

// --- Error-collecting codegen: same checks, but pushes errors instead of returning false ---
// Returns a function: (data, allErrors) => { valid, errors }
// Valid path is still fast — only error path does extra work.
function compileToJSCodegenWithErrors(schema, schemaMap) {
  if (typeof schema === 'boolean') {
    return schema
      ? () => ({ valid: true, errors: [] })
      : () => ({ valid: false, errors: [{ code: 'type_mismatch', path: '', message: 'schema is false' }] })
  }
  if (typeof schema !== 'object' || schema === null) return null
  if (!codegenSafe(schema, schemaMap)) return null
  if (schema.patternProperties) {
    for (const [pat, sub] of Object.entries(schema.patternProperties)) {
      if (typeof sub === 'boolean') return null
      if (/\\[pP]\{/.test(pat)) return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  if (schema.dependentSchemas) {
    for (const sub of Object.values(schema.dependentSchemas)) {
      if (typeof sub === 'boolean') return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  if (schema.propertyNames) {
    if (typeof schema.propertyNames === 'boolean') return null
    const pn = schema.propertyNames
    const supported = ['maxLength', 'minLength', 'pattern', 'const', 'enum']
    const keys = Object.keys(pn).filter(k => k !== '$schema')
    if (keys.some(k => !supported.includes(k))) return null
  }

  const ctx = { varCounter: 0, helperCode: [], rootDefs: schema.$defs || schema.definitions || null, refStack: new Set(), schemaMap: schemaMap || null }
  const lines = []
  genCodeE(schema, 'd', '', lines, ctx)
  if (lines.length === 0) return (d) => ({ valid: true, errors: [] })

  const body = `const _e=[];\n  ` +
    (ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : '') +
    lines.join('\n  ') +
    `\n  return{valid:_e.length===0,errors:_e}`
  try {
    const fn = new Function('d', '_all', body)
    fn._errSource = body
    return fn
  } catch {
    return null
  }
}

// Error-collecting code generator.
// Instead of `return false`, pushes to `_e` array and optionally early-returns.
// `_all` parameter: if falsy, return after first error.
function genCodeE(schema, v, pathExpr, lines, ctx) {
  if (typeof schema !== 'object' || schema === null) return

  // $ref — resolve local and cross-schema refs
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeE(ctx.rootDefs[m[1]], v, pathExpr, lines, ctx)
      ctx.refStack.delete(schema.$ref)
      return
    }
    if (ctx.schemaMap && ctx.schemaMap.has(schema.$ref)) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeE(ctx.schemaMap.get(schema.$ref), v, pathExpr, lines, ctx)
      ctx.refStack.delete(schema.$ref)
      return
    }
  }

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  if (types) {
    const conds = types.map(t => {
      switch (t) {
        case 'object': return `(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
        case 'array': return `Array.isArray(${v})`
        case 'string': return `typeof ${v}==='string'`
        case 'number': return `(typeof ${v}==='number'&&isFinite(${v}))`
        case 'integer': return `Number.isInteger(${v})`
        case 'boolean': return `(${v}===true||${v}===false)`
        case 'null': return `${v}===null`
        default: return 'true'
      }
    })
    const expected = types.join(', ')
    lines.push(`if(!(${conds.join('||')})){_e.push({code:'type_mismatch',path:${pathExpr||'""'},message:'expected ${expected}'});if(!_all)return{valid:false,errors:_e}}`)
  }

  // In error mode, never assume type — always guard (data may have failed type check but allErrors continues)
  const isObj = false
  const isArr = false
  const isStr = false
  const isNum = false

  const fail = (code, msg) => `_e.push({code:'${code}',path:${pathExpr||'""'},message:${msg}});if(!_all)return{valid:false,errors:_e}`

  // enum
  if (schema.enum) {
    const vals = schema.enum
    const primitives = vals.filter(v => v === null || typeof v !== 'object')
    const objects = vals.filter(v => v !== null && typeof v === 'object')
    const primChecks = primitives.map(p => `${v}===${JSON.stringify(p)}`).join('||')
    const objChecks = objects.map(o => `JSON.stringify(${v})===${JSON.stringify(JSON.stringify(o))}`).join('||')
    const allChecks = [primChecks, objChecks].filter(Boolean).join('||')
    lines.push(`if(!(${allChecks || 'false'})){${fail('enum_mismatch', "'value not in enum'")}}`)
  }

  // const — use canonical (sorted-key) comparison for objects
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      lines.push(`if(${v}!==${JSON.stringify(cv)}){${fail('const_mismatch', "'value does not match const'")}}`)
    } else {
      // Pre-compute canonical form of const value
      const ci = ctx.varCounter++
      const canonFn = `_cnE${ci}`
      ctx.helperCode.push(`const ${canonFn}=function(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return'['+x.map(${canonFn}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+${canonFn}(x[k])}).join(',')+'}'};`)
      const expected = canonFn + '(' + JSON.stringify(cv) + ')'
      lines.push(`if(${canonFn}(${v})!==${expected}){${fail('const_mismatch', "'value does not match const'")}}`)
    }
  }

  // required — no destructuring in error mode (data might not be an object)
  const requiredSet = new Set(schema.required || [])
  const hoisted = {}
  if (schema.required) {
    for (const key of schema.required) {
      const p = pathExpr ? `${pathExpr}+'/${esc(key)}'` : `'/${esc(key)}'`
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&!(${JSON.stringify(key)} in ${v})){_e.push({code:'required_missing',path:${p},message:'missing required: ${esc(key)}'});if(!_all)return{valid:false,errors:_e}}`)
    }
  }

  // numeric
  if (schema.minimum !== undefined) {
    const c = isNum ? `${v}<${schema.minimum}` : `typeof ${v}==='number'&&${v}<${schema.minimum}`
    lines.push(`if(${c}){${fail('minimum_violation', `'minimum ${schema.minimum}'`)}}`)
  }
  if (schema.maximum !== undefined) {
    const c = isNum ? `${v}>${schema.maximum}` : `typeof ${v}==='number'&&${v}>${schema.maximum}`
    lines.push(`if(${c}){${fail('maximum_violation', `'maximum ${schema.maximum}'`)}}`)
  }
  if (schema.exclusiveMinimum !== undefined) {
    const c = isNum ? `${v}<=${schema.exclusiveMinimum}` : `typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum}`
    lines.push(`if(${c}){${fail('exclusive_minimum_violation', `'exclusiveMinimum ${schema.exclusiveMinimum}'`)}}`)
  }
  if (schema.exclusiveMaximum !== undefined) {
    const c = isNum ? `${v}>=${schema.exclusiveMaximum}` : `typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum}`
    lines.push(`if(${c}){${fail('exclusive_maximum_violation', `'exclusiveMaximum ${schema.exclusiveMaximum}'`)}}`)
  }
  if (schema.multipleOf !== undefined) {
    const m = schema.multipleOf
    const ci = ctx.varCounter++
    // Use tolerance-based check for floating point (matches C++ behavior)
    lines.push(`{const _r${ci}=typeof ${v}==='number'?${v}%${m}:NaN;if(typeof ${v}==='number'&&Math.abs(_r${ci})>1e-8&&Math.abs(_r${ci}-${m})>1e-8){${fail('multiple_of_violation', `'multipleOf ${m}'`)}}}`)
  }

  // string
  if (schema.minLength !== undefined) {
    const c = isStr ? `${v}.length<${schema.minLength}` : `typeof ${v}==='string'&&${v}.length<${schema.minLength}`
    lines.push(`if(${c}){${fail('min_length_violation', `'minLength ${schema.minLength}'`)}}`)
  }
  if (schema.maxLength !== undefined) {
    const c = isStr ? `${v}.length>${schema.maxLength}` : `typeof ${v}==='string'&&${v}.length>${schema.maxLength}`
    lines.push(`if(${c}){${fail('max_length_violation', `'maxLength ${schema.maxLength}'`)}}`)
  }
  if (schema.pattern) {
    const ri = ctx.varCounter++
    ctx.helperCode.push(`const _re${ri}=new RegExp(${JSON.stringify(schema.pattern)})`)
    const c = isStr ? `!_re${ri}.test(${v})` : `typeof ${v}==='string'&&!_re${ri}.test(${v})`
    lines.push(`if(${c}){${fail('pattern_mismatch', `'pattern mismatch'`)}}`)
  }
  if (schema.format) {
    const fc = FORMAT_CODEGEN[schema.format]
    // Format errors use the boolean codegen — just wrap with error push
    if (fc) {
      const ri = ctx.varCounter++
      const boolLines = []
      boolLines.push(fc(v, isStr))
      // Replace `return false` with error push in the format check
      const fmtCode = boolLines.join(';').replace(/return false/g,
        `{_e.push({code:'format_mismatch',path:${pathExpr||'""'},message:'format ${esc(schema.format)}'});if(!_all)return{valid:false,errors:_e}}`)
      lines.push(fmtCode)
    }
  }

  // array size
  if (schema.minItems !== undefined) {
    const c = isArr ? `${v}.length<${schema.minItems}` : `Array.isArray(${v})&&${v}.length<${schema.minItems}`
    lines.push(`if(${c}){${fail('min_items_violation', `'minItems ${schema.minItems}'`)}}`)
  }
  if (schema.maxItems !== undefined) {
    const c = isArr ? `${v}.length>${schema.maxItems}` : `Array.isArray(${v})&&${v}.length>${schema.maxItems}`
    lines.push(`if(${c}){${fail('max_items_violation', `'maxItems ${schema.maxItems}'`)}}`)
  }

  // uniqueItems
  if (schema.uniqueItems) {
    const si = ctx.varCounter++
    const itemType = schema.items && typeof schema.items === 'object' && schema.items.type
    const isPrim = itemType === 'string' || itemType === 'number' || itemType === 'integer'
    const inner = isPrim
      ? `const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){if(_s${si}.has(${v}[_i])){${fail('unique_items_violation', "'duplicate items'")};break};_s${si}.add(${v}[_i])}`
      : `const _cn${si}=function(x){if(x===null||typeof x!=='object')return typeof x+':'+x;if(Array.isArray(x))return'['+x.map(_cn${si}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+_cn${si}(x[k])}).join(',')+'}'};const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){const _k=_cn${si}(${v}[_i]);if(_s${si}.has(_k)){${fail('unique_items_violation', "'duplicate items'")};break};_s${si}.add(_k)}`
    lines.push(isArr ? `{${inner}}` : `if(Array.isArray(${v})){${inner}}`)
  }

  // object size
  if (schema.minProperties !== undefined) {
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length<${schema.minProperties}){${fail('min_properties_violation', `'minProperties ${schema.minProperties}'`)}}`)
  }
  if (schema.maxProperties !== undefined) {
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length>${schema.maxProperties}){${fail('max_properties_violation', `'maxProperties ${schema.maxProperties}'`)}}`)
  }

  // additionalProperties: false
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = Object.keys(schema.properties).map(k => `${JSON.stringify(k)}`).join(',')
    const ci = ctx.varCounter++
    const inner = `const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++){if(!_a${ci}.has(_k${ci}[_i])){_e.push({code:'additional_property',path:${pathExpr||'""'},message:'additional property: '+_k${ci}[_i]});if(!_all)return{valid:false,errors:_e}}}`
    lines.push(isObj ? `{${inner}}` : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      for (const dep of deps) {
        const p = pathExpr ? `${pathExpr}+'/${esc(dep)}'` : `'/${esc(dep)}'`
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}&&!(${JSON.stringify(dep)} in ${v})){_e.push({code:'required_missing',path:${p},message:'${esc(key)} requires ${esc(dep)}'});if(!_all)return{valid:false,errors:_e}}`)
      }
    }
  }

  // properties — always guard (error mode, data may not be an object or may be array)
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const childPath = pathExpr ? `${pathExpr}+'/${esc(key)}'` : `'/${esc(key)}'`
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeE(prop, `${v}[${JSON.stringify(key)}]`, childPath, lines, ctx)
      lines.push(`}`)
    }
  }

  // patternProperties
  if (schema.patternProperties) {
    for (const [pat, sub] of Object.entries(schema.patternProperties)) {
      const ri = ctx.varCounter++
      ctx.helperCode.push(`const _re${ri}=new RegExp(${JSON.stringify(pat)})`)
      const ki = ctx.varCounter++
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){if(_re${ri}.test(_k${ki})){`)
      const p = pathExpr ? `${pathExpr}+'/'+_k${ki}` : `'/'+_k${ki}`
      genCodeE(sub, `${v}[_k${ki}]`, p, lines, ctx)
      lines.push(`}}}`)
    }
  }

  // dependentSchemas
  if (schema.dependentSchemas) {
    for (const [key, depSchema] of Object.entries(schema.dependentSchemas)) {
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeE(depSchema, v, pathExpr, lines, ctx)
      lines.push(`}`)
    }
  }

  // propertyNames
  if (schema.propertyNames && typeof schema.propertyNames === 'object') {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) {
      lines.push(`if(_k${ki}.length<${pn.minLength}){${fail('min_length_violation', `'propertyNames: key too short: '+_k${ki}`)}}`)
    }
    if (pn.maxLength !== undefined) {
      lines.push(`if(_k${ki}.length>${pn.maxLength}){${fail('max_length_violation', `'propertyNames: key too long: '+_k${ki}`)}}`)
    }
    if (pn.pattern) {
      const ri = ctx.varCounter++
      ctx.helperCode.push(`const _re${ri}=new RegExp(${JSON.stringify(pn.pattern)})`)
      lines.push(`if(!_re${ri}.test(_k${ki})){${fail('pattern_mismatch', `'propertyNames: pattern mismatch: '+_k${ki}`)}}`)
    }
    if (pn.const !== undefined) {
      lines.push(`if(_k${ki}!==${JSON.stringify(pn.const)}){${fail('const_mismatch', `'propertyNames: expected '+${JSON.stringify(pn.const)}`)}}`)
    }
    if (pn.enum) {
      const ei = ctx.varCounter++
      ctx.helperCode.push(`const _es${ei}=new Set(${JSON.stringify(pn.enum)})`)
      lines.push(`if(!_es${ei}.has(_k${ki})){${fail('enum_mismatch', `'propertyNames: key not in enum: '+_k${ki}`)}}`)
    }
    lines.push(`}}`)
  }

  // items — starts after prefixItems (Draft 2020-12 semantics)
  if (schema.items) {
    const startIdx = schema.prefixItems ? schema.prefixItems.length : 0
    const idx = `_j${ctx.varCounter}`
    const elem = `_ei${ctx.varCounter}`
    ctx.varCounter++
    const childPath = pathExpr ? `${pathExpr}+'/'+${idx}` : `'/'+${idx}`
    lines.push(`if(Array.isArray(${v})){for(let ${idx}=${startIdx};${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`)
    genCodeE(schema.items, elem, childPath, lines, ctx)
    lines.push(`}}`)
  }

  // prefixItems
  if (schema.prefixItems) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const childPath = pathExpr ? `${pathExpr}+'/${i}'` : `'/${i}'`
      lines.push(`if(Array.isArray(${v})&&${v}.length>${i}){`)
      genCodeE(schema.prefixItems[i], `${v}[${i}]`, childPath, lines, ctx)
      lines.push(`}`)
    }
  }

  // contains
  if (schema.contains) {
    const ci = ctx.varCounter++
    const subLines = []
    genCode(schema.contains, `_cv`, subLines, ctx)
    const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
    const minC = schema.minContains !== undefined ? schema.minContains : 1
    const maxC = schema.maxContains
    lines.push(`if(Array.isArray(${v})){const _cf${ci}=function(_cv){${fnBody}};let _cc${ci}=0;for(let _ci${ci}=0;_ci${ci}<${v}.length;_ci${ci}++){if(_cf${ci}(${v}[_ci${ci}]))_cc${ci}++}`)
    lines.push(`if(_cc${ci}<${minC}){${fail('contains_violation', `'contains: need at least ${minC} match(es)'`)}}`)
    if (maxC !== undefined) {
      lines.push(`if(_cc${ci}>${maxC}){${fail('contains_violation', `'contains: at most ${maxC} match(es)'`)}}`)
    }
    lines.push(`}`)
  }

  // allOf
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      genCodeE(sub, v, pathExpr, lines, ctx)
    }
  }

  // anyOf
  if (schema.anyOf) {
    const fi = ctx.varCounter++
    const fns = schema.anyOf.map((sub, i) => {
      const subLines = []
      genCode(sub, '_av', subLines, ctx)
      return subLines.length === 0 ? `function(_av){return true}` : `function(_av){${subLines.join(';')};return true}`
    })
    lines.push(`{const _af${fi}=[${fns.join(',')}];let _am${fi}=false;for(let _ai=0;_ai<_af${fi}.length;_ai++){if(_af${fi}[_ai](${v})){_am${fi}=true;break}}if(!_am${fi}){${fail('any_of_failed', "'no anyOf matched'")}}}`)
  }

  // oneOf
  if (schema.oneOf) {
    const fi = ctx.varCounter++
    const fns = schema.oneOf.map((sub, i) => {
      const subLines = []
      genCode(sub, '_ov', subLines, ctx)
      return subLines.length === 0 ? `function(_ov){return true}` : `function(_ov){${subLines.join(';')};return true}`
    })
    lines.push(`{const _of${fi}=[${fns.join(',')}];let _oc${fi}=0;for(let _oi=0;_oi<_of${fi}.length;_oi++){if(_of${fi}[_oi](${v}))_oc${fi}++;if(_oc${fi}>1)break}if(_oc${fi}!==1){${fail('one_of_failed', "'oneOf: expected 1 match, got '+_oc"+fi)}}}`)
  }

  // not
  if (schema.not) {
    const subLines = []
    genCode(schema.not, '_nv', subLines, ctx)
    const nfn = subLines.length === 0 ? `function(_nv){return true}` : `function(_nv){${subLines.join(';')};return true}`
    const fi = ctx.varCounter++
    lines.push(`{const _nf${fi}=${nfn};if(_nf${fi}(${v})){${fail('not_failed', "'should not match'")}}}`)
  }

  // if/then/else
  if (schema.if) {
    const ifLines = []
    genCode(schema.if, '_iv', ifLines, ctx)
    const fi = ctx.varCounter++
    const ifFn = ifLines.length === 0
      ? `function(_iv){return true}`
      : `function(_iv){${ifLines.join(';')};return true}`
    lines.push(`{const _if${fi}=${ifFn}`)
    if (schema.then) {
      lines.push(`if(_if${fi}(${v})){`)
      genCodeE(schema.then, v, pathExpr, lines, ctx)
      lines.push(`}`)
    }
    if (schema.else) {
      lines.push(`${schema.then ? 'else' : `if(!_if${fi}(${v}))`}{`)
      genCodeE(schema.else, v, pathExpr, lines, ctx)
      lines.push(`}`)
    }
    lines.push(`}`)
  }
}

// --- Combined validator: single pass, validates + collects errors ---
// Returns VALID_RESULT for valid data, {valid:false, errors} for invalid.
// Avoids double-pass (jsFn → false → errFn runs same checks again).
// Uses type-aware optimizations: after type check passes, skip guards.
function compileToJSCombined(schema, VALID_RESULT, schemaMap) {
  if (typeof schema === 'boolean') {
    return schema
      ? () => VALID_RESULT
      : () => ({ valid: false, errors: [{ code: 'type_mismatch', path: '', message: 'schema is false' }] })
  }
  if (typeof schema !== 'object' || schema === null) return null
  if (!codegenSafe(schema, schemaMap)) return null
  if (schema.patternProperties) {
    for (const [pat, sub] of Object.entries(schema.patternProperties)) {
      if (typeof sub === 'boolean') return null
      if (/\\[pP]\{/.test(pat)) return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  if (schema.dependentSchemas) {
    for (const sub of Object.values(schema.dependentSchemas)) {
      if (typeof sub === 'boolean') return null
      if (typeof sub === 'object' && sub !== null && !codegenSafe(sub, schemaMap)) return null
    }
  }
  if (schema.propertyNames) {
    if (typeof schema.propertyNames === 'boolean') return null
    const pn = schema.propertyNames
    const supported = ['maxLength', 'minLength', 'pattern', 'const', 'enum']
    const keys = Object.keys(pn).filter(k => k !== '$schema')
    if (keys.some(k => !supported.includes(k))) return null
  }

  const ctx = { varCounter: 0, helperCode: [], closureVars: [], closureVals: [],
                rootDefs: schema.$defs || schema.definitions || null, refStack: new Set(), schemaMap: schemaMap || null }
  const lines = []
  genCodeC(schema, 'd', '', lines, ctx)
  if (lines.length === 0) return () => VALID_RESULT

  // Use factory pattern: closure vars (regexes, etc.) created once, not per call
  const closureParams = ctx.closureVars.join(',')
  // Lazy error array — no allocation for valid data (the common case)
  const inner = `let _e;\n  ` +
    (ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : '') +
    lines.join('\n  ') +
    `\n  return _e?{valid:false,errors:_e}:R`

  try {
    const factory = new Function('R' + (closureParams ? ',' + closureParams : ''),
      `return function(d){${inner}}`)
    return factory(VALID_RESULT, ...ctx.closureVals)
  } catch (e) {
    if (process.env.ATA_DEBUG) console.error('compileToJSCombined error:', e.message, '\n', inner.slice(0, 500))
    return null
  }
}

// Combined code generator: type-aware like genCode, error-collecting like genCodeE.
// After type check passes → use optimizations (destructuring, no guards).
// If type check fails → push error, skip property checks (they'd crash).
function genCodeC(schema, v, pathExpr, lines, ctx) {
  if (typeof schema !== 'object' || schema === null) return

  // $ref — resolve local and cross-schema refs
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeC(ctx.rootDefs[m[1]], v, pathExpr, lines, ctx)
      ctx.refStack.delete(schema.$ref)
      return
    }
    if (ctx.schemaMap && ctx.schemaMap.has(schema.$ref)) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeC(ctx.schemaMap.get(schema.$ref), v, pathExpr, lines, ctx)
      ctx.refStack.delete(schema.$ref)
      return
    }
  }

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  let isObj = false, isArr = false, isStr = false, isNum = false

  // Pre-allocate error objects as closure variables for static paths.
  // This shrinks the generated function body → better V8 JIT on valid path.
  const isStaticPath = !pathExpr || (pathExpr.startsWith("'") && !pathExpr.includes('+'))
  const fail = (code, msg) => {
    if (isStaticPath && msg.startsWith("'") && !msg.includes('+')) {
      // Static error: pre-allocate as frozen closure variable
      const ei = ctx.varCounter++
      const errVar = `_E${ei}`
      const pathVal = pathExpr ? pathExpr.slice(1, -1) : ''
      const msgVal = msg.slice(1, -1)
      ctx.closureVars.push(errVar)
      ctx.closureVals.push(Object.freeze({code, path: pathVal, message: msgVal}))
      return `(_e||(_e=[])).push(${errVar})`
    }
    // Dynamic path (e.g., array index): inline as before
    return `(_e||(_e=[])).push({code:'${code}',path:${pathExpr||'""'},message:${msg}})`
  }

  if (types) {
    const conds = types.map(t => {
      switch (t) {
        case 'object': return `(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
        case 'array': return `Array.isArray(${v})`
        case 'string': return `typeof ${v}==='string'`
        case 'number': return `(typeof ${v}==='number'&&isFinite(${v}))`
        case 'integer': return `Number.isInteger(${v})`
        case 'boolean': return `(${v}===true||${v}===false)`
        case 'null': return `${v}===null`
        default: return 'true'
      }
    })
    const expected = types.join(', ')
    // Type check: push error but continue — wrap remaining in type-success block
    const typeOk = `_tok${ctx.varCounter++}`
    lines.push(`const ${typeOk}=${conds.join('||')}`)
    lines.push(`if(!${typeOk}){${fail('type_mismatch', `'expected ${expected}'`)}}`)
    // Subsequent optimized code runs inside if(typeOk){...}
    if (types.length === 1) {
      isObj = types[0] === 'object'
      isArr = types[0] === 'array'
      isStr = types[0] === 'string'
      isNum = types[0] === 'number' || types[0] === 'integer'
    }
    lines.push(`if(${typeOk}){`)
  }

  // enum
  if (schema.enum) {
    const vals = schema.enum
    const primitives = vals.filter(v => v === null || typeof v !== 'object')
    const objects = vals.filter(v => v !== null && typeof v === 'object')
    const primChecks = primitives.map(p => `${v}===${JSON.stringify(p)}`).join('||')
    const objChecks = objects.map(o => `JSON.stringify(${v})===${JSON.stringify(JSON.stringify(o))}`).join('||')
    const allChecks = [primChecks, objChecks].filter(Boolean).join('||')
    lines.push(`if(!(${allChecks || 'false'})){${fail('enum_mismatch', "'value not in enum'")}}`)
  }

  // const
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      lines.push(`if(${v}!==${JSON.stringify(cv)}){${fail('const_mismatch', "'const mismatch'")}}`)
    } else {
      const ci = ctx.varCounter++
      const canonFn = `_cn${ci}`
      ctx.helperCode.push(`const ${canonFn}=function(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return'['+x.map(${canonFn}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+${canonFn}(x[k])}).join(',')+'}'};`)
      lines.push(`if(${canonFn}(${v})!==${canonFn}(${JSON.stringify(cv)})){${fail('const_mismatch', "'const mismatch'")}}`)
    }
  }

  // required — use destructuring when type is object (SAFE because type check already passed)
  const requiredSet = new Set(schema.required || [])
  const hoisted = {}
  if (schema.required && schema.properties && isObj) {
    const destructKeys = []
    for (const key of schema.required) {
      if (schema.properties[key]) {
        const lv = `_h${ctx.varCounter++}`
        hoisted[key] = lv
        destructKeys.push(`${JSON.stringify(key)}:${lv}`)
      }
    }
    if (destructKeys.length > 0) lines.push(`const{${destructKeys.join(',')}}=${v}`)
    for (const key of schema.required) {
      const check = hoisted[key] ? `${hoisted[key]}===undefined` : `${v}[${JSON.stringify(key)}]===undefined`
      const p = pathExpr ? `${pathExpr}+'/${esc(key)}'` : `'/${esc(key)}'`
      lines.push(`if(${check}){${`(_e||(_e=[])).push({code:'required_missing',path:${p},message:'missing: ${esc(key)}'})`}}`)
    }
  } else if (schema.required) {
    for (const key of schema.required) {
      const p = pathExpr ? `${pathExpr}+'/${esc(key)}'` : `'/${esc(key)}'`
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&!(${JSON.stringify(key)} in ${v})){(_e||(_e=[])).push({code:'required_missing',path:${p},message:'missing: ${esc(key)}'})}`)
    }
  }

  // numeric — skip type guard if known
  if (schema.minimum !== undefined) { const c = isNum ? `${v}<${schema.minimum}` : `typeof ${v}==='number'&&${v}<${schema.minimum}`; lines.push(`if(${c}){${fail('minimum_violation', `'min ${schema.minimum}'`)}}`) }
  if (schema.maximum !== undefined) { const c = isNum ? `${v}>${schema.maximum}` : `typeof ${v}==='number'&&${v}>${schema.maximum}`; lines.push(`if(${c}){${fail('maximum_violation', `'max ${schema.maximum}'`)}}`) }
  if (schema.exclusiveMinimum !== undefined) { const c = isNum ? `${v}<=${schema.exclusiveMinimum}` : `typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum}`; lines.push(`if(${c}){${fail('exclusive_minimum_violation', `'excMin ${schema.exclusiveMinimum}'`)}}`) }
  if (schema.exclusiveMaximum !== undefined) { const c = isNum ? `${v}>=${schema.exclusiveMaximum}` : `typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum}`; lines.push(`if(${c}){${fail('exclusive_maximum_violation', `'excMax ${schema.exclusiveMaximum}'`)}}`) }
  if (schema.multipleOf !== undefined) {
    const m = schema.multipleOf
    const ci = ctx.varCounter++
    lines.push(`{const _r${ci}=typeof ${v}==='number'?${v}%${m}:NaN;if(typeof ${v}==='number'&&Math.abs(_r${ci})>1e-8&&Math.abs(_r${ci}-${m})>1e-8){${fail('multiple_of_violation', `'multipleOf ${m}'`)}}}`)
  }

  // string — skip guard if known
  if (schema.minLength !== undefined) { const c = isStr ? `${v}.length<${schema.minLength}` : `typeof ${v}==='string'&&${v}.length<${schema.minLength}`; lines.push(`if(${c}){${fail('min_length_violation', `'minLength ${schema.minLength}'`)}}`) }
  if (schema.maxLength !== undefined) { const c = isStr ? `${v}.length>${schema.maxLength}` : `typeof ${v}==='string'&&${v}.length>${schema.maxLength}`; lines.push(`if(${c}){${fail('max_length_violation', `'maxLength ${schema.maxLength}'`)}}`) }
  if (schema.pattern) {
    const ri = ctx.varCounter++
    const reVar = `_re${ri}`
    ctx.closureVars.push(reVar)
    ctx.closureVals.push(new RegExp(schema.pattern))
    const c = isStr ? `!${reVar}.test(${v})` : `typeof ${v}==='string'&&!${reVar}.test(${v})`
    lines.push(`if(${c}){${fail('pattern_mismatch', "'pattern mismatch'")}}`)
  }
  if (schema.format) {
    const fc = FORMAT_CODEGEN[schema.format]
    if (fc) {
      const code = fc(v, isStr).replace(/return false/g, `{${fail('format_mismatch', `'format ${esc(schema.format)}'`)}}`)
      lines.push(code)
    }
  }

  // array size
  if (schema.minItems !== undefined) { const c = isArr ? `${v}.length<${schema.minItems}` : `Array.isArray(${v})&&${v}.length<${schema.minItems}`; lines.push(`if(${c}){${fail('min_items_violation', `'minItems ${schema.minItems}'`)}}`) }
  if (schema.maxItems !== undefined) { const c = isArr ? `${v}.length>${schema.maxItems}` : `Array.isArray(${v})&&${v}.length>${schema.maxItems}`; lines.push(`if(${c}){${fail('max_items_violation', `'maxItems ${schema.maxItems}'`)}}`) }

  // uniqueItems
  if (schema.uniqueItems) {
    const si = ctx.varCounter++
    const itemType = schema.items && typeof schema.items === 'object' && schema.items.type
    const isPrim = itemType === 'string' || itemType === 'number' || itemType === 'integer'
    const inner = isPrim
      ? `const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){if(_s${si}.has(${v}[_i])){${fail('unique_items_violation', "'duplicates'")};break};_s${si}.add(${v}[_i])}`
      : `const _cn${si}=function(x){if(x===null||typeof x!=='object')return typeof x+':'+x;if(Array.isArray(x))return'['+x.map(_cn${si}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+_cn${si}(x[k])}).join(',')+'}'};const _s${si}=new Set();for(let _i=0;_i<${v}.length;_i++){const _k=_cn${si}(${v}[_i]);if(_s${si}.has(_k)){${fail('unique_items_violation', "'duplicates'")};break};_s${si}.add(_k)}`
    lines.push(isArr ? `{${inner}}` : `if(Array.isArray(${v})){${inner}}`)
  }

  // object size
  if (schema.minProperties !== undefined) lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length<${schema.minProperties}){${fail('min_properties_violation', `'minProperties ${schema.minProperties}'`)}}`)
  if (schema.maxProperties !== undefined) lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length>${schema.maxProperties}){${fail('max_properties_violation', `'maxProperties ${schema.maxProperties}'`)}}`)

  // additionalProperties — skip if patternProperties present (handled in unified loop below)
  if (schema.additionalProperties === false && schema.properties && !schema.patternProperties) {
    const allowed = Object.keys(schema.properties).map(k => JSON.stringify(k)).join(',')
    const ci = ctx.varCounter++
    lines.push(isObj
      ? `{const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++)if(!_a${ci}.has(_k${ci}[_i])){${fail('additional_property', `'extra: '+_k${ci}[_i]`)}}}`
      : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++)if(!_a${ci}.has(_k${ci}[_i])){${fail('additional_property', `'extra: '+_k${ci}[_i]`)}}}`)
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      for (const dep of deps) {
        const p = pathExpr ? `${pathExpr}+'/${esc(dep)}'` : `'/${esc(dep)}'`
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}&&!(${JSON.stringify(dep)} in ${v})){(_e||(_e=[])).push({code:'required_missing',path:${p},message:'${esc(key)} requires ${esc(dep)}'})}`)
      }
    }
  }

  // properties — use hoisted vars for required+known-object, full guard otherwise
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const pv = hoisted[key] || `${v}[${JSON.stringify(key)}]`
      const childPath = pathExpr ? `${pathExpr}+'/${esc(key)}'` : `'/${esc(key)}'`
      if (requiredSet.has(key) && isObj) {
        lines.push(`if(${pv}!==undefined){`)
        genCodeC(prop, pv, childPath, lines, ctx)
        lines.push(`}`)
      } else if (isObj) {
        const oi = ctx.varCounter++
        lines.push(`{const _o${oi}=${v}[${JSON.stringify(key)}];if(_o${oi}!==undefined){`)
        genCodeC(prop, `_o${oi}`, childPath, lines, ctx)
        lines.push(`}}`)
      } else {
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
        genCodeC(prop, `${v}[${JSON.stringify(key)}]`, childPath, lines, ctx)
        lines.push(`}`)
      }
    }
  }

  // patternProperties
  if (schema.patternProperties) {
    const ppEntries = Object.entries(schema.patternProperties)
    const reVars = []
    for (const [pat] of ppEntries) {
      const ri = ctx.varCounter++
      ctx.closureVars.push(`_re${ri}`)
      ctx.closureVals.push(new RegExp(pat))
      reVars.push(`_re${ri}`)
    }

    if (schema.additionalProperties === false && schema.properties) {
      // Unified loop: validate patterns + reject unknown keys
      const pi = ctx.varCounter++
      const allowedSet = `_as${pi}`
      ctx.closureVars.push(allowedSet)
      ctx.closureVals.push(new Set(Object.keys(schema.properties)))
      // Pre-compile sub-schema validators as closure vars
      for (let i = 0; i < ppEntries.length; i++) {
        const [, sub] = ppEntries[i]
        const subLines = []
        genCode(sub, `_ppv`, subLines, ctx)
        const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
        const fnVar = `_ppf${pi}_${i}`
        ctx.closureVars.push(fnVar)
        ctx.closureVals.push(new Function('_ppv', fnBody))
      }
      const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
      const ki = ctx.varCounter++
      lines.push(`${guard}{for(const _k${ki} in ${v}){`)
      lines.push(`let _m${ki}=${allowedSet}.has(_k${ki})`)
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${reVars[i]}.test(_k${ki})){_m${ki}=true;if(!_ppf${pi}_${i}(${v}[_k${ki}])){${fail('pattern_mismatch', `'patternProperties: value invalid for key '+_k${ki}`)}}}`)
      }
      lines.push(`if(!_m${ki}){${fail('additional_property', `'extra: '+_k${ki}`)}}`)
      lines.push(`}}`)
    } else {
      // No additionalProperties: just validate matching keys
      const ki = ctx.varCounter++
      const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
      lines.push(`${guard}{for(const _k${ki} in ${v}){`)
      for (let i = 0; i < ppEntries.length; i++) {
        const [, sub] = ppEntries[i]
        const p = pathExpr ? `${pathExpr}+'/'+_k${ki}` : `'/'+_k${ki}`
        lines.push(`if(${reVars[i]}.test(_k${ki})){`)
        genCodeC(sub, `${v}[_k${ki}]`, p, lines, ctx)
        lines.push(`}`)
      }
      lines.push(`}}`)
    }
  }

  // dependentSchemas
  if (schema.dependentSchemas) {
    for (const [key, depSchema] of Object.entries(schema.dependentSchemas)) {
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeC(depSchema, v, pathExpr, lines, ctx)
      lines.push(`}`)
    }
  }

  // propertyNames
  if (schema.propertyNames && typeof schema.propertyNames === 'object') {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) {
      lines.push(`if(_k${ki}.length<${pn.minLength}){${fail('min_length_violation', `'propertyNames: key too short: '+_k${ki}`)}}`)
    }
    if (pn.maxLength !== undefined) {
      lines.push(`if(_k${ki}.length>${pn.maxLength}){${fail('max_length_violation', `'propertyNames: key too long: '+_k${ki}`)}}`)
    }
    if (pn.pattern) {
      const ri = ctx.varCounter++
      ctx.closureVars.push(`_re${ri}`)
      ctx.closureVals.push(new RegExp(pn.pattern))
      lines.push(`if(!_re${ri}.test(_k${ki})){${fail('pattern_mismatch', `'propertyNames: pattern mismatch: '+_k${ki}`)}}`)
    }
    if (pn.const !== undefined) {
      lines.push(`if(_k${ki}!==${JSON.stringify(pn.const)}){${fail('const_mismatch', `'propertyNames: expected '+${JSON.stringify(pn.const)}`)}}`)
    }
    if (pn.enum) {
      const ei = ctx.varCounter++
      ctx.closureVars.push(`_es${ei}`)
      ctx.closureVals.push(new Set(pn.enum))
      lines.push(`if(!_es${ei}.has(_k${ki})){${fail('enum_mismatch', `'propertyNames: key not in enum: '+_k${ki}`)}}`)
    }
    lines.push(`}}`)
  }

  // items
  if (schema.items) {
    const startIdx = schema.prefixItems ? schema.prefixItems.length : 0
    const idx = `_j${ctx.varCounter}`, elem = `_ei${ctx.varCounter}`
    ctx.varCounter++
    const childPath = pathExpr ? `${pathExpr}+'/'+${idx}` : `'/'+${idx}`
    lines.push(`if(Array.isArray(${v})){for(let ${idx}=${startIdx};${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`)
    genCodeC(schema.items, elem, childPath, lines, ctx)
    lines.push(`}}`)
  }

  // prefixItems
  if (schema.prefixItems) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const childPath = pathExpr ? `${pathExpr}+'/${i}'` : `'/${i}'`
      lines.push(`if(Array.isArray(${v})&&${v}.length>${i}){`)
      genCodeC(schema.prefixItems[i], `${v}[${i}]`, childPath, lines, ctx)
      lines.push(`}`)
    }
  }

  // contains
  if (schema.contains) {
    const ci = ctx.varCounter++
    const subLines = []
    genCode(schema.contains, `_cv`, subLines, ctx)
    const fnBody = subLines.length === 0 ? `return true` : `${subLines.join(';')};return true`
    const minC = schema.minContains !== undefined ? schema.minContains : 1
    const maxC = schema.maxContains
    lines.push(`if(Array.isArray(${v})){const _cf${ci}=function(_cv){${fnBody}};let _cc${ci}=0;for(let _ci${ci}=0;_ci${ci}<${v}.length;_ci${ci}++){if(_cf${ci}(${v}[_ci${ci}]))_cc${ci}++}`)
    lines.push(`if(_cc${ci}<${minC}){${fail('contains_violation', `'need ${minC}+ matches'`)}}`)
    if (maxC !== undefined) lines.push(`if(_cc${ci}>${maxC}){${fail('contains_violation', `'max ${maxC} matches'`)}}`)
    lines.push(`}`)
  }

  // allOf
  if (schema.allOf) { for (const sub of schema.allOf) genCodeC(sub, v, pathExpr, lines, ctx) }

  // anyOf
  if (schema.anyOf) {
    const fi = ctx.varCounter++
    const fns = schema.anyOf.map(sub => { const sl = []; genCode(sub, '_av', sl, ctx); return sl.length === 0 ? `function(_av){return true}` : `function(_av){${sl.join(';')};return true}` })
    lines.push(`{const _af${fi}=[${fns.join(',')}];let _am=false;for(let _ai=0;_ai<_af${fi}.length;_ai++){if(_af${fi}[_ai](${v})){_am=true;break}}if(!_am){${fail('any_of_failed', "'no match'")}}}`)
  }

  // oneOf
  if (schema.oneOf) {
    const fi = ctx.varCounter++
    const fns = schema.oneOf.map(sub => { const sl = []; genCode(sub, '_ov', sl, ctx); return sl.length === 0 ? `function(_ov){return true}` : `function(_ov){${sl.join(';')};return true}` })
    lines.push(`{const _of${fi}=[${fns.join(',')}];let _oc=0;for(let _oi=0;_oi<_of${fi}.length;_oi++){if(_of${fi}[_oi](${v}))_oc++;if(_oc>1)break}if(_oc!==1){${fail('one_of_failed', "'need exactly 1'")}}}`)
  }

  // not
  if (schema.not) {
    const sl = []; genCode(schema.not, '_nv', sl, ctx)
    const nfn = sl.length === 0 ? `function(_nv){return true}` : `function(_nv){${sl.join(';')};return true}`
    const fi = ctx.varCounter++
    lines.push(`{const _nf${fi}=${nfn};if(_nf${fi}(${v})){${fail('not_failed', "'should not match'")}}}`)
  }

  // if/then/else
  if (schema.if) {
    const sl = []; genCode(schema.if, '_iv', sl, ctx)
    const fi = ctx.varCounter++
    const ifFn = sl.length === 0 ? `function(_iv){return true}` : `function(_iv){${sl.join(';')};return true}`
    lines.push(`{const _if${fi}=${ifFn}`)
    if (schema.then) { lines.push(`if(_if${fi}(${v})){`); genCodeC(schema.then, v, pathExpr, lines, ctx); lines.push(`}`) }
    if (schema.else) { lines.push(`${schema.then ? 'else' : `if(!_if${fi}(${v}))`}{`); genCodeC(schema.else, v, pathExpr, lines, ctx); lines.push(`}`) }
    lines.push(`}`)
  }

  // Close type-success block if opened
  if (types) {
    lines.push(`}`)
  }
}

module.exports = { compileToJS, compileToJSCodegen, compileToJSCodegenWithErrors, compileToJSCombined }
