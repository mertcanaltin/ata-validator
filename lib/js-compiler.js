'use strict'

// Compile a JSON Schema into a pure JS validator function.
// Closure-based validator — no new Function() or eval().
// Returns null if the schema is too complex for JS compilation.

// Count Unicode code points, not UTF-16 code units (surrogate pairs).
// JSON Schema: minLength/maxLength count characters per RFC 8259.
// Fast path: if no surrogate pairs exist, .length is correct (covers >99% of real data).
function _cpLen(s) {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    if (s.charCodeAt(i) >= 0xD800 && s.charCodeAt(i) <= 0xDBFF) {
      // Found a high surrogate — count code points the slow way
      let n = 0; for (const _ of s) n++; return n;
    }
  }
  return len;
}

// AJV-compatible error message templates (compile-time, not runtime)
const AJV_MESSAGES = {
  type: (p) => `must be ${p.type}`,
  required: (p) => `must have required property '${p.missingProperty}'`,
  additionalProperties: () => 'must NOT have additional properties',
  enum: () => 'must be equal to one of the allowed values',
  const: () => 'must be equal to constant',
  minimum: (p) => `must be >= ${p.limit}`,
  maximum: (p) => `must be <= ${p.limit}`,
  exclusiveMinimum: (p) => `must be > ${p.limit}`,
  exclusiveMaximum: (p) => `must be < ${p.limit}`,
  minLength: (p) => `must NOT have fewer than ${p.limit} characters`,
  maxLength: (p) => `must NOT have more than ${p.limit} characters`,
  pattern: (p) => `must match pattern "${p.pattern}"`,
  format: (p) => `must match format "${p.format}"`,
  minItems: (p) => `must NOT have fewer than ${p.limit} items`,
  maxItems: (p) => `must NOT have more than ${p.limit} items`,
  uniqueItems: (p) => `must NOT have duplicate items (items ## ${p.j} and ${p.i} are identical)`,
  minProperties: (p) => `must NOT have fewer than ${p.limit} properties`,
  maxProperties: (p) => `must NOT have more than ${p.limit} properties`,
  multipleOf: (p) => `must be multiple of ${p.multipleOf}`,
  oneOf: () => 'must match exactly one schema in oneOf',
  anyOf: () => 'must match a schema in anyOf',
  allOf: () => 'must match all schemas in allOf',
  not: () => 'must NOT be valid',
  if: (p) => `must match "${p.failingKeyword}" schema`,
}

function compileToJS(schema, defs, schemaMap) {
  if (typeof schema === 'boolean') {
    return schema ? () => true : () => false
  }
  if (typeof schema !== 'object' || schema === null) return null

  // Bail if schema has edge cases that JS fast path gets wrong
  // Exception: $dynamicRef/$anchor are handled by the interpretive path even though codegen can't
  if (!defs && !codegenSafe(schema, schemaMap)) {
    const str = JSON.stringify(schema)
    if (!str.includes('"$dynamicRef"') && !str.includes('"$dynamicAnchor"') && !str.includes('"$anchor"')) return null
  }

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

  // $dynamicRef — resolve via anchor defs or JSON pointer
  if (schema.$dynamicRef) {
    const ref = schema.$dynamicRef
    const anchorName = ref.startsWith('#') ? ref : '#' + ref
    if (rootDefs && rootDefs[anchorName]) {
      const entry = rootDefs[anchorName]
      checks.push((d) => { const fn = entry.fn; return fn ? fn(d) : true })
    } else {
      // JSON pointer: "#/$defs/foo" or "#/definitions/foo"
      const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
      if (m && rootDefs && rootDefs[m[1]]) {
        const entry = rootDefs[m[1]]
        checks.push((d) => { const fn = entry.fn; return fn ? fn(d) : true })
      }
    }
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
    const min2 = min * 2
    checks.push((d) => typeof d !== 'string' || d.length >= min2 || (d.length >= min && _cpLen(d) >= min))
  }
  if (schema.maxLength !== undefined) {
    const max = schema.maxLength
    checks.push((d) => typeof d !== 'string' || d.length <= max || _cpLen(d) <= max)
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
      // Register anchors
      if (def && typeof def === 'object') {
        if (def.$anchor) {
          const anchorDef = def
          let anchorCached = undefined
          defs['#' + def.$anchor] = {
            get fn() {
              if (anchorCached === undefined) {
                anchorCached = null
                anchorCached = compileToJS(anchorDef, defs)
              }
              return anchorCached || (() => true)
            },
            raw: anchorDef
          }
        }
        if (def.$dynamicAnchor) {
          const daDef = def
          let daCached = undefined
          defs['#' + def.$dynamicAnchor] = {
            get fn() {
              if (daCached === undefined) {
                daCached = null
                daCached = compileToJS(daDef, defs)
              }
              return daCached || (() => true)
            },
            raw: daDef
          }
        }
      }
    }
  }
  // Register root-level $anchor/$dynamicAnchor (self-referencing schemas)
  if (schema.$anchor && !defs['#' + schema.$anchor]) {
    const rootAnchorSchema = schema
    let rootACached = undefined
    defs['#' + schema.$anchor] = {
      get fn() {
        if (rootACached === undefined) {
          rootACached = null
          rootACached = compileToJS(rootAnchorSchema, defs)
        }
        return rootACached || (() => true)
      },
      raw: rootAnchorSchema
    }
  }
  if (schema.$dynamicAnchor && !defs['#' + schema.$dynamicAnchor]) {
    const rootDASchema = schema
    let rootDACached = undefined
    defs['#' + schema.$dynamicAnchor] = {
      get fn() {
        if (rootDACached === undefined) {
          rootDACached = null
          rootDACached = compileToJS(rootDASchema, defs)
        }
        return rootDACached || (() => true)
      },
      raw: rootDASchema
    }
  }
  return defs
}

function resolveRef(ref, defs, schemaMap) {
  // Self-reference: "#" — treat as permissive to avoid infinite recursion
  if (ref === '#') return () => true

  // 1. Local ref
  if (defs) {
    const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m) {
      const name = m[1]
      const entry = defs[name]
      if (entry) return (d) => { const fn = entry.fn; return fn ? fn(d) : true }
    }
    // Anchor ref: "#foo"
    if (ref.startsWith('#') && !ref.startsWith('#/')) {
      const entry = defs[ref]
      if (entry) return (d) => { const fn = entry.fn; return fn ? fn(d) : true }
    }
  }
  // 2. Cross-schema ref (exact match)
  if (schemaMap && schemaMap.has(ref)) {
    const resolved = schemaMap.get(ref)
    const fn = compileToJS(resolved, null, schemaMap)
    return fn || (() => true)
  }
  // 3. Cross-schema ref (relative URI resolution)
  if (schemaMap && !ref.includes('://') && !ref.startsWith('#')) {
    for (const [id] of schemaMap) {
      if (id.endsWith('/' + ref)) {
        const resolved = schemaMap.get(id)
        const fn = compileToJS(resolved, null, schemaMap)
        return fn || (() => true)
      }
    }
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
  date: (s) => { if (s.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const m = +s.slice(5, 7), d = +s.slice(8, 10); return m >= 1 && m <= 12 && d >= 1 && d <= 31 },
  uuid: (s) => s.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => { const p = s.split('.'); return p.length === 4 && p.every(n => { const v = +n; return v >= 0 && v <= 255 && String(v) === n }) },
  hostname: (s) => s.length > 0 && s.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(s),
}

// Dangerous JS property names that exist on Object.prototype
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'])

// Check if all $dynamicRef in a target schema can be resolved via the calling schema's anchors.
function canResolveDynamicRefs(target, callingSchema, schemaMap) {
  // Collect anchors from calling schema
  const anchors = new Set()
  if (callingSchema.$dynamicAnchor) anchors.add(callingSchema.$dynamicAnchor)
  const defs = callingSchema.$defs || callingSchema.definitions
  if (defs) {
    for (const def of Object.values(defs)) {
      if (def && typeof def === 'object' && def.$dynamicAnchor) anchors.add(def.$dynamicAnchor)
    }
  }
  // Also collect from schemaMap
  if (schemaMap) {
    for (const ext of schemaMap.values()) {
      if (ext && typeof ext === 'object' && ext.$dynamicAnchor) anchors.add(ext.$dynamicAnchor)
    }
  }
  // Find all $dynamicRef in target
  const refs = []
  const findDynRefs = (s) => {
    if (typeof s !== 'object' || s === null) return
    if (s.$dynamicRef) {
      const name = s.$dynamicRef.startsWith('#') ? s.$dynamicRef.slice(1) : s.$dynamicRef
      refs.push(name)
    }
    for (const v of Object.values(s)) {
      if (Array.isArray(v)) v.forEach(findDynRefs)
      else if (typeof v === 'object' && v !== null) findDynRefs(v)
    }
  }
  findDynRefs(target)
  return refs.every(r => anchors.has(r))
}

// Recursively check if a schema can be safely compiled to JS codegen.
// Returns false if any sub-schema contains features codegen gets wrong.
function codegenSafe(schema, schemaMap) {
  if (typeof schema === 'boolean') return true
  if (typeof schema !== 'object' || schema === null) return true

  // Only bail on $dynamicRef if it can't be resolved at compile time
  if (schema.$dynamicRef && !schema.$dynamicRef.startsWith('#')) return false

  // Boolean sub-schemas anywhere cause bail — codegen doesn't handle schema=false correctly
  if (schema.items === false) return false
  if (schema.items === true && !schema.unevaluatedItems) return false
  if (schema.additionalProperties === true) return true // permissive — fine
  if (schema.properties) {
    for (const v of Object.values(schema.properties)) {
      if (v === false) return false // property: false is complex
      if (v === true) continue // property: true is always valid
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
    // Self-reference "#" — treated as permissive (no-op) to avoid infinite recursion
    if (schema.$ref === '#') return true
    const isLocal = /^#\/(?:\$defs|definitions)\/[^/]+$/.test(schema.$ref)
    let isResolvable = !isLocal && schemaMap && schemaMap.has(schema.$ref)
    // Relative URI resolution: check if any schemaMap key ends with "/" + ref
    let resolvedTarget = null
    if (!isLocal && !isResolvable && schemaMap && !schema.$ref.includes('://') && !schema.$ref.startsWith('#')) {
      for (const [id] of schemaMap) {
        if (id.endsWith('/' + schema.$ref)) { isResolvable = true; resolvedTarget = schemaMap.get(id); break }
      }
    }
    // Anchor-style ref: #name (not #/path, not bare #) — resolvable at compile time via anchors map
    const isAnchorRef = !isLocal && !isResolvable && schema.$ref.length > 1 && schema.$ref.startsWith('#') && !schema.$ref.startsWith('#/')
    if (!isLocal && !isResolvable && !isAnchorRef) return false
    // If the resolved target contains $dynamicRef, allow codegen only when:
    // 1. All $dynamicRefs can be resolved via the current schema's anchors
    // 2. The resolved target itself is simple enough for codegen (no additionalProperties: false, etc.)
    if (!resolvedTarget && isResolvable) resolvedTarget = schemaMap.get(schema.$ref)
    if (resolvedTarget && JSON.stringify(resolvedTarget).includes('"$dynamicRef"')) {
      const canResolve = canResolveDynamicRefs(resolvedTarget, schema, schemaMap)
      // Also verify the resolved target doesn't have complex features that codegen can't inline
      const targetSimple = canResolve && resolvedTarget.additionalProperties === undefined &&
        !resolvedTarget.patternProperties && !resolvedTarget.dependentSchemas &&
        !resolvedTarget.propertyNames
      if (!targetSimple && schema.unevaluatedProperties === undefined && schema.unevaluatedItems === undefined) return false
    }
    // In Draft 2020-12, $ref with siblings is allowed. Only bail if no unevaluated* keyword
    // (unevaluated schemas need $ref + siblings to work properly)
    // Schema-organization keywords ($dynamicAnchor, $anchor) are not validation siblings
    const SCHEMA_ORG_KEYS = new Set(['$ref', '$defs', 'definitions', '$schema', '$id', '$dynamicAnchor', '$anchor'])
    const siblings = Object.keys(schema).filter(k => !SCHEMA_ORG_KEYS.has(k))
    if (siblings.length > 0 && schema.unevaluatedProperties === undefined && schema.unevaluatedItems === undefined) return false
  }

  // additionalProperties as schema — bail entirely, too many edge cases with allOf interaction
  if (typeof schema.additionalProperties === 'object') return false
  if (schema.additionalProperties === false && !schema.properties) return false

  // propertyNames: false — codegen doesn't handle this
  if (schema.propertyNames === false) return false

  // unevaluatedProperties: allow boolean and schema values
  if (schema.unevaluatedProperties !== undefined) {
    if (typeof schema.unevaluatedProperties === 'object' && schema.unevaluatedProperties !== null) {
      if (!codegenSafe(schema.unevaluatedProperties, schemaMap)) return false
    }
  }
  // unevaluatedItems: allow boolean and schema values
  if (schema.unevaluatedItems !== undefined) {
    if (typeof schema.unevaluatedItems === 'object' && schema.unevaluatedItems !== null) {
      if (!codegenSafe(schema.unevaluatedItems, schemaMap)) return false
    }
  }

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
    if (s === false) return false // boolean false sub-schema — complex
    if (s === true) continue // boolean true sub-schema — always valid, fine
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

  // Build anchors map for $ref/#anchor and $dynamicRef resolution
  const anchors = {}
  // Root schema's own $dynamicAnchor / $anchor
  if (schema.$dynamicAnchor) anchors['#' + schema.$dynamicAnchor] = schema
  if (schema.$anchor) anchors['#' + schema.$anchor] = schema
  // Anchors from $defs
  if (rootDefs) {
    for (const def of Object.values(rootDefs)) {
      if (def && typeof def === 'object') {
        if (def.$dynamicAnchor) anchors['#' + def.$dynamicAnchor] = def
        if (def.$anchor) anchors['#' + def.$anchor] = def
      }
    }
  }
  // Anchors from external schemas in schemaMap
  if (schemaMap) {
    for (const ext of schemaMap.values()) {
      if (ext && typeof ext === 'object') {
        if (ext.$dynamicAnchor && !anchors['#' + ext.$dynamicAnchor]) anchors['#' + ext.$dynamicAnchor] = ext
        if (ext.$anchor && !anchors['#' + ext.$anchor]) anchors['#' + ext.$anchor] = ext
      }
    }
  }

  const ctx = { varCounter: 0, helpers: [], helperCode: [], closureVars: ['_cpLen'], closureVals: [_cpLen], rootDefs, refStack: new Set(), schemaMap: schemaMap || null, anchors, rootSchema: schema }
  const lines = []
  genCode(schema, 'd', lines, ctx)

  // Append deferred checks (additionalProperties, unevaluatedProperties) at the end
  if (ctx.deferredChecks) {
    for (const dc of ctx.deferredChecks) lines.push(dc)
  }

  if (lines.length === 0) return () => true

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

  let body, hybridBody
  if (ctx.usesRecursion) {
    // Self-recursive: wrap in named function
    body = `function _validate(d){\n  ${checkStr}\n  return true\n  }\n  return _validate(d)`
    // Hybrid: keep _validate as boolean, wrap only the outer call
    hybridBody = `function _validate(d){\n  ${checkStr}\n  return true\n  }\n  return _validate(d)?R:E(d)`
  } else {
    body = checkStr + '\n  return true'
    hybridBody = replaceTopLevel(checkStr + '\n  return R')
  }

  try {
    let boolFn
    if (closureNames.length > 0) {
      const factory = new Function(...closureNames, `return function(d){${body}}`)
      boolFn = factory(...closureValues)
    } else {
      boolFn = new Function('d', body)
    }

    // Build hybrid: same body, return R instead of true, return E(d) instead of false.
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

// Returns true if a property sub-schema will generate 2+ lines that each access v,
// meaning a local variable hoist is worthwhile.
function needsLocal(schema) {
  if (typeof schema !== 'object' || schema === null) return false
  // If it has $ref, allOf, anyOf etc., genCode handles it — don't hoist
  if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.if) return false
  if (schema.properties || schema.items || schema.prefixItems) return false
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  if (!types || types.length !== 1) return false
  const t = types[0]
  let checkCount = 1 // type check itself
  if (t === 'string') {
    if (schema.minLength !== undefined) checkCount++
    if (schema.maxLength !== undefined) checkCount++
    if (schema.pattern) checkCount++
    if (schema.format) checkCount++
  } else if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined) checkCount++
    if (schema.maximum !== undefined) checkCount++
    if (schema.exclusiveMinimum !== undefined) checkCount++
    if (schema.exclusiveMaximum !== undefined) checkCount++
    if (schema.multipleOf !== undefined) checkCount++
  }
  return checkCount >= 2
}

// Try to generate a single combined check for simple leaf schemas.
// Returns a string like "{const _v=d["x"];if(typeof _v!=='string'||_v.length<1||_v.length>100)return false}"
// or null if the schema is too complex.
function tryGenCombined(schema, access, ctx) {
  if (typeof schema !== 'object' || schema === null) return null
  // Only handle simple leaf schemas with a single type and basic constraints
  if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.if) return null
  if (schema.properties || schema.items || schema.prefixItems || schema.patternProperties) return null
  if (schema.enum || schema.const !== undefined) return null
  if (schema.not || schema.dependentRequired || schema.dependentSchemas) return null
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  if (!types || types.length !== 1) return null
  const t = types[0]

  if (t === 'string') {
    const conds = [`typeof _v!=='string'`]
    if (schema.minLength !== undefined) conds.push(`_cpLen(_v)<${schema.minLength}`)
    if (schema.maxLength !== undefined) conds.push(`_cpLen(_v)>${schema.maxLength}`)
    if (conds.length < 2 && !schema.pattern && !schema.format) return null // not worth combining
    // pattern and format need separate statements, fall back if present
    if (schema.pattern || schema.format) return null
    const vi = ctx.varCounter++
    return `{const _v=${access};if(${conds.join('||')})return false}`
  }

  if (t === 'integer') {
    const conds = [`!Number.isInteger(_v)`]
    if (schema.minimum !== undefined) conds.push(`_v<${schema.minimum}`)
    if (schema.maximum !== undefined) conds.push(`_v>${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined) conds.push(`_v<=${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined) conds.push(`_v>=${schema.exclusiveMaximum}`)
    if (schema.multipleOf !== undefined) conds.push(`_v%${schema.multipleOf}!==0`)
    if (conds.length < 2) return null
    const vi = ctx.varCounter++
    return `{const _v=${access};if(${conds.join('||')})return false}`
  }

  if (t === 'number') {
    const conds = [`typeof _v!=='number'||!isFinite(_v)`]
    if (schema.minimum !== undefined) conds.push(`_v<${schema.minimum}`)
    if (schema.maximum !== undefined) conds.push(`_v>${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined) conds.push(`_v<=${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined) conds.push(`_v>=${schema.exclusiveMaximum}`)
    if (schema.multipleOf !== undefined) conds.push(`_v%${schema.multipleOf}!==0`)
    if (conds.length < 2) return null
    const vi = ctx.varCounter++
    return `{const _v=${access};if(${conds.join('||')})return false}`
  }

  return null
}

// Deferred checks (additionalProperties, unevaluatedProperties, ...) reference
// the current node variable (`${v}`). Deferring them to the end of the root
// function is only safe when we're at the root (`v === 'd'`). For nested
// nodes, emit inline so block-scoped variables like `_o0` stay in scope.
function _deferOrInline(ctx, lines, v, check) {
  if (v === 'd') {
    if (!ctx.deferredChecks) ctx.deferredChecks = []
    ctx.deferredChecks.push(check)
  } else {
    lines.push(check)
  }
}

// knownType: if parent already verified the type, skip redundant guards.
// 'object' = we know v is a non-null non-array object
// 'array'  = we know v is an array
// 'string' / 'number' / 'integer' = we know the primitive type
function genCode(schema, v, lines, ctx, knownType) {
  if (typeof schema !== 'object' || schema === null) return
  if (!ctx.regExpMap) {
    ctx.regExpMap = new Map();
  }

  // $ref — guard against circular references
  // In 2020-12 with unevaluated*, $ref can coexist with siblings — don't early return
  // Only when THIS schema has unevaluated keywords directly (not via $ref target)
  const hasSiblings = schema.$ref && (schema.unevaluatedProperties !== undefined || schema.unevaluatedItems !== undefined)
  if (schema.$ref) {
    // Self-reference "#" — recursive call to root validator
    if (schema.$ref === '#') {
      ctx.usesRecursion = true
      lines.push(`if(!_validate(${v}))return false`)
      if (!hasSiblings) return
    }
    // 1. Local ref
    const m = schema.$ref !== '#' && schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) { if (!hasSiblings) return }
      else {
        ctx.refStack.add(schema.$ref)
        genCode(ctx.rootDefs[m[1]], v, lines, ctx, knownType)
        ctx.refStack.delete(schema.$ref)
        if (!hasSiblings) return
      }
    } else if (schema.$ref !== '#' && !m && schema.$ref.startsWith('#') && !schema.$ref.startsWith('#/')) {
      // Anchor ref: "#foo" — resolve via rootDefs or anchors map
      const entry = ctx.rootDefs && ctx.rootDefs[schema.$ref]
      const anchorTarget = entry && entry.raw ? entry.raw : (ctx.anchors && ctx.anchors[schema.$ref])
      if (anchorTarget) {
        if (ctx.refStack.has(schema.$ref)) { if (!hasSiblings) return }
        else {
          ctx.refStack.add(schema.$ref)
          genCode(anchorTarget, v, lines, ctx, knownType)
          ctx.refStack.delete(schema.$ref)
          if (!hasSiblings) return
        }
      }
    } else if (schema.$ref !== '#' && ctx.schemaMap) {
      // 2. Cross-schema ref (exact match or relative URI)
      let resolved = ctx.schemaMap.get(schema.$ref)
      if (!resolved && !schema.$ref.includes('://') && !schema.$ref.startsWith('#')) {
        for (const [id, s] of ctx.schemaMap) {
          if (id.endsWith('/' + schema.$ref)) { resolved = s; break }
        }
      }
      if (resolved) {
        if (ctx.refStack.has(schema.$ref)) { if (!hasSiblings) return }
        else {
          ctx.refStack.add(schema.$ref)
          genCode(resolved, v, lines, ctx, knownType)
          ctx.refStack.delete(schema.$ref)
          if (!hasSiblings) return
        }
      } else {
        if (!hasSiblings) return
      }
    } else {
      if (!hasSiblings) return
    }
  }

  // $dynamicRef — resolve via anchors map
  if (schema.$dynamicRef) {
    const anchorKey = schema.$dynamicRef.startsWith('#') ? schema.$dynamicRef : '#' + schema.$dynamicRef
    if (ctx.anchors && ctx.anchors[anchorKey]) {
      const target = ctx.anchors[anchorKey]
      if (target === ctx.rootSchema) {
        // Self-recursive: generate _validate(v) call
        ctx.usesRecursion = true
        lines.push(`if(!_validate(${v}))return false`)
      } else {
        // Different schema: inline the target validation
        const refKey = '$dynamicRef:' + anchorKey
        if (!ctx.refStack.has(refKey)) {
          ctx.refStack.add(refKey)
          genCode(target, v, lines, ctx, knownType)
          ctx.refStack.delete(refKey)
        }
      }
    }
  }

  // Determine the single known type after this schema's type check
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  let effectiveType = knownType
  if (types) {
    if (!knownType) {
      // Emit the type check — use direct negation for single types (avoids !() wrapper)
      if (types.length === 1) {
        switch (types[0]) {
          case 'object': lines.push(`if(typeof ${v}!=='object'||${v}===null||Array.isArray(${v}))return false`); break
          case 'array': lines.push(`if(!Array.isArray(${v}))return false`); break
          case 'string': lines.push(`if(typeof ${v}!=='string')return false`); break
          case 'number': lines.push(`if(typeof ${v}!=='number'||!isFinite(${v}))return false`); break
          case 'integer': lines.push(`if(!Number.isInteger(${v}))return false`); break
          case 'boolean': lines.push(`if(typeof ${v}!=='boolean')return false`); break
          case 'null': lines.push(`if(${v}!==null)return false`); break
        }
      } else {
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
  } else if (schema.required && schema.required.length > 0) {
    if (isObj) {
      const checks = schema.required.map(key => `${v}[${JSON.stringify(key)}]===undefined`)
      lines.push(`if(${checks.join('||')})return false`)
    } else {
      for (const key of schema.required) {
        lines.push(`if(typeof ${v}!=='object'||${v}===null||!(${JSON.stringify(key)} in ${v}))return false`)
      }
    }
  }

  // Early key count for unevaluatedProperties: false (before properties, 10% faster)
  // V8 branch prediction benefits from for-in iteration before property access
  if (schema.unevaluatedProperties === false && schema.properties && schema.required && isObj) {
    const evalResult = collectEvaluated(schema, ctx.schemaMap, ctx.rootDefs)
    if (!evalResult.dynamic && !evalResult.allProps) {
      const knownKeys = evalResult.props
      const propCount = knownKeys.length
      const allRequired = schema.required.length >= propCount &&
        knownKeys.every(k => schema.required.includes(k))
      if (allRequired && propCount > 0) {
        // Adaptive: for-in for <=15 keys (V8 fast path), Object.keys for >15
        if (propCount <= 15) {
          lines.push(`var _n=0;for(var _k in ${v})_n++;if(_n!==${propCount})return false`)
        } else {
          lines.push(`if(Object.keys(${v}).length!==${propCount})return false`)
        }
        ctx._earlyKeyCount = true // flag to skip deferred check
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
  if (schema.minLength !== undefined) lines.push(isStr ? `if(_cpLen(${v})<${schema.minLength})return false` : `if(typeof ${v}==='string'&&_cpLen(${v})<${schema.minLength})return false`)
  if (schema.maxLength !== undefined) lines.push(isStr ? `if(_cpLen(${v})>${schema.maxLength})return false` : `if(typeof ${v}==='string'&&_cpLen(${v})>${schema.maxLength})return false`)

  // array size — skip guard if known array
  if (schema.minItems !== undefined) lines.push(isArr ? `if(${v}.length<${schema.minItems})return false` : `if(Array.isArray(${v})&&${v}.length<${schema.minItems})return false`)
  if (schema.maxItems !== undefined) lines.push(isArr ? `if(${v}.length>${schema.maxItems})return false` : `if(Array.isArray(${v})&&${v}.length>${schema.maxItems})return false`)

  // object size
  if (schema.minProperties !== undefined) lines.push(`if(${objGuard}Object.keys(${v}).length<${schema.minProperties})return false`)
  if (schema.maxProperties !== undefined) lines.push(`if(${objGuard}Object.keys(${v}).length>${schema.maxProperties})return false`)

  if (schema.pattern) {
    // Try inline charCode compilation for simple patterns (avoids RegExp engine)
    const inlineCheck = compilePatternInline(schema.pattern, v)
    if (inlineCheck) {
      lines.push(isStr ? `if(!(${inlineCheck}))return false` : `if(typeof ${v}==='string'&&!(${inlineCheck}))return false`)
    } else {
      const pattern = JSON.stringify(schema.pattern);
      if (!ctx.regExpMap.has(pattern)) {
        const ri = ctx.varCounter++
        ctx.regExpMap.set(pattern, ri)
        ctx.helperCode.push(`const _re${ri}=new RegExp(${pattern})`);
      }
      const ri = ctx.regExpMap.get(pattern);
      lines.push(isStr ? `if(!_re${ri}.test(${v}))return false` : `if(typeof ${v}==='string'&&!_re${ri}.test(${v}))return false`)
    }
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
      ? (propCount <= 15
          ? `var _n=0;for(var _k in ${v})_n++;if(_n!==${propCount})return false`
          : `if(Object.keys(${v}).length!==${propCount})return false`)
      : `for(var _k in ${v})if(${Object.keys(schema.properties).map(k => `_k!==${JSON.stringify(k)}`).join('&&')})return false`
        _deferOrInline(ctx, lines, v, isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      const depChecks = deps.map(d => `!('${esc(d)}' in ${v})`).join('||')
      lines.push(`if(${objGuard}'${esc(key)}' in ${v}&&(${depChecks}))return false`)
    }
  }

  // patternProperties + propertyNames + additionalProperties — unified key iteration
  // Merges up to 3 separate for..in loops into one pass.
  if (schema.patternProperties) {
    const ppEntries = Object.entries(schema.patternProperties)
    const pn = schema.propertyNames && typeof schema.propertyNames === 'object' ? schema.propertyNames : null
    const pi = ctx.varCounter++
    const kVar = `_ppk${pi}`

    // Build pattern matchers: prefer charCodeAt for simple prefixes, fall back to regex
    const matchers = []
    for (const [pat] of ppEntries) {
      const fast = fastPrefixCheck(pat, kVar)
      if (fast) {
        matchers.push({ check: fast })
      } else {
        const ri = ctx.varCounter++
        ctx.closureVars.push(`_re${ri}`)
        ctx.closureVals.push(new RegExp(pat))
        matchers.push({ check: `_re${ri}.test(${kVar})` })
      }
    }

    // Build sub-schema validators as closure vars
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

    if (schema.additionalProperties === false && schema.properties) {
      // Unified loop: properties + patterns + propertyNames + additionalProperties
      ctx._ppHandledAdditional = true
      ctx._ppHandledPropertyNames = !!pn
      const propKeys = Object.keys(schema.properties)
      lines.push(`${guard}{for(const ${kVar} in ${v}){`)
      // propertyNames checks (merged into same loop)
      if (pn) {
        if (pn.minLength !== undefined) lines.push(`if(${kVar}.length<${pn.minLength})return false`)
        if (pn.maxLength !== undefined) lines.push(`if(${kVar}.length>${pn.maxLength})return false`)
        if (pn.pattern) {
          const fast = fastPrefixCheck(pn.pattern, kVar)
          if (fast) {
            lines.push(`if(!(${fast}))return false`)
          } else {
            const ri = ctx.varCounter++
            ctx.closureVars.push(`_re${ri}`)
            ctx.closureVals.push(new RegExp(pn.pattern))
            lines.push(`if(!_re${ri}.test(${kVar}))return false`)
          }
        }
        if (pn.const !== undefined) lines.push(`if(${kVar}!==${JSON.stringify(pn.const)})return false`)
        if (pn.enum) {
          const ei = ctx.varCounter++
          ctx.closureVars.push(`_es${ei}`)
          ctx.closureVals.push(new Set(pn.enum))
          lines.push(`if(!_es${ei}.has(${kVar}))return false`)
        }
      }
      // Check: is key declared or matches a pattern?
      // switch/case: V8 compiles string cases to jump table (faster than chained ===)
      const switchCases = propKeys.map(k => `case ${JSON.stringify(k)}:`).join('')
      lines.push(`switch(${kVar}){${switchCases}break;default:`)
      // Default: key is not declared — must match a pattern
      let patternChecks = []
      for (let i = 0; i < ppEntries.length; i++) {
        patternChecks.push(`if(${matchers[i].check}){if(!_ppf${pi}_${i}(${v}[${kVar}]))return false}else{return false}`)
      }
      if (patternChecks.length > 0) {
        lines.push(patternChecks.join(''))
      } else {
        lines.push(`return false`)
      }
      lines.push(`}`) // end switch
      lines.push(`}}`)
    } else {
      // No additionalProperties: validate matching keys + propertyNames
      ctx._ppHandledPropertyNames = !!pn
      lines.push(`${guard}{for(const ${kVar} in ${v}){`)
      // propertyNames checks (merged)
      if (pn) {
        if (pn.minLength !== undefined) lines.push(`if(${kVar}.length<${pn.minLength})return false`)
        if (pn.maxLength !== undefined) lines.push(`if(${kVar}.length>${pn.maxLength})return false`)
        if (pn.pattern) {
          const fast = fastPrefixCheck(pn.pattern, kVar)
          if (fast) {
            lines.push(`if(!(${fast}))return false`)
          } else {
            const ri = ctx.varCounter++
            ctx.closureVars.push(`_re${ri}`)
            ctx.closureVals.push(new RegExp(pn.pattern))
            lines.push(`if(!_re${ri}.test(${kVar}))return false`)
          }
        }
        if (pn.const !== undefined) lines.push(`if(${kVar}!==${JSON.stringify(pn.const)})return false`)
        if (pn.enum) {
          const ei = ctx.varCounter++
          ctx.closureVars.push(`_es${ei}`)
          ctx.closureVals.push(new Set(pn.enum))
          lines.push(`if(!_es${ei}.has(${kVar}))return false`)
        }
      }
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${matchers[i].check}&&!_ppf${pi}_${i}(${v}[${kVar}]))return false`)
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

  // propertyNames — only emit if not already merged into patternProperties loop
  if (schema.propertyNames && typeof schema.propertyNames === 'object' && !ctx._ppHandledPropertyNames) {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
    lines.push(`${guard}{for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) lines.push(`if(_k${ki}.length<${pn.minLength})return false`)
    if (pn.maxLength !== undefined) lines.push(`if(_k${ki}.length>${pn.maxLength})return false`)
    if (pn.pattern) {
      const fast = fastPrefixCheck(pn.pattern, `_k${ki}`)
      if (fast) {
        lines.push(`if(!(${fast}))return false`)
      } else {
        const ri = ctx.varCounter++
        ctx.closureVars.push(`_re${ri}`)
        ctx.closureVals.push(new RegExp(pn.pattern))
        lines.push(`if(!_re${ri}.test(_k${ki}))return false`)
      }
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
        // Required + type:object — hoist to local to reduce repeated property lookups
        const access = hoisted[key] || `${v}[${JSON.stringify(key)}]`
        const combined = tryGenCombined(prop, access, ctx)
        if (combined) {
          lines.push(combined)
        } else if (needsLocal(prop)) {
          const oi = ctx.varCounter++
          const local = `_r${oi}`
          lines.push(`{const ${local}=${access}`)
          genCode(prop, local, lines, ctx)
          lines.push(`}`)
        } else {
          genCode(prop, access, lines, ctx)
        }
      } else if (isObj) {
        // Optional — hoist to local, check undefined
        const oi = ctx.varCounter++
        const local = `_o${oi}`
        lines.push(`{const ${local}=${v}[${JSON.stringify(key)}];if(${local}!==undefined){`)
        const combined = tryGenCombined(prop, local, ctx)
        if (combined) {
          lines.push(combined)
        } else {
          genCode(prop, local, lines, ctx)
        }
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
    const pfxVar = ctx.varCounter++
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const elem = `_p${pfxVar}_${i}`
      lines.push(isArr
        ? `if(${v}.length>${i}){const ${elem}=${v}[${i}]`
        : `if(Array.isArray(${v})&&${v}.length>${i}){const ${elem}=${v}[${i}]`)
      genCode(schema.prefixItems[i], elem, lines, ctx)
      lines.push(`}`)
    }
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
  // Skip standard anyOf if unevaluatedProperties will handle it (single-pass optimization)
  if (schema.anyOf && schema.unevaluatedProperties === undefined) {
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

  // unevaluatedProperties
  if (schema.unevaluatedProperties !== undefined) {
    const evalResult = collectEvaluated(schema, ctx.schemaMap, ctx.rootDefs)

    if (evalResult.allProps || schema.unevaluatedProperties === true) {
      // All props evaluated or unevaluatedProperties:true — no-op
    } else if (!evalResult.dynamic) {
      // Tier 1-2: all evaluated props known at compile-time — ZERO COST
      const knownKeys = evalResult.props
      const propCount = knownKeys.length

      if (schema.unevaluatedProperties === false) {
        const allRequired = schema.required && schema.required.length >= propCount &&
          knownKeys.every(k => schema.required.includes(k))

        let inner
        if (allRequired && propCount > 0) {
          // TRICK 1: required covers all — key count check only
          if (!ctx._earlyKeyCount) {
            // Adaptive: for-in for <=15 keys, Object.keys for >15
            inner = propCount <= 15
              ? `var _n=0;for(var _k in ${v})_n++;if(_n!==${propCount})return false`
              : `if(Object.keys(${v}).length!==${propCount})return false`
                        _deferOrInline(ctx, lines, v, isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
          }
          // else: already emitted early (before properties)
        } else if (propCount > 0) {
          // TRICK 3: charCodeAt switch tree
          inner = genCharCodeSwitch(knownKeys, v)
                    _deferOrInline(ctx, lines, v, isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
        } else {
          inner = `for(var _k in ${v})return false`
                    _deferOrInline(ctx, lines, v, isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
        }
      } else if (typeof schema.unevaluatedProperties === 'object') {
        // unevaluatedProperties: {schema} — validate unknown keys
        const ui = ctx.varCounter++
        const ukVar = `_uk${ui}`
        const subLines = []
        genCode(schema.unevaluatedProperties, `${v}[${ukVar}]`, subLines, ctx)
        if (subLines.length > 0) {
          const check = subLines.join(';')
          const keyChecks = knownKeys.map(k => `${ukVar}===${JSON.stringify(k)}`).join('||')
          const skipKnown = knownKeys.length > 0 ? `if(${keyChecks})continue;` : ''
          const inner = `for(var ${ukVar} in ${v}){${skipKnown}${check}}`
                    _deferOrInline(ctx, lines, v, isObj ? inner : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
        }
      }
    } else {
      // Tier 2.5 / Tier 3: dynamic — runtime tracking needed
      // Compute base props: only unconditionally evaluated (properties, allOf-static, $ref)
      const baseResult = { props: [], items: null, allProps: false, allItems: false, dynamic: false }
      if (schema.properties) {
        for (const k of Object.keys(schema.properties)) {
          if (!baseResult.props.includes(k)) baseResult.props.push(k)
        }
      }
      if (schema.allOf) {
        for (const sub of schema.allOf) {
          const subR = collectEvaluated(sub, ctx.schemaMap, ctx.rootDefs)
          if (!subR.dynamic && subR.props) {
            for (const k of subR.props) {
              if (!baseResult.props.includes(k)) baseResult.props.push(k)
            }
          }
        }
      }
      const baseProps = baseResult.props
      const branchKeyword = schema.anyOf ? 'anyOf' : schema.oneOf ? 'oneOf' : null

      if (schema.unevaluatedProperties === false) {
        if (schema.if && (schema.then || schema.else) && !branchKeyword && !schema.patternProperties && !schema.dependentSchemas) {
          // Tier 2.5: if/then/else — re-emit if function + branch-inline duplication
          // Can't reuse _if from above (block-scoped), so regenerate
          const ifLines2 = []
          genCode(schema.if, '_iv2', ifLines2, ctx)
          const ufi = ctx.varCounter++
          const ifFn2 = ifLines2.length === 0
            ? `function(_iv2){return true}`
            : `function(_iv2){${ifLines2.join(';')};return true}`

          // if props are only evaluated when if matches (spec: failed applicators produce no annotations)
          const ifProps = []
          if (schema.if && schema.if.properties) ifProps.push(...Object.keys(schema.if.properties))
          const thenEval = schema.then ? collectEvaluated(schema.then, ctx.schemaMap, ctx.rootDefs) : { props: [] }
          const elseEval = schema.else ? collectEvaluated(schema.else, ctx.schemaMap, ctx.rootDefs) : { props: [] }
          const uniqueThen = [...new Set([...baseProps, ...ifProps, ...(thenEval.props || [])])]
          const uniqueElse = [...new Set([...baseProps, ...(elseEval.props || [])])]

          const thenCheck = genCharCodeSwitch(uniqueThen, v)
          const elseCheck = genCharCodeSwitch(uniqueElse, v)
          const guard = isObj ? '' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v}))`
          lines.push(`${guard}{const _uif${ufi}=${ifFn2};if(_uif${ufi}(${v})){${thenCheck}}else{${elseCheck}}}`)
        } else if (branchKeyword) {
          // Tier 3: anyOf/oneOf — runtime tracking
          const branches = schema[branchKeyword]
          const branchProps = []
          for (const sub of branches) {
            const subResult = collectEvaluated(sub, ctx.schemaMap, ctx.rootDefs)
            branchProps.push(subResult.props || [])
          }
          const allDynamicKeys = [...new Set(branchProps.flat())]
          const dynamicOnly = allDynamicKeys.filter(k => !baseProps.includes(k))

          if (dynamicOnly.length > 0 && dynamicOnly.length <= 32) {
            // TRICK 5: bit-packed evaluated set — SINGLE PASS (validation + tracking combined)
            const ei = ctx.varCounter++
            const evVar = `_ev${ei}`
            const bitMap = new Map()
            dynamicOnly.forEach((k, i) => bitMap.set(k, i))
            const branchMasks = branchProps.map(props => {
              let mask = 0
              for (const p of props) {
                if (bitMap.has(p)) mask |= (1 << bitMap.get(p))
              }
              return mask
            })

            // TRICK 4: Direct function calls — no array, no loop, V8 can inline
            const bfi = ctx.varCounter++
            lines.push(`{let ${evVar}=0`)
            const fnVars = []
            for (let i = 0; i < branches.length; i++) {
              const subLines2 = []
              genCode(branches[i], '_bv', subLines2, ctx)
              const fnVar = `_bf${bfi}_${i}`
              fnVars.push(fnVar)
              const fnBody = subLines2.length === 0 ? `function(_bv){return true}` : `function(_bv){${subLines2.join(';')};return true}`
              lines.push(`const ${fnVar}=${fnBody}`)
            }
            if (branchKeyword === 'oneOf') {
              // oneOf: exactly one must match — direct calls
              lines.push(`let _oc${bfi}=0`)
              for (let i = 0; i < branches.length; i++) {
                lines.push(`if(${fnVars[i]}(${v})){_oc${bfi}++;${evVar}=${branchMasks[i]};if(_oc${bfi}>1)return false}`)
              }
              lines.push(`if(_oc${bfi}!==1)return false`)
            } else {
              // anyOf: at least one must match — direct calls, collect all
              lines.push(`let _am${bfi}=false`)
              for (let i = 0; i < branches.length; i++) {
                lines.push(`if(${fnVars[i]}(${v})){_am${bfi}=true;${evVar}|=${branchMasks[i]}}`)
              }
              lines.push(`if(!_am${bfi})return false`)
            }

            // Final check: static keys inline + dynamic keys via bitmask
            const staticCheck = baseProps.length > 0 ? baseProps.map(k => `_k===${JSON.stringify(k)}`).join('||') : ''
            const groups = new Map()
            for (const k of dynamicOnly) {
              const cc = k.charCodeAt(0)
              if (!groups.has(cc)) groups.set(cc, [])
              groups.get(cc).push(k)
            }
            let switchCases = ''
            for (const [cc, groupKeys] of groups) {
              const cond = groupKeys.map(k => `_k===${JSON.stringify(k)}&&(${evVar}&${1 << bitMap.get(k)})`).join('||')
              switchCases += `case ${cc}:if(${cond})continue;break;`
            }
            const dynamicCheck = `switch(_k.charCodeAt(0)){${switchCases}default:break}`
            const inner = staticCheck
              ? `for(var _k in ${v}){if(${staticCheck})continue;${dynamicCheck}return false}`
              : `for(var _k in ${v}){${dynamicCheck}return false}`
                        _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
          } else {
            // Fallback: plain object tracking
            const ei = ctx.varCounter++
            const evVar = `_ev${ei}`
            const fns = []
            for (let i = 0; i < branches.length; i++) {
              const subLines2 = []
              genCode(branches[i], '_bv', subLines2, ctx)
              fns.push(subLines2.length === 0 ? `function(_bv){return true}` : `function(_bv){${subLines2.join(';')};return true}`)
            }
            const bfi = ctx.varCounter++
            ctx.closureVars.push(`_bk${bfi}`)
            ctx.closureVals.push(branchProps)
            lines.push(`{const ${evVar}={}`)
            for (const k of baseProps) lines.push(`${evVar}[${JSON.stringify(k)}]=1`)
            lines.push(`const _bf${bfi}=[${fns.join(',')}]`)
            if (branchKeyword === 'oneOf') {
              // Single pass: validate oneOf (exactly one) + track evaluated
              lines.push(`let _oc${bfi}=0;for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){_oc${bfi}++;for(const _p of _bk${bfi}[_bi])${evVar}[_p]=1;if(_oc${bfi}>1)return false}}if(_oc${bfi}!==1)return false`)
            } else {
              // Single pass: validate anyOf (at least one) + track all matching
              lines.push(`let _am${bfi}=false;for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){_am${bfi}=true;for(const _p of _bk${bfi}[_bi])${evVar}[_p]=1}}if(!_am${bfi})return false`)
            }
            const inner = `for(var _k in ${v}){if(!${evVar}[_k])return false}`
                        _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
          }
        } else if (schema.dependentSchemas) {
          // dependentSchemas: conditional merge at runtime
          const ei = ctx.varCounter++
          const evVar = `_ev${ei}`
          lines.push(`{const ${evVar}={}`)
          for (const k of baseProps) lines.push(`${evVar}[${JSON.stringify(k)}]=1`)
          for (const [trigger, depSchema] of Object.entries(schema.dependentSchemas)) {
            const depResult = collectEvaluated(depSchema, ctx.schemaMap, ctx.rootDefs)
            if (depResult.props && depResult.props.length > 0) {
              lines.push(`if(${JSON.stringify(trigger)} in ${v}){${depResult.props.map(k => `${evVar}[${JSON.stringify(k)}]=1`).join(';')}}`)
            }
          }
          const inner = `for(var _k in ${v}){if(!${evVar}[_k])return false}`
                    _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
        } else {
          // General fallback: collect all patternProperties from root + allOf sub-schemas + if
          // and use runtime regex matching
          const allPatterns = []
          if (schema.patternProperties) {
            allPatterns.push(...Object.keys(schema.patternProperties))
          }
          if (schema.allOf) {
            for (const sub of schema.allOf) {
              if (sub && sub.patternProperties) {
                allPatterns.push(...Object.keys(sub.patternProperties))
              }
            }
          }
          // lone if (no then/else) still contributes annotations when it passes
          if (schema.if && !schema.then && !schema.else && schema.if.patternProperties) {
            allPatterns.push(...Object.keys(schema.if.patternProperties))
          }
          if (allPatterns.length > 0) {
            const ei = ctx.varCounter++
            const evVar = `_ev${ei}`
            lines.push(`{const ${evVar}={}`)
            for (const k of baseProps) lines.push(`${evVar}[${JSON.stringify(k)}]=1`)
            const reVars = []
            for (const pat of allPatterns) {
              const ri = ctx.varCounter++
              ctx.closureVars.push(`_ure${ri}`)
              ctx.closureVals.push(new RegExp(pat))
              reVars.push(`_ure${ri}`)
            }
            if (schema.if && !schema.then && !schema.else) {
              // Lone if: run the if check first; if it passes, its patternProperties contribute
              const ifLines2 = []
              genCode(schema.if, '_iv2', ifLines2, ctx)
              const ufi = ctx.varCounter++
              const ifFn = ifLines2.length === 0
                ? `function(_iv2){return true}`
                : `function(_iv2){${ifLines2.join(';')};return true}`
              // Mark keys matching if's patterns as evaluated only when if passes
              const ifPatterns = schema.if.patternProperties ? Object.keys(schema.if.patternProperties) : []
              const ifReVars = []
              for (const pat of ifPatterns) {
                const ri = ctx.varCounter++
                ctx.closureVars.push(`_ure${ri}`)
                ctx.closureVals.push(new RegExp(pat))
                ifReVars.push(`_ure${ri}`)
              }
              const rootReVars = []
              if (schema.patternProperties) {
                for (const pat of Object.keys(schema.patternProperties)) {
                  const ri = ctx.varCounter++
                  ctx.closureVars.push(`_ure${ri}`)
                  ctx.closureVals.push(new RegExp(pat))
                  rootReVars.push(`_ure${ri}`)
                }
              }
              const rootPatCheck = rootReVars.map(rv => `if(${rv}.test(_k))continue;`).join('')
              const ifPatCheck = ifReVars.map(rv => `if(${rv}.test(_k))continue;`).join('')
              const inner = `const _uif${ufi}=${ifFn};if(_uif${ufi}(${v})){for(var _k in ${v}){if(${evVar}[_k])continue;${rootPatCheck}${ifPatCheck}return false}}else{for(var _k in ${v}){if(${evVar}[_k])continue;${rootPatCheck}return false}}`
                            _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
            } else {
              const inner = `for(var _k in ${v}){if(${evVar}[_k])continue;${reVars.map(rv => `if(${rv}.test(_k)){${evVar}[_k]=1;continue}`).join('')}return false}`
                            _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
            }
          }
        }
      } else if (typeof schema.unevaluatedProperties === 'object') {
        // Tier 3 with schema: validate unknown keys against sub-schema
        const ei = ctx.varCounter++
        const evVar = `_ev${ei}`
        const ukVar = `_uk${ei}`
        lines.push(`{const ${evVar}={}`)
        for (const k of baseProps) lines.push(`${evVar}[${JSON.stringify(k)}]=1`)

        if (branchKeyword) {
          const branches = schema[branchKeyword]
          const branchProps = []
          for (const sub of branches) {
            const subResult = collectEvaluated(sub, ctx.schemaMap, ctx.rootDefs)
            branchProps.push(subResult.props || [])
          }
          const fns = []
          for (let i = 0; i < branches.length; i++) {
            const subLines2 = []
            genCode(branches[i], '_bv', subLines2, ctx)
            fns.push(subLines2.length === 0 ? `function(_bv){return true}` : `function(_bv){${subLines2.join(';')};return true}`)
          }
          const bfi = ctx.varCounter++
          ctx.closureVars.push(`_bk${bfi}`)
          ctx.closureVals.push(branchProps)
          lines.push(`const _bf${bfi}=[${fns.join(',')}]`)
          if (branchKeyword === 'oneOf') {
            lines.push(`for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){for(const _p of _bk${bfi}[_bi])${evVar}[_p]=1;break}}`)
          } else {
            lines.push(`for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){for(const _p of _bk${bfi}[_bi])${evVar}[_p]=1}}`)
          }
        }

        const subLines2 = []
        genCode(schema.unevaluatedProperties, `${v}[${ukVar}]`, subLines2, ctx)
        if (subLines2.length > 0) {
          const check = subLines2.join(';')
          const inner = `for(var ${ukVar} in ${v}){if(${evVar}[${ukVar}])continue;${check}}`
                    _deferOrInline(ctx, lines, v, isObj ? inner + '}' : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}}`)
        } else {
          lines.push('}')
        }
      }
    }
  }

  // unevaluatedItems
  if (schema.unevaluatedItems !== undefined) {
    const evalResult = collectEvaluated(schema, ctx.schemaMap, ctx.rootDefs)

    // Check if allItems from anyOf/oneOf branches with `items` keyword needs dynamic tracking
    const branchKw = schema.anyOf ? 'anyOf' : schema.oneOf ? 'oneOf' : null
    const hasConditionalItems = evalResult.allItems && evalResult.dynamic && branchKw &&
      schema[branchKw].some(sub => sub && typeof sub === 'object' && ((sub.items && typeof sub.items === 'object') || sub.items === true))

    if (schema.unevaluatedItems === true || (evalResult.allItems && !hasConditionalItems)) {
      // All items evaluated or unevaluatedItems:true — no-op
    } else if (!evalResult.dynamic) {
      // Static: all evaluated items known at compile-time
      if (schema.unevaluatedItems === false) {
        // TRICK 6: Array.length comparison only
        const maxIdx = evalResult.items || 0
        const inner = `if(${v}.length>${maxIdx})return false`
                _deferOrInline(ctx, lines, v, isArr ? inner : `if(Array.isArray(${v})){${inner}}`)
      } else if (typeof schema.unevaluatedItems === 'object') {
        const maxIdx = evalResult.items || 0
        const ui = ctx.varCounter++
        const elemVar = `_ue${ui}`
        const idxVar = `_ui${ui}`
        const subLines = []
        genCode(schema.unevaluatedItems, elemVar, subLines, ctx)
        if (subLines.length > 0) {
          const check = subLines.join(';')
          const inner = `for(let ${idxVar}=${maxIdx};${idxVar}<${v}.length;${idxVar}++){const ${elemVar}=${v}[${idxVar}];${check}}`
                    _deferOrInline(ctx, lines, v, isArr ? inner : `if(Array.isArray(${v})){${inner}}`)
        }
      }
    } else {
      // Dynamic: runtime tracking of max evaluated index
      // Compute baseIdx from unconditional sources only (root prefixItems/items, allOf)
      let baseIdx = 0
      if (schema.prefixItems) baseIdx = Math.max(baseIdx, schema.prefixItems.length)
      if (schema.items && typeof schema.items === 'object') baseIdx = Infinity // items: schema → all evaluated
      if (schema.allOf) {
        for (const sub of schema.allOf) {
          const subR = collectEvaluated(sub, ctx.schemaMap, ctx.rootDefs)
          if (subR.items !== null) baseIdx = Math.max(baseIdx, subR.items)
          if (subR.allItems) baseIdx = Infinity
        }
      }
      if (baseIdx === Infinity) baseIdx = 0 // allItems already handled above
      const branchKeyword = schema.anyOf ? 'anyOf' : schema.oneOf ? 'oneOf' : null

      if (branchKeyword && (schema.unevaluatedItems === false || typeof schema.unevaluatedItems === 'object')) {
        // anyOf/oneOf: each branch may evaluate different number of items
        const branches = schema[branchKeyword]
        const branchMaxIdx = []
        const branchAllItems = []
        for (const sub of branches) {
          const subR = collectEvaluated(sub, ctx.schemaMap, ctx.rootDefs)
          branchMaxIdx.push(subR.items || 0)
          branchAllItems.push(subR.allItems)
        }
        // Runtime: find max evaluated index across all matching branches
        const fns = []
        for (let i = 0; i < branches.length; i++) {
          const subLines2 = []
          genCode(branches[i], '_bv', subLines2, ctx)
          fns.push(subLines2.length === 0 ? `function(_bv){return true}` : `function(_bv){${subLines2.join(';')};return true}`)
        }
        const bfi = ctx.varCounter++
        const ei = ctx.varCounter++
        const evVar = `_eidx${ei}`
        lines.push(`{let ${evVar}=${baseIdx}`)
        lines.push(`const _bf${bfi}=[${fns.join(',')}]`)
        const maxExprs = branchMaxIdx.map((m, i) => {
          if (branchAllItems[i]) return `_bi===${i}?${v}.length`
          return `_bi===${i}?${Math.max(m, baseIdx)}`
        }).join(':') + `:${baseIdx}`
        if (branchKeyword === 'oneOf') {
          lines.push(`for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){${evVar}=${maxExprs};break}}`)
        } else {
          lines.push(`for(let _bi=0;_bi<_bf${bfi}.length;_bi++){if(_bf${bfi}[_bi](${v})){const _m=${maxExprs};if(_m>${evVar})${evVar}=_m}}`)
        }
        if (schema.unevaluatedItems === false) {
          const inner = `if(${v}.length>${evVar})return false`
                    _deferOrInline(ctx, lines, v, isArr ? inner + '}' : `if(Array.isArray(${v})){${inner}}}`)
        } else {
          const ui = ctx.varCounter++
          const elemVar = `_ue${ui}`
          const idxVar = `_ui${ui}`
          const subLines = []
          genCode(schema.unevaluatedItems, elemVar, subLines, ctx)
          if (subLines.length > 0) {
            const check = subLines.join(';')
            const inner = `for(let ${idxVar}=${evVar};${idxVar}<${v}.length;${idxVar}++){const ${elemVar}=${v}[${idxVar}];${check}}`
                        _deferOrInline(ctx, lines, v, isArr ? inner + '}' : `if(Array.isArray(${v})){${inner}}}`)
          } else {
            lines.push('}')
          }
        }
      } else if (schema.if && (schema.unevaluatedItems === false || typeof schema.unevaluatedItems === 'object')) {
        // if/then/else (or lone if): branch-specific max index
        const ifEval = collectEvaluated(schema.if, ctx.schemaMap, ctx.rootDefs)
        const thenEval = schema.then ? collectEvaluated(schema.then, ctx.schemaMap, ctx.rootDefs) : { items: null }
        const elseEval = schema.else ? collectEvaluated(schema.else, ctx.schemaMap, ctx.rootDefs) : { items: null }
        const ifIdx = ifEval.items || 0
        const thenIdx = Math.max(baseIdx, ifIdx, thenEval.items || 0)
        const elseIdx = Math.max(baseIdx, elseEval.items || 0)

        const ifLines2 = []
        genCode(schema.if, '_iv3', ifLines2, ctx)
        const ufi = ctx.varCounter++
        const ifFn3 = ifLines2.length === 0
          ? `function(_iv3){return true}`
          : `function(_iv3){${ifLines2.join(';')};return true}`

        if (schema.unevaluatedItems === false) {
          const guard = isArr ? '' : `if(Array.isArray(${v}))`
          lines.push(`${guard}{const _uif${ufi}=${ifFn3};if(_uif${ufi}(${v})){if(${v}.length>${thenIdx})return false}else{if(${v}.length>${elseIdx})return false}}`)
        }
      } else if ((schema.contains || (schema.allOf && schema.allOf.some(s => s && s.contains))) && (schema.unevaluatedItems === false || typeof schema.unevaluatedItems === 'object')) {
        // contains + unevaluatedItems: per-item tracking of which items are matched by contains
        // Collect contains from root and allOf sub-schemas
        const allContains = []
        if (schema.contains) allContains.push(schema.contains)
        if (schema.allOf) {
          for (const sub of schema.allOf) {
            if (sub && sub.contains) allContains.push(sub.contains)
          }
        }
        const ci = ctx.varCounter++
        const evArr = `_cev${ci}`
        const containsFns = []
        for (const c of allContains) {
          const cLines = []
          genCode(c, '_cv', cLines, ctx)
          containsFns.push(cLines.length === 0
            ? `function(_cv){return true}`
            : `function(_cv){${cLines.join(';')};return true}`)
        }
        const cfnArr = `_cfn${ci}`
        lines.push(`{const ${cfnArr}=[${containsFns.join(',')}]`)
        // Mark items evaluated by prefixItems
        lines.push(`const ${evArr}=[]`)
        if (baseIdx > 0) {
          lines.push(`for(let _i=0;_i<${Math.min(baseIdx, 1000)};_i++)${evArr}[_i]=true`)
        }
        // Mark items matched by each contains function
        lines.push(`if(Array.isArray(${v})){for(let _ci=0;_ci<${v}.length;_ci++){for(let _cj=0;_cj<${cfnArr}.length;_cj++){if(${cfnArr}[_cj](${v}[_ci])){${evArr}[_ci]=true;break}}}}`)
        if (schema.unevaluatedItems === false) {
          const inner = `if(Array.isArray(${v})){for(let _ci=0;_ci<${v}.length;_ci++){if(!${evArr}[_ci])return false}}`
                    _deferOrInline(ctx, lines, v, inner + '}')
        } else {
          // unevaluatedItems: {schema}
          const ui = ctx.varCounter++
          const elemVar = `_ue${ui}`
          const subLines = []
          genCode(schema.unevaluatedItems, elemVar, subLines, ctx)
          if (subLines.length > 0) {
            const check = subLines.join(';')
            const inner = `if(Array.isArray(${v})){for(let _ci=0;_ci<${v}.length;_ci++){if(!${evArr}[_ci]){const ${elemVar}=${v}[_ci];${check}}}}`
                        _deferOrInline(ctx, lines, v, inner + '}')
          } else {
            lines.push('}')
          }
        }
      } else if (schema.unevaluatedItems === false) {
        // Fallback: use static base index (may not be fully correct for all dynamic cases)
        const maxIdx = evalResult.items || 0
        const inner = `if(${v}.length>${maxIdx})return false`
                _deferOrInline(ctx, lines, v, isArr ? inner : `if(Array.isArray(${v})){${inner}}`)
      }
    }
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
    ? `{if(${v}.length!==10||!/^\\d{4}-\\d{2}-\\d{2}$/.test(${v}))return false;const _dm=+${v}.slice(5,7),_dd=+${v}.slice(8,10);if(_dm<1||_dm>12||_dd<1||_dd>31)return false}`
    : `if(typeof ${v}==='string'){if(${v}.length!==10||!/^\\d{4}-\\d{2}-\\d{2}$/.test(${v}))return false;const _dm=+${v}.slice(5,7),_dd=+${v}.slice(8,10);if(_dm<1||_dm>12||_dd<1||_dd>31)return false}`,
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

// Resolve child path at codegen time when parent is a static string literal.
// This enables frozen pre-allocation for ALL nested error objects.
function childPathExpr(parentExpr, suffix) {
  if (!parentExpr) return `'/${suffix}'`
  if (parentExpr.startsWith("'") && !parentExpr.includes('+')) {
    // Static parent: resolve at codegen time → '/parent/child' (single literal)
    return `'${parentExpr.slice(1, -1)}/${suffix}'`
  }
  // Dynamic parent: keep as concat expression
  return `${parentExpr}+'/${suffix}'`
}

// Compile simple regex patterns to inline charCode checks — avoids RegExp engine overhead.
// Returns null if pattern is too complex for inline compilation.
// Handles: ^[charclass]{n}$, ^[charclass]+$, ^[charclass]*$, ^[charclass]{m,n}$
function compilePatternInline(pattern, varName) {
  // Match: ^[chars]{exact}$ — e.g., ^[0-9]{5}$
  let m = pattern.match(/^\^(\[[\w\-]+\])\{(\d+)\}\$$/)
  if (m) {
    const rangeCheck = charClassToCheck(m[1], `${varName}.charCodeAt(_pi)`)
    if (!rangeCheck) return null
    const len = parseInt(m[2])
    return `${varName}.length===${len}&&(()=>{for(let _pi=0;_pi<${len};_pi++){if(!(${rangeCheck}))return false}return true})()`
  }
  // Match: ^[chars]+$ — e.g., ^[a-z]+$
  m = pattern.match(/^\^(\[[\w\-]+\])\+\$$/)
  if (m) {
    const rangeCheck = charClassToCheck(m[1], `${varName}.charCodeAt(_pi)`)
    if (!rangeCheck) return null
    return `${varName}.length>0&&(()=>{for(let _pi=0;_pi<${varName}.length;_pi++){if(!(${rangeCheck}))return false}return true})()`
  }
  // Match: ^[chars]{m,n}$ — e.g., ^[a-zA-Z]{2,50}$
  m = pattern.match(/^\^(\[[\w\-]+\])\{(\d+),(\d+)\}\$$/)
  if (m) {
    const rangeCheck = charClassToCheck(m[1], `${varName}.charCodeAt(_pi)`)
    if (!rangeCheck) return null
    const min = parseInt(m[2]), max = parseInt(m[3])
    return `${varName}.length>=${min}&&${varName}.length<=${max}&&(()=>{for(let _pi=0;_pi<${varName}.length;_pi++){if(!(${rangeCheck}))return false}return true})()`
  }
  return null
}

// Convert [charclass] to charCode range check expression.
// Supports: [0-9], [a-z], [A-Z], [a-zA-Z], [a-zA-Z0-9], [0-9a-f], etc.
function charClassToCheck(charClass, codeExpr) {
  // Strip brackets
  const inner = charClass.slice(1, -1)
  // Parse ranges
  const ranges = []
  let i = 0
  while (i < inner.length) {
    if (i + 2 < inner.length && inner[i + 1] === '-') {
      ranges.push([inner.charCodeAt(i), inner.charCodeAt(i + 2)])
      i += 3
    } else {
      ranges.push([inner.charCodeAt(i), inner.charCodeAt(i)])
      i++
    }
  }
  if (ranges.length === 0) return null
  // Generate check: (c >= 48 && c <= 57) || (c >= 65 && c <= 90)
  const checks = ranges.map(([lo, hi]) =>
    lo === hi ? `${codeExpr}===${lo}` : `(${codeExpr}>=${lo}&&${codeExpr}<=${hi})`
  )
  return checks.join('||')
}

// Same but for dynamic segments (array indices)
function childPathDynExpr(parentExpr, indexExpr) {
  if (!parentExpr) return `'/'+${indexExpr}`
  return `${parentExpr}+'/'+${indexExpr}`
}

// Detect simple prefix patterns like "^x-", "^_", "^prefix" and generate fast charCodeAt checks
// Returns a JS expression string or null if pattern is too complex
function fastPrefixCheck(pattern, keyVar) {
  // Match patterns like ^literal (no regex metacharacters after ^)
  const m = pattern.match(/^\^([a-zA-Z0-9_\-./]+)$/)
  if (!m) return null
  const prefix = m[1]
  if (prefix.length === 0 || prefix.length > 8) return null // too long = diminishing returns
  if (prefix.length === 1) {
    return `${keyVar}.charCodeAt(0)===${prefix.charCodeAt(0)}`
  }
  if (prefix.length === 2) {
    return `${keyVar}.charCodeAt(0)===${prefix.charCodeAt(0)}&&${keyVar}.charCodeAt(1)===${prefix.charCodeAt(1)}`
  }
  // For longer prefixes, startsWith is cleaner and still faster than regex
  return `${keyVar}.startsWith(${JSON.stringify(prefix)})`
}

// Generate a charCodeAt(0)-based switch tree for fast key validation.
// V8 compiles switch to jump tables — O(1) dispatch vs O(n) chain.
function genCharCodeSwitch(keys, v) {
  if (keys.length === 0) return `for(var _k in ${v})return false`
  if (keys.length <= 3) {
    // Small set: simple chain is faster than switch overhead
    return `for(var _k in ${v})if(${keys.map(k => `_k!==${JSON.stringify(k)}`).join('&&')})return false`
  }

  // Group keys by first charCode
  const groups = new Map()
  for (const k of keys) {
    const cc = k.charCodeAt(0)
    if (!groups.has(cc)) groups.set(cc, [])
    groups.get(cc).push(k)
  }

  let cases = ''
  for (const [cc, groupKeys] of groups) {
    const cond = groupKeys.map(k => `_k===${JSON.stringify(k)}`).join('||')
    cases += `case ${cc}:if(${cond})continue;break;`
  }

  return `for(var _k in ${v}){switch(_k.charCodeAt(0)){${cases}default:break}return false}`
}

// --- Error-collecting codegen: same checks, but pushes errors instead of returning false ---
// Returns a function: (data, allErrors) => { valid, errors }
// Valid path is still fast — only error path does extra work.
function compileToJSCodegenWithErrors(schema, schemaMap) {
  // Bail on unevaluated keywords — error codegen doesn't support them yet
  if (typeof schema === 'object' && schema !== null) {
    const s = JSON.stringify(schema)
    if (s.includes('unevaluatedProperties') || s.includes('unevaluatedItems')) return null
    // Bail on self-referencing schemas — error codegen doesn't support recursion
    if (s.includes('"$ref":"#"')) return null
  }
  if (typeof schema === 'boolean') {
    return schema
      ? () => ({ valid: true, errors: [] })
      : () => ({ valid: false, errors: [{ keyword: 'false schema', instancePath: '', schemaPath: '#', params: {}, message: 'boolean schema is false' }] })
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

  // Build anchors map for $ref/#anchor and $dynamicRef resolution
  const eRootDefs = schema.$defs || schema.definitions || null
  const eAnchors = {}
  if (schema.$dynamicAnchor) eAnchors['#' + schema.$dynamicAnchor] = schema
  if (schema.$anchor) eAnchors['#' + schema.$anchor] = schema
  if (eRootDefs) {
    for (const def of Object.values(eRootDefs)) {
      if (def && typeof def === 'object') {
        if (def.$dynamicAnchor) eAnchors['#' + def.$dynamicAnchor] = def
        if (def.$anchor) eAnchors['#' + def.$anchor] = def
      }
    }
  }
  if (schemaMap) {
    for (const ext of schemaMap.values()) {
      if (ext && typeof ext === 'object') {
        if (ext.$dynamicAnchor && !eAnchors['#' + ext.$dynamicAnchor]) eAnchors['#' + ext.$dynamicAnchor] = ext
        if (ext.$anchor && !eAnchors['#' + ext.$anchor]) eAnchors['#' + ext.$anchor] = ext
      }
    }
  }

  const ctx = { varCounter: 0, helperCode: [], rootDefs: eRootDefs, refStack: new Set(), schemaMap: schemaMap || null, anchors: eAnchors, rootSchema: schema }
  ctx.helperCode.push('const _cpLen=s=>{let n=0;for(const _ of s)n++;return n}')
  const lines = []
  genCodeE(schema, 'd', '', lines, ctx, '#')
  if (lines.length === 0) return (d) => ({ valid: true, errors: [] })

  const checkStr = lines.join('\n  ')
  let body
  if (ctx.usesRecursion) {
    body = `const _e=[];\n  ` +
      (ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : '') +
      `function _validateE(d,_all,_e){\n  ${checkStr}\n  }\n  _validateE(d,_all,_e);\n  ` +
      `return{valid:_e.length===0,errors:_e}`
  } else {
    body = `const _e=[];\n  ` +
      (ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : '') +
      checkStr +
      `\n  return{valid:_e.length===0,errors:_e}`
  }
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
function genCodeE(schema, v, pathExpr, lines, ctx, schemaPrefix) {
  if (!schemaPrefix) schemaPrefix = '#'
  if (typeof schema !== 'object' || schema === null) return
  if (!ctx.regExpMap) {
    ctx.regExpMap = new Map();
  }
  // $ref — resolve local and cross-schema refs
  if (schema.$ref) {
    // Self-reference "#" — no-op (permissive) to avoid infinite recursion
    if (schema.$ref === '#') return
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeE(ctx.rootDefs[m[1]], v, pathExpr, lines, ctx, schemaPrefix)
      ctx.refStack.delete(schema.$ref)
      return
    }
    // Anchor ref: "#foo" — resolve via rootDefs or anchors map
    if (!m && schema.$ref.startsWith('#') && !schema.$ref.startsWith('#/')) {
      const entry = ctx.rootDefs && ctx.rootDefs[schema.$ref]
      const anchorTarget = entry && entry.raw ? entry.raw : (ctx.anchors && ctx.anchors[schema.$ref])
      if (anchorTarget) {
        if (ctx.refStack.has(schema.$ref)) return
        ctx.refStack.add(schema.$ref)
        genCodeE(anchorTarget, v, pathExpr, lines, ctx, schemaPrefix)
        ctx.refStack.delete(schema.$ref)
        return
      }
    }
    if (ctx.schemaMap && ctx.schemaMap.has(schema.$ref)) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeE(ctx.schemaMap.get(schema.$ref), v, pathExpr, lines, ctx, schemaPrefix)
      ctx.refStack.delete(schema.$ref)
      return
    }
  }

  // $dynamicRef — resolve via anchors map
  if (schema.$dynamicRef) {
    const anchorKey = schema.$dynamicRef.startsWith('#') ? schema.$dynamicRef : '#' + schema.$dynamicRef
    if (ctx.anchors && ctx.anchors[anchorKey]) {
      const target = ctx.anchors[anchorKey]
      if (target === ctx.rootSchema) {
        // Self-recursive: generate _validateE call
        ctx.usesRecursion = true
        lines.push(`_validateE(${v},_all,_e)`)
      } else {
        const refKey = '$dynamicRef:' + anchorKey
        if (!ctx.refStack.has(refKey)) {
          ctx.refStack.add(refKey)
          genCodeE(target, v, pathExpr, lines, ctx, schemaPrefix)
          ctx.refStack.delete(refKey)
        }
      }
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
        case 'boolean': return `typeof ${v}==='boolean'`
        case 'null': return `${v}===null`
        default: return 'true'
      }
    })
    const expected = types.join(', ')
    lines.push(`if(!(${conds.join('||')})){_e.push({keyword:'type',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/type',params:{type:'${expected}'},message:'must be ${expected}'});if(!_all)return{valid:false,errors:_e}}`)
  }

  // In error mode, never assume type — always guard (data may have failed type check but allErrors continues)
  const isObj = false
  const isArr = false
  const isStr = false
  const isNum = false

  const fail = (keyword, schemaSuffix, paramsCode, msgCode) => {
    const sp = schemaPrefix + '/' + schemaSuffix
    return `_e.push({keyword:'${keyword}',instancePath:${pathExpr||'""'},schemaPath:'${sp}',params:${paramsCode},message:${msgCode}});if(!_all)return{valid:false,errors:_e}`
  }

  // enum
  if (schema.enum) {
    const vals = schema.enum
    const primitives = vals.filter(v => v === null || typeof v !== 'object')
    const objects = vals.filter(v => v !== null && typeof v === 'object')
    const primChecks = primitives.map(p => `${v}===${JSON.stringify(p)}`).join('||')
    const objChecks = objects.map(o => `JSON.stringify(${v})===${JSON.stringify(JSON.stringify(o))}`).join('||')
    const allChecks = [primChecks, objChecks].filter(Boolean).join('||')
    lines.push(`if(!(${allChecks || 'false'})){${fail('enum', 'enum', `{allowedValues:${JSON.stringify(schema.enum)}}`, "'must be equal to one of the allowed values'")}}`)
  }

  // const — use canonical (sorted-key) comparison for objects
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      lines.push(`if(${v}!==${JSON.stringify(cv)}){${fail('const', 'const', `{allowedValue:${JSON.stringify(schema.const)}}`, "'must be equal to constant'")}}`)
    } else {
      // Pre-compute canonical form of const value
      const ci = ctx.varCounter++
      const canonFn = `_cnE${ci}`
      ctx.helperCode.push(`const ${canonFn}=function(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return'['+x.map(${canonFn}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+${canonFn}(x[k])}).join(',')+'}'};`)
      const expected = canonFn + '(JSON.parse(' + JSON.stringify(JSON.stringify(cv)) + '))'
      lines.push(`if(${canonFn}(${v})!==${expected}){${fail('const', 'const', `{allowedValue:JSON.parse(${JSON.stringify(JSON.stringify(schema.const))})}`, "'must be equal to constant'")}}`)
    }
  }

  // required — no destructuring in error mode (data might not be an object)
  const requiredSet = new Set(schema.required || [])
  const hoisted = {}
  if (schema.required) {
    for (const key of schema.required) {
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&!(${JSON.stringify(key)} in ${v})){_e.push({keyword:'required',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/required',params:{missingProperty:'${esc(key)}'},message:"must have required property '${esc(key)}'"});if(!_all)return{valid:false,errors:_e}}`)
    }
  }

  // numeric
  if (schema.minimum !== undefined) {
    const c = isNum ? `${v}<${schema.minimum}` : `typeof ${v}==='number'&&${v}<${schema.minimum}`
    lines.push(`if(${c}){${fail('minimum', 'minimum', `{comparison:'>=',limit:${schema.minimum}}`, `'must be >= ${schema.minimum}'`)}}`)
  }
  if (schema.maximum !== undefined) {
    const c = isNum ? `${v}>${schema.maximum}` : `typeof ${v}==='number'&&${v}>${schema.maximum}`
    lines.push(`if(${c}){${fail('maximum', 'maximum', `{comparison:'<=',limit:${schema.maximum}}`, `'must be <= ${schema.maximum}'`)}}`)
  }
  if (schema.exclusiveMinimum !== undefined) {
    const c = isNum ? `${v}<=${schema.exclusiveMinimum}` : `typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum}`
    lines.push(`if(${c}){${fail('exclusiveMinimum', 'exclusiveMinimum', `{comparison:'>',limit:${schema.exclusiveMinimum}}`, `'must be > ${schema.exclusiveMinimum}'`)}}`)
  }
  if (schema.exclusiveMaximum !== undefined) {
    const c = isNum ? `${v}>=${schema.exclusiveMaximum}` : `typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum}`
    lines.push(`if(${c}){${fail('exclusiveMaximum', 'exclusiveMaximum', `{comparison:'<',limit:${schema.exclusiveMaximum}}`, `'must be < ${schema.exclusiveMaximum}'`)}}`)
  }
  if (schema.multipleOf !== undefined) {
    const m = schema.multipleOf
    const ci = ctx.varCounter++
    // Use tolerance-based check for floating point (matches C++ behavior)
    lines.push(`{const _r${ci}=typeof ${v}==='number'?${v}%${m}:NaN;if(typeof ${v}==='number'&&Math.abs(_r${ci})>1e-8&&Math.abs(_r${ci}-${m})>1e-8){${fail('multipleOf', 'multipleOf', `{multipleOf:${m}}`, `'must be multiple of ${m}'`)}}}`)
  }

  // string
  if (schema.minLength !== undefined) {
    const c = isStr ? `_cpLen(${v})<${schema.minLength}` : `typeof ${v}==='string'&&_cpLen(${v})<${schema.minLength}`
    lines.push(`if(${c}){${fail('minLength', 'minLength', `{limit:${schema.minLength}}`, `'must NOT have fewer than ${schema.minLength} characters'`)}}`)
  }
  if (schema.maxLength !== undefined) {
    const c = isStr ? `_cpLen(${v})>${schema.maxLength}` : `typeof ${v}==='string'&&_cpLen(${v})>${schema.maxLength}`
    lines.push(`if(${c}){${fail('maxLength', 'maxLength', `{limit:${schema.maxLength}}`, `'must NOT have more than ${schema.maxLength} characters'`)}}`)
  }
  if (schema.pattern) {
    const inlineCheck = compilePatternInline(schema.pattern, v)
    if (inlineCheck) {
      const c = isStr ? `!(${inlineCheck})` : `typeof ${v}==='string'&&!(${inlineCheck})`
      lines.push(`if(${c}){${fail('pattern', 'pattern', `{pattern:${JSON.stringify(schema.pattern)}}`, `'must match pattern "${schema.pattern}"'`)}}`)
    } else {
      const pattern = JSON.stringify(schema.pattern);
      if (!ctx.regExpMap.has(pattern)) {
        const ri = ctx.varCounter++
        ctx.regExpMap.set(pattern, ri)
        ctx.helperCode.push(`const _re${ri}=new RegExp(${pattern})`)
      }
      const ri = ctx.regExpMap.get(pattern);
      const c = isStr ? `!_re${ri}.test(${v})` : `typeof ${v}==='string'&&!_re${ri}.test(${v})`
      lines.push(`if(${c}){${fail('pattern', 'pattern', `{pattern:${JSON.stringify(schema.pattern)}}`, `'must match pattern "${schema.pattern}"'`)}}`)
    }
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
        `{_e.push({keyword:'format',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/format',params:{format:'${esc(schema.format)}'},message:'must match format "${esc(schema.format)}"'});if(!_all)return{valid:false,errors:_e}}`)
      lines.push(fmtCode)
    }
  }

  // array size
  if (schema.minItems !== undefined) {
    const c = isArr ? `${v}.length<${schema.minItems}` : `Array.isArray(${v})&&${v}.length<${schema.minItems}`
    lines.push(`if(${c}){${fail('minItems', 'minItems', `{limit:${schema.minItems}}`, `'must NOT have fewer than ${schema.minItems} items'`)}}`)
  }
  if (schema.maxItems !== undefined) {
    const c = isArr ? `${v}.length>${schema.maxItems}` : `Array.isArray(${v})&&${v}.length>${schema.maxItems}`
    lines.push(`if(${c}){${fail('maxItems', 'maxItems', `{limit:${schema.maxItems}}`, `'must NOT have more than ${schema.maxItems} items'`)}}`)
  }

  // uniqueItems — tiered: small primitive arrays use nested loop (no allocation)
  if (schema.uniqueItems) {
    const si = ctx.varCounter++
    const itemType = schema.items && typeof schema.items === 'object' && schema.items.type
    const isPrim = itemType === 'string' || itemType === 'number' || itemType === 'integer'
    const maxItems = schema.maxItems
    const failExpr = (iVar, jVar) => fail('uniqueItems', 'uniqueItems', `{i:${iVar},j:${jVar}}`, `'must NOT have duplicate items (items ## '+${jVar}+' and '+${iVar}+' are identical)'`)
    let inner
    if (isPrim && maxItems && maxItems <= 16) {
      inner = `for(let _i=1;_i<${v}.length;_i++){for(let _k=0;_k<_i;_k++){if(${v}[_i]===${v}[_k]){${failExpr('_k', '_i')};break}}}`
    } else if (isPrim) {
      inner = `const _s${si}=new Map();for(let _i=0;_i<${v}.length;_i++){const _prev=_s${si}.get(${v}[_i]);if(_prev!==undefined){${failExpr('_prev', '_i')};break};_s${si}.set(${v}[_i],_i)}`
    } else {
      inner = `const _cn${si}=function(x){if(x===null||typeof x!=='object')return typeof x+':'+x;if(Array.isArray(x))return'['+x.map(_cn${si}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+_cn${si}(x[k])}).join(',')+'}'};const _s${si}=new Map();for(let _i=0;_i<${v}.length;_i++){const _k=_cn${si}(${v}[_i]);const _prev=_s${si}.get(_k);if(_prev!==undefined){${failExpr('_prev', '_i')};break};_s${si}.set(_k,_i)}`
    }
    lines.push(isArr ? `{${inner}}` : `if(Array.isArray(${v})){${inner}}`)
  }

  // object size
  if (schema.minProperties !== undefined) {
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length<${schema.minProperties}){${fail('minProperties', 'minProperties', `{limit:${schema.minProperties}}`, `'must NOT have fewer than ${schema.minProperties} properties'`)}}`)
  }
  if (schema.maxProperties !== undefined) {
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length>${schema.maxProperties}){${fail('maxProperties', 'maxProperties', `{limit:${schema.maxProperties}}`, `'must NOT have more than ${schema.maxProperties} properties'`)}}`)
  }

  // additionalProperties: false
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = Object.keys(schema.properties).map(k => `${JSON.stringify(k)}`).join(',')
    const ci = ctx.varCounter++
    const inner = `const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++){if(!_a${ci}.has(_k${ci}[_i])){_e.push({keyword:'additionalProperties',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/additionalProperties',params:{additionalProperty:_k${ci}[_i]},message:'must NOT have additional properties'});if(!_all)return{valid:false,errors:_e}}}`
    lines.push(isObj ? `{${inner}}` : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){${inner}}`)
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      for (const dep of deps) {
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}&&!(${JSON.stringify(dep)} in ${v})){_e.push({keyword:'required',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/dependentRequired',params:{missingProperty:'${esc(dep)}'},message:"must have required property '${esc(dep)}'"});if(!_all)return{valid:false,errors:_e}}`)
      }
    }
  }

  // properties — always guard (error mode, data may not be an object or may be array)
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const childPath = childPathExpr(pathExpr, esc(key))
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeE(prop, `${v}[${JSON.stringify(key)}]`, childPath, lines, ctx, schemaPrefix+'/properties/'+key)
      lines.push(`}`)
    }
  }

  // patternProperties
  if (schema.patternProperties) {
    for (const [pat, sub] of Object.entries(schema.patternProperties)) {
      const pattern = JSON.stringify(pat);
      if (!ctx.regExpMap.has(pattern)) {
        const ri = ctx.varCounter++
        ctx.regExpMap.set(pattern, ri)
        ctx.helperCode.push(`const _re${ri}=new RegExp(${pattern})`);
      }
      const ri = ctx.regExpMap.get(pattern);
      const ki = ctx.varCounter++
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){if(_re${ri}.test(_k${ki})){`)
      const p = pathExpr ? `${pathExpr}+'/'+_k${ki}` : `'/'+_k${ki}`
      genCodeE(sub, `${v}[_k${ki}]`, p, lines, ctx, schemaPrefix+'/patternProperties')
      lines.push(`}}}`)
    }
  }

  // dependentSchemas
  if (schema.dependentSchemas) {
    for (const [key, depSchema] of Object.entries(schema.dependentSchemas)) {
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeE(depSchema, v, pathExpr, lines, ctx, schemaPrefix+'/dependentSchemas/'+key)
      lines.push(`}`)
    }
  }

  // propertyNames
  if (schema.propertyNames && typeof schema.propertyNames === 'object') {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) {
      lines.push(`if(_k${ki}.length<${pn.minLength}){${fail('minLength', 'propertyNames/minLength', `{limit:${pn.minLength}}`, `'must NOT have fewer than ${pn.minLength} characters'`)}}`)
    }
    if (pn.maxLength !== undefined) {
      lines.push(`if(_k${ki}.length>${pn.maxLength}){${fail('maxLength', 'propertyNames/maxLength', `{limit:${pn.maxLength}}`, `'must NOT have more than ${pn.maxLength} characters'`)}}`)
    }
    if (pn.pattern) {
      const pattern = JSON.stringify(pn.pattern);
      if (!ctx.regExpMap.has(pattern)) {
        const ri = ctx.varCounter++
        ctx.regExpMap.set(pattern, ri)
        ctx.helperCode.push(`const _re${ri}=new RegExp(${pattern})`);
      }
      const ri = ctx.regExpMap.get(pattern);
      lines.push(`if(!_re${ri}.test(_k${ki})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
    }
    if (pn.const !== undefined) {
      lines.push(`if(_k${ki}!==${JSON.stringify(pn.const)}){${fail('const', 'propertyNames/const', `{allowedValue:${JSON.stringify(pn.const)}}`, "'must be equal to constant'")}}`)
    }
    if (pn.enum) {
      const ei = ctx.varCounter++
      ctx.helperCode.push(`const _es${ei}=new Set(${JSON.stringify(pn.enum)})`)
      lines.push(`if(!_es${ei}.has(_k${ki})){${fail('enum', 'propertyNames/enum', `{allowedValues:${JSON.stringify(pn.enum)}}`, "'must be equal to one of the allowed values'")}}`)
    }
    lines.push(`}}`)
  }

  // items — starts after prefixItems (Draft 2020-12 semantics)
  if (schema.items) {
    const startIdx = schema.prefixItems ? schema.prefixItems.length : 0
    const idx = `_j${ctx.varCounter}`
    const elem = `_ei${ctx.varCounter}`
    ctx.varCounter++
    const childPath = childPathDynExpr(pathExpr, idx)
    lines.push(`if(Array.isArray(${v})){for(let ${idx}=${startIdx};${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`)
    genCodeE(schema.items, elem, childPath, lines, ctx, schemaPrefix+'/items')
    lines.push(`}}`)
  }

  // prefixItems
  if (schema.prefixItems) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const childPath = childPathExpr(pathExpr, String(i))
      lines.push(`if(Array.isArray(${v})&&${v}.length>${i}){`)
      genCodeE(schema.prefixItems[i], `${v}[${i}]`, childPath, lines, ctx, schemaPrefix+'/prefixItems/'+i)
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
    lines.push(`if(_cc${ci}<${minC}){${fail('contains', 'contains', `{limit:${minC}}`, `'contains: need at least ${minC} match(es)'`)}}`)
    if (maxC !== undefined) {
      lines.push(`if(_cc${ci}>${maxC}){${fail('contains', 'contains', `{limit:${maxC}}`, `'contains: at most ${maxC} match(es)'`)}}`)
    }
    lines.push(`}`)
  }

  // allOf
  if (schema.allOf) {
    for (let _ai = 0; _ai < schema.allOf.length; _ai++) {
      genCodeE(schema.allOf[_ai], v, pathExpr, lines, ctx, schemaPrefix+'/allOf/'+_ai)
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
    lines.push(`{const _af${fi}=[${fns.join(',')}];let _am${fi}=false;for(let _ai=0;_ai<_af${fi}.length;_ai++){if(_af${fi}[_ai](${v})){_am${fi}=true;break}}if(!_am${fi}){${fail('anyOf', 'anyOf', '{}', "'must match a schema in anyOf'")}}}`)
  }

  // oneOf
  if (schema.oneOf) {
    const fi = ctx.varCounter++
    const fns = schema.oneOf.map((sub, i) => {
      const subLines = []
      genCode(sub, '_ov', subLines, ctx)
      return subLines.length === 0 ? `function(_ov){return true}` : `function(_ov){${subLines.join(';')};return true}`
    })
    lines.push(`{const _of${fi}=[${fns.join(',')}];let _oc${fi}=0;for(let _oi=0;_oi<_of${fi}.length;_oi++){if(_of${fi}[_oi](${v}))_oc${fi}++;if(_oc${fi}>1)break}if(_oc${fi}!==1){${fail('oneOf', 'oneOf', '{}', "'must match exactly one schema in oneOf'")}}}`)
  }

  // not
  if (schema.not) {
    const subLines = []
    genCode(schema.not, '_nv', subLines, ctx)
    const nfn = subLines.length === 0 ? `function(_nv){return true}` : `function(_nv){${subLines.join(';')};return true}`
    const fi = ctx.varCounter++
    lines.push(`{const _nf${fi}=${nfn};if(_nf${fi}(${v})){${fail('not', 'not', '{}', "'must NOT be valid'")}}}`)
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
      genCodeE(schema.then, v, pathExpr, lines, ctx, schemaPrefix+'/then')
      lines.push(`}`)
    }
    if (schema.else) {
      lines.push(`${schema.then ? 'else' : `if(!_if${fi}(${v}))`}{`)
      genCodeE(schema.else, v, pathExpr, lines, ctx, schemaPrefix+'/else')
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
  // Bail on unevaluated keywords — combined codegen doesn't support them yet
  if (typeof schema === 'object' && schema !== null) {
    const s = JSON.stringify(schema)
    if (s.includes('unevaluatedProperties') || s.includes('unevaluatedItems')) return null
    // Bail on self-referencing schemas — combined codegen doesn't support recursion
    if (s.includes('"$ref":"#"')) return null
  }
  if (typeof schema === 'boolean') {
    return schema
      ? () => VALID_RESULT
      : () => ({ valid: false, errors: [{ keyword: 'false schema', instancePath: '', schemaPath: '#', params: {}, message: 'boolean schema is false' }] })
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

  // Build anchors map for $ref/#anchor and $dynamicRef resolution
  const cRootDefs = schema.$defs || schema.definitions || null
  const cAnchors = {}
  if (schema.$dynamicAnchor) cAnchors['#' + schema.$dynamicAnchor] = schema
  if (schema.$anchor) cAnchors['#' + schema.$anchor] = schema
  if (cRootDefs) {
    for (const def of Object.values(cRootDefs)) {
      if (def && typeof def === 'object') {
        if (def.$dynamicAnchor) cAnchors['#' + def.$dynamicAnchor] = def
        if (def.$anchor) cAnchors['#' + def.$anchor] = def
      }
    }
  }
  if (schemaMap) {
    for (const ext of schemaMap.values()) {
      if (ext && typeof ext === 'object') {
        if (ext.$dynamicAnchor && !cAnchors['#' + ext.$dynamicAnchor]) cAnchors['#' + ext.$dynamicAnchor] = ext
        if (ext.$anchor && !cAnchors['#' + ext.$anchor]) cAnchors['#' + ext.$anchor] = ext
      }
    }
  }

  const ctx = { varCounter: 0, helperCode: [], closureVars: ['_cpLen'], closureVals: [_cpLen],
                rootDefs: cRootDefs, refStack: new Set(), schemaMap: schemaMap || null, anchors: cAnchors, rootSchema: schema }
  const lines = []
  genCodeC(schema, 'd', '', lines, ctx, '#')
  if (lines.length === 0) return () => VALID_RESULT

  // Use factory pattern: closure vars (regexes, etc.) created once, not per call
  const closureParams = ctx.closureVars.join(',')
  // Lazy error array — no allocation for valid data (the common case)
  const inner = `let _e;\n  ` +
    (ctx.helperCode.length ? ctx.helperCode.join('\n  ') + '\n  ' : '') +
    lines.join('\n  ') +
    `\n  return _e?{valid:false,errors:_e}:R`

  try {
    if (typeof process !== 'undefined' && process.env && process.env.ATA_DUMP_CODEGEN) console.log('=== COMBINED CODEGEN ===\n' + inner + '\n=== CLOSURE VARS: ' + ctx.closureVars.length + ' ===')
    const factory = new Function('R' + (closureParams ? ',' + closureParams : ''),
      `return function(d){${inner}}`)
    return factory(VALID_RESULT, ...ctx.closureVals)
  } catch (e) {
    if (typeof process !== 'undefined' && process.env && process.env.ATA_DEBUG) console.error('compileToJSCombined error:', e.message, '\n', inner.slice(0, 500))
    return null
  }
}

// Combined code generator: type-aware like genCode, error-collecting like genCodeE.
// After type check passes → use optimizations (destructuring, no guards).
// If type check fails → push error, skip property checks (they'd crash).
function genCodeC(schema, v, pathExpr, lines, ctx, schemaPrefix) {
  if (!schemaPrefix) schemaPrefix = '#'
  if (typeof schema !== 'object' || schema === null) return

  // $ref — resolve local, anchor, and cross-schema refs
  if (schema.$ref) {
    // Self-reference "#" — no-op (permissive) to avoid infinite recursion
    if (schema.$ref === '#') return
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && ctx.rootDefs && ctx.rootDefs[m[1]]) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeC(ctx.rootDefs[m[1]], v, pathExpr, lines, ctx, schemaPrefix)
      ctx.refStack.delete(schema.$ref)
      return
    }
    // Anchor ref: "#foo" — resolve via rootDefs or anchors map
    if (!m && schema.$ref.startsWith('#') && !schema.$ref.startsWith('#/')) {
      const entry = ctx.rootDefs && ctx.rootDefs[schema.$ref]
      const anchorTarget = entry && entry.raw ? entry.raw : (ctx.anchors && ctx.anchors[schema.$ref])
      if (anchorTarget) {
        if (ctx.refStack.has(schema.$ref)) return
        ctx.refStack.add(schema.$ref)
        genCodeC(anchorTarget, v, pathExpr, lines, ctx, schemaPrefix)
        ctx.refStack.delete(schema.$ref)
        return
      }
    }
    if (ctx.schemaMap && ctx.schemaMap.has(schema.$ref)) {
      if (ctx.refStack.has(schema.$ref)) return
      ctx.refStack.add(schema.$ref)
      genCodeC(ctx.schemaMap.get(schema.$ref), v, pathExpr, lines, ctx, schemaPrefix)
      ctx.refStack.delete(schema.$ref)
      return
    }
  }

  // $dynamicRef — resolve via anchors map
  if (schema.$dynamicRef) {
    const anchorKey = schema.$dynamicRef.startsWith('#') ? schema.$dynamicRef : '#' + schema.$dynamicRef
    if (ctx.anchors && ctx.anchors[anchorKey]) {
      const target = ctx.anchors[anchorKey]
      if (target === ctx.rootSchema) {
        // Self-recursive: bail to non-combined path (combined doesn't support named recursion)
        // Just skip — the hybrid path will handle this via jsFn + errFn
      } else {
        const refKey = '$dynamicRef:' + anchorKey
        if (!ctx.refStack.has(refKey)) {
          ctx.refStack.add(refKey)
          genCodeC(target, v, pathExpr, lines, ctx, schemaPrefix)
          ctx.refStack.delete(refKey)
        }
      }
    }
  }

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  let isObj = false, isArr = false, isStr = false, isNum = false

  // Pre-allocate error objects as closure variables for static paths.
  // This shrinks the generated function body → better V8 JIT on valid path.
  const isStaticPath = !pathExpr || (pathExpr.startsWith("'") && !pathExpr.includes('+'))
  const fail = (keyword, schemaSuffix, paramsCode, msgCode) => {
    const sp = schemaPrefix + '/' + schemaSuffix
    if (isStaticPath && msgCode.startsWith("'") && !msgCode.includes('+')) {
      // Try to evaluate paramsCode as a static constant
      let paramsVal
      try { paramsVal = Function('return ' + paramsCode)() } catch { /* dynamic params — fall through */ }
      if (paramsVal !== undefined) {
        // Static error: pre-allocate as frozen closure variable
        const ei = ctx.varCounter++
        const errVar = `_E${ei}`
        const pathVal = pathExpr ? pathExpr.slice(1, -1) : ''
        const msgVal = msgCode.slice(1, -1)
        ctx.closureVars.push(errVar)
        ctx.closureVals.push(Object.freeze({keyword, instancePath: pathVal, schemaPath: sp, params: Object.freeze(paramsVal), message: msgVal}))
        return `(_e||(_e=[])).push(${errVar})`
      }
    }
    // Dynamic path (e.g., array index): inline as before
    return `(_e||(_e=[])).push({keyword:'${keyword}',instancePath:${pathExpr||'""'},schemaPath:'${sp}',params:${paramsCode},message:${msgCode}})`
  }

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
    const expected = types.join(', ')
    // Type check: push error but continue — wrap remaining in type-success block
    const typeOk = `_tok${ctx.varCounter++}`
    lines.push(`const ${typeOk}=${conds.join('||')}`)
    lines.push(`if(!${typeOk}){${fail('type', 'type', `{type:'${expected}'}`, `'must be ${expected}'`)}}`)
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
    lines.push(`if(!(${allChecks || 'false'})){${fail('enum', 'enum', `{allowedValues:${JSON.stringify(schema.enum)}}`, "'must be equal to one of the allowed values'")}}`)
  }

  // const
  if (schema.const !== undefined) {
    const cv = schema.const
    if (cv === null || typeof cv !== 'object') {
      lines.push(`if(${v}!==${JSON.stringify(cv)}){${fail('const', 'const', `{allowedValue:${JSON.stringify(schema.const)}}`, "'must be equal to constant'")}}`)
    } else {
      const ci = ctx.varCounter++
      const canonFn = `_cn${ci}`
      ctx.helperCode.push(`const ${canonFn}=function(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return'['+x.map(${canonFn}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+${canonFn}(x[k])}).join(',')+'}'};`)
      lines.push(`if(${canonFn}(${v})!==${canonFn}(JSON.parse(${JSON.stringify(JSON.stringify(cv))}))){${fail('const', 'const', `{allowedValue:JSON.parse(${JSON.stringify(JSON.stringify(schema.const))})}`, "'must be equal to constant'")}}`)
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
      if (isStaticPath) {
        const ei = ctx.varCounter++
        const errVar = `_E${ei}`
        const pathVal = pathExpr ? pathExpr.slice(1, -1) : ''
        ctx.closureVars.push(errVar)
        ctx.closureVals.push(Object.freeze({keyword: 'required', instancePath: pathVal, schemaPath: `${schemaPrefix}/required`, params: Object.freeze({missingProperty: key}), message: `must have required property '${key}'`}))
        lines.push(`if(${check}){(_e||(_e=[])).push(${errVar})}`)
      } else {
        lines.push(`if(${check}){(_e||(_e=[])).push({keyword:'required',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/required',params:{missingProperty:'${esc(key)}'},message:"must have required property '${esc(key)}'"})}`)
      }
    }
  } else if (schema.required) {
    for (const key of schema.required) {
      const isStatic = !pathExpr || (pathExpr.startsWith("'") && !pathExpr.includes('+'))
      if (isStatic) {
        const ei = ctx.varCounter++
        const errVar = `_E${ei}`
        const pathVal = pathExpr ? pathExpr.slice(1, -1) : ''
        ctx.closureVars.push(errVar)
        ctx.closureVals.push(Object.freeze({keyword: 'required', instancePath: pathVal, schemaPath: `${schemaPrefix}/required`, params: Object.freeze({missingProperty: key}), message: `must have required property '${key}'`}))
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&!(${JSON.stringify(key)} in ${v})){(_e||(_e=[])).push(${errVar})}`)
      } else {
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&!(${JSON.stringify(key)} in ${v})){(_e||(_e=[])).push({keyword:'required',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/required',params:{missingProperty:'${esc(key)}'},message:"must have required property '${esc(key)}'"})}`)
      }
    }
  }

  // numeric — skip type guard if known
  if (schema.minimum !== undefined) { const c = isNum ? `${v}<${schema.minimum}` : `typeof ${v}==='number'&&${v}<${schema.minimum}`; lines.push(`if(${c}){${fail('minimum', 'minimum', `{comparison:'>=',limit:${schema.minimum}}`, `'must be >= ${schema.minimum}'`)}}`) }
  if (schema.maximum !== undefined) { const c = isNum ? `${v}>${schema.maximum}` : `typeof ${v}==='number'&&${v}>${schema.maximum}`; lines.push(`if(${c}){${fail('maximum', 'maximum', `{comparison:'<=',limit:${schema.maximum}}`, `'must be <= ${schema.maximum}'`)}}`) }
  if (schema.exclusiveMinimum !== undefined) { const c = isNum ? `${v}<=${schema.exclusiveMinimum}` : `typeof ${v}==='number'&&${v}<=${schema.exclusiveMinimum}`; lines.push(`if(${c}){${fail('exclusiveMinimum', 'exclusiveMinimum', `{comparison:'>',limit:${schema.exclusiveMinimum}}`, `'must be > ${schema.exclusiveMinimum}'`)}}`) }
  if (schema.exclusiveMaximum !== undefined) { const c = isNum ? `${v}>=${schema.exclusiveMaximum}` : `typeof ${v}==='number'&&${v}>=${schema.exclusiveMaximum}`; lines.push(`if(${c}){${fail('exclusiveMaximum', 'exclusiveMaximum', `{comparison:'<',limit:${schema.exclusiveMaximum}}`, `'must be < ${schema.exclusiveMaximum}'`)}}`) }
  if (schema.multipleOf !== undefined) {
    const m = schema.multipleOf
    const ci = ctx.varCounter++
    lines.push(`{const _r${ci}=typeof ${v}==='number'?${v}%${m}:NaN;if(typeof ${v}==='number'&&Math.abs(_r${ci})>1e-8&&Math.abs(_r${ci}-${m})>1e-8){${fail('multipleOf', 'multipleOf', `{multipleOf:${m}}`, `'must be multiple of ${m}'`)}}}`)
  }

  // string — skip guard if known
  if (schema.minLength !== undefined) { const c = isStr ? `_cpLen(${v})<${schema.minLength}` : `typeof ${v}==='string'&&_cpLen(${v})<${schema.minLength}`; lines.push(`if(${c}){${fail('minLength', 'minLength', `{limit:${schema.minLength}}`, `'must NOT have fewer than ${schema.minLength} characters'`)}}`) }
  if (schema.maxLength !== undefined) { const c = isStr ? `_cpLen(${v})>${schema.maxLength}` : `typeof ${v}==='string'&&_cpLen(${v})>${schema.maxLength}`; lines.push(`if(${c}){${fail('maxLength', 'maxLength', `{limit:${schema.maxLength}}`, `'must NOT have more than ${schema.maxLength} characters'`)}}`) }
  if (schema.pattern) {
    const inlineCheck = compilePatternInline(schema.pattern, v)
    if (inlineCheck) {
      const c = isStr ? `!(${inlineCheck})` : `typeof ${v}==='string'&&!(${inlineCheck})`
      lines.push(`if(${c}){${fail('pattern', 'pattern', `{pattern:${JSON.stringify(schema.pattern)}}`, `'must match pattern "${schema.pattern}"'`)}}`)
    } else {
      const ri = ctx.varCounter++
      const reVar = `_re${ri}`
      ctx.closureVars.push(reVar)
      ctx.closureVals.push(new RegExp(schema.pattern))
      const c = isStr ? `!${reVar}.test(${v})` : `typeof ${v}==='string'&&!${reVar}.test(${v})`
      lines.push(`if(${c}){${fail('pattern', 'pattern', `{pattern:${JSON.stringify(schema.pattern)}}`, `'must match pattern "${schema.pattern}"'`)}}`)
    }
  }
  if (schema.format) {
    const fc = FORMAT_CODEGEN[schema.format]
    if (fc) {
      const code = fc(v, isStr).replace(/return false/g, `{${fail('format', 'format', `{format:'${esc(schema.format)}'}`, `'must match format "${esc(schema.format)}"'`)}}`)
      lines.push(code)
    }
  }

  // array size
  if (schema.minItems !== undefined) { const c = isArr ? `${v}.length<${schema.minItems}` : `Array.isArray(${v})&&${v}.length<${schema.minItems}`; lines.push(`if(${c}){${fail('minItems', 'minItems', `{limit:${schema.minItems}}`, `'must NOT have fewer than ${schema.minItems} items'`)}}`) }
  if (schema.maxItems !== undefined) { const c = isArr ? `${v}.length>${schema.maxItems}` : `Array.isArray(${v})&&${v}.length>${schema.maxItems}`; lines.push(`if(${c}){${fail('maxItems', 'maxItems', `{limit:${schema.maxItems}}`, `'must NOT have more than ${schema.maxItems} items'`)}}`) }

  // uniqueItems — tiered: small primitive arrays use nested loop (no allocation)
  if (schema.uniqueItems) {
    const si = ctx.varCounter++
    const itemType = schema.items && typeof schema.items === 'object' && schema.items.type
    const isPrim = itemType === 'string' || itemType === 'number' || itemType === 'integer'
    const maxItems = schema.maxItems
    const failExpr = (iVar, jVar) => fail('uniqueItems', 'uniqueItems', `{i:${iVar},j:${jVar}}`, `'must NOT have duplicate items (items ## '+${jVar}+' and '+${iVar}+' are identical)'`)
    let inner
    if (isPrim && maxItems && maxItems <= 16) {
      // Small primitive arrays: O(n²) nested loop, zero allocation
      inner = `for(let _i=1;_i<${v}.length;_i++){for(let _k=0;_k<_i;_k++){if(${v}[_i]===${v}[_k]){${failExpr('_k', '_i')};break}}}`
    } else if (isPrim) {
      inner = `const _s${si}=new Map();for(let _i=0;_i<${v}.length;_i++){const _prev=_s${si}.get(${v}[_i]);if(_prev!==undefined){${failExpr('_prev', '_i')};break};_s${si}.set(${v}[_i],_i)}`
    } else {
      inner = `const _cn${si}=function(x){if(x===null||typeof x!=='object')return typeof x+':'+x;if(Array.isArray(x))return'['+x.map(_cn${si}).join(',')+']';return'{'+Object.keys(x).sort().map(function(k){return JSON.stringify(k)+':'+_cn${si}(x[k])}).join(',')+'}'};const _s${si}=new Map();for(let _i=0;_i<${v}.length;_i++){const _k=_cn${si}(${v}[_i]);const _prev=_s${si}.get(_k);if(_prev!==undefined){${failExpr('_prev', '_i')};break};_s${si}.set(_k,_i)}`
    }
    lines.push(isArr ? `{${inner}}` : `if(Array.isArray(${v})){${inner}}`)
  }

  // object size
  if (schema.minProperties !== undefined) lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length<${schema.minProperties}){${fail('minProperties', 'minProperties', `{limit:${schema.minProperties}}`, `'must NOT have fewer than ${schema.minProperties} properties'`)}}`)
  if (schema.maxProperties !== undefined) lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&Object.keys(${v}).length>${schema.maxProperties}){${fail('maxProperties', 'maxProperties', `{limit:${schema.maxProperties}}`, `'must NOT have more than ${schema.maxProperties} properties'`)}}`)

  // additionalProperties — skip if patternProperties present (handled in unified loop below)
  // Small property sets: direct === chain (no Set allocation)
  if (schema.additionalProperties === false && schema.properties && !schema.patternProperties) {
    const propKeys = Object.keys(schema.properties)
    const ci = ctx.varCounter++
    if (propKeys.length <= 8) {
      // Direct chain: no Set allocation for small schemas
      const checks = propKeys.map(k => `_k${ci}[_i]!==${JSON.stringify(k)}`).join('&&')
      lines.push(isObj
        ? `{const _k${ci}=Object.keys(${v});for(let _i=0;_i<_k${ci}.length;_i++)if(${checks}){${fail('additionalProperties', 'additionalProperties', `{additionalProperty:_k${ci}[_i]}`, "'must NOT have additional properties'")}}}`
        : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){const _k${ci}=Object.keys(${v});for(let _i=0;_i<_k${ci}.length;_i++)if(${checks}){${fail('additionalProperties', 'additionalProperties', `{additionalProperty:_k${ci}[_i]}`, "'must NOT have additional properties'")}}}`)
    } else {
      const allowed = propKeys.map(k => JSON.stringify(k)).join(',')
      lines.push(isObj
        ? `{const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++)if(!_a${ci}.has(_k${ci}[_i])){${fail('additionalProperties', 'additionalProperties', `{additionalProperty:_k${ci}[_i]}`, "'must NOT have additional properties'")}}}`
        : `if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){const _k${ci}=Object.keys(${v});const _a${ci}=new Set([${allowed}]);for(let _i=0;_i<_k${ci}.length;_i++)if(!_a${ci}.has(_k${ci}[_i])){${fail('additionalProperties', 'additionalProperties', `{additionalProperty:_k${ci}[_i]}`, "'must NOT have additional properties'")}}}`)
    }
  }

  // dependentRequired
  if (schema.dependentRequired) {
    for (const [key, deps] of Object.entries(schema.dependentRequired)) {
      for (const dep of deps) {
        const isStatic = !pathExpr || (pathExpr.startsWith("'") && !pathExpr.includes('+'))
        if (isStatic) {
          const ei = ctx.varCounter++
          const errVar = `_E${ei}`
          const pathVal = pathExpr ? pathExpr.slice(1, -1) : ''
          ctx.closureVars.push(errVar)
          ctx.closureVals.push(Object.freeze({keyword: 'required', instancePath: pathVal, schemaPath: `${schemaPrefix}/dependentRequired`, params: Object.freeze({missingProperty: dep}), message: `must have required property '${dep}'`}))
          lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}&&!(${JSON.stringify(dep)} in ${v})){(_e||(_e=[])).push(${errVar})}`)
        } else {
          lines.push(`if(typeof ${v}==='object'&&${v}!==null&&${JSON.stringify(key)} in ${v}&&!(${JSON.stringify(dep)} in ${v})){(_e||(_e=[])).push({keyword:'required',instancePath:${pathExpr||'""'},schemaPath:'${schemaPrefix}/dependentRequired',params:{missingProperty:'${esc(dep)}'},message:"must have required property '${esc(dep)}'"})}`)
        }
      }
    }
  }

  // properties — use hoisted vars for required+known-object, full guard otherwise
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const pv = hoisted[key] || `${v}[${JSON.stringify(key)}]`
      const childPath = childPathExpr(pathExpr, esc(key))
      if (requiredSet.has(key) && isObj) {
        lines.push(`if(${pv}!==undefined){`)
        genCodeC(prop, pv, childPath, lines, ctx, schemaPrefix+'/properties/'+key)
        lines.push(`}`)
      } else if (isObj) {
        const oi = ctx.varCounter++
        lines.push(`{const _o${oi}=${v}[${JSON.stringify(key)}];if(_o${oi}!==undefined){`)
        genCodeC(prop, `_o${oi}`, childPath, lines, ctx, schemaPrefix+'/properties/'+key)
        lines.push(`}}`)
      } else {
        lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
        genCodeC(prop, `${v}[${JSON.stringify(key)}]`, childPath, lines, ctx, schemaPrefix+'/properties/'+key)
        lines.push(`}`)
      }
    }
  }

  // patternProperties — same optimizations as genCode: charCodeAt + inline key comparison + merged propertyNames
  if (schema.patternProperties) {
    const ppEntries = Object.entries(schema.patternProperties)
    const pn = schema.propertyNames && typeof schema.propertyNames === 'object' ? schema.propertyNames : null
    const pi = ctx.varCounter++

    // Build pattern matchers: prefer charCodeAt for simple prefixes
    const matchers = []
    for (const [pat] of ppEntries) {
      const kVar = `_k${pi}`
      const fast = fastPrefixCheck(pat, kVar)
      if (fast) {
        matchers.push({ check: fast })
      } else {
        const ri = ctx.varCounter++
        ctx.closureVars.push(`_re${ri}`)
        ctx.closureVals.push(new RegExp(pat))
        matchers.push({ check: `_re${ri}.test(_k${pi})` })
      }
    }

    // Build sub-schema validators as closure vars
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
    const kVar = `_k${pi}`

    if (schema.additionalProperties === false && schema.properties) {
      ctx._ppHandledPropertyNamesC = !!pn
      const propKeys = Object.keys(schema.properties)
      // Inline key comparison for small property sets
      const keyCheck = propKeys.length <= 8
        ? propKeys.map(k => `${kVar}===${JSON.stringify(k)}`).join('||')
        : null
      if (!keyCheck) {
        const allowedSet = `_as${pi}`
        ctx.closureVars.push(allowedSet)
        ctx.closureVals.push(new Set(propKeys))
      }

      lines.push(`${guard}{for(const ${kVar} in ${v}){`)
      // propertyNames checks (merged)
      if (pn) {
        if (pn.minLength !== undefined) lines.push(`if(${kVar}.length<${pn.minLength}){${fail('minLength', 'propertyNames/minLength', `{limit:${pn.minLength}}`, `'must NOT have fewer than ${pn.minLength} characters'`)}}`)
        if (pn.maxLength !== undefined) lines.push(`if(${kVar}.length>${pn.maxLength}){${fail('maxLength', 'propertyNames/maxLength', `{limit:${pn.maxLength}}`, `'must NOT have more than ${pn.maxLength} characters'`)}}`)
        if (pn.pattern) {
          const fast = fastPrefixCheck(pn.pattern, kVar)
          if (fast) {
            lines.push(`if(!(${fast})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
          } else {
            const ri = ctx.varCounter++
            ctx.closureVars.push(`_re${ri}`)
            ctx.closureVals.push(new RegExp(pn.pattern))
            lines.push(`if(!_re${ri}.test(${kVar})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
          }
        }
        if (pn.const !== undefined) lines.push(`if(${kVar}!==${JSON.stringify(pn.const)}){${fail('const', 'propertyNames/const', `{allowedValue:${JSON.stringify(pn.const)}}`, "'must be equal to constant'")}}`)
        if (pn.enum) {
          const ei = ctx.varCounter++
          ctx.closureVars.push(`_es${ei}`)
          ctx.closureVals.push(new Set(pn.enum))
          lines.push(`if(!_es${ei}.has(${kVar})){${fail('enum', 'propertyNames/enum', `{allowedValues:${JSON.stringify(pn.enum)}}`, "'must be equal to one of the allowed values'")}}`)
        }
      }
      const matchExpr = keyCheck || `_as${pi}.has(${kVar})`
      lines.push(`let _m${pi}=${matchExpr}`)
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${matchers[i].check}){_m${pi}=true;if(!_ppf${pi}_${i}(${v}[${kVar}])){${fail('pattern', 'patternProperties', `{pattern:'${ppEntries[i][0]}'}`, `'patternProperties: value invalid for key '+${kVar}`)}}}`)
      }
      lines.push(`if(!_m${pi}){${fail('additionalProperties', 'additionalProperties', `{additionalProperty:${kVar}}`, "'must NOT have additional properties'")}}`)
      lines.push(`}}`)
    } else {
      ctx._ppHandledPropertyNamesC = !!pn
      lines.push(`${guard}{for(const ${kVar} in ${v}){`)
      if (pn) {
        if (pn.minLength !== undefined) lines.push(`if(${kVar}.length<${pn.minLength}){${fail('minLength', 'propertyNames/minLength', `{limit:${pn.minLength}}`, `'must NOT have fewer than ${pn.minLength} characters'`)}}`)
        if (pn.maxLength !== undefined) lines.push(`if(${kVar}.length>${pn.maxLength}){${fail('maxLength', 'propertyNames/maxLength', `{limit:${pn.maxLength}}`, `'must NOT have more than ${pn.maxLength} characters'`)}}`)
        if (pn.pattern) {
          const fast = fastPrefixCheck(pn.pattern, kVar)
          if (fast) {
            lines.push(`if(!(${fast})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
          } else {
            const ri = ctx.varCounter++
            ctx.closureVars.push(`_re${ri}`)
            ctx.closureVals.push(new RegExp(pn.pattern))
            lines.push(`if(!_re${ri}.test(${kVar})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
          }
        }
        if (pn.const !== undefined) lines.push(`if(${kVar}!==${JSON.stringify(pn.const)}){${fail('const', 'propertyNames/const', `{allowedValue:${JSON.stringify(pn.const)}}`, "'must be equal to constant'")}}`)
        if (pn.enum) {
          const ei = ctx.varCounter++
          ctx.closureVars.push(`_es${ei}`)
          ctx.closureVals.push(new Set(pn.enum))
          lines.push(`if(!_es${ei}.has(${kVar})){${fail('enum', 'propertyNames/enum', `{allowedValues:${JSON.stringify(pn.enum)}}`, "'must be equal to one of the allowed values'")}}`)
        }
      }
      for (let i = 0; i < ppEntries.length; i++) {
        lines.push(`if(${matchers[i].check}&&!_ppf${pi}_${i}(${v}[${kVar}])){${fail('pattern', 'patternProperties', `{pattern:'${ppEntries[i][0]}'}`, `'patternProperties: value invalid for key '+${kVar}`)}}`)
      }
      lines.push(`}}`)
    }
  }

  // dependentSchemas
  if (schema.dependentSchemas) {
    for (const [key, depSchema] of Object.entries(schema.dependentSchemas)) {
      lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})&&${JSON.stringify(key)} in ${v}){`)
      genCodeC(depSchema, v, pathExpr, lines, ctx, schemaPrefix+'/dependentSchemas/'+key)
      lines.push(`}`)
    }
  }

  // propertyNames — skip if already merged into patternProperties loop
  if (schema.propertyNames && typeof schema.propertyNames === 'object' && !ctx._ppHandledPropertyNamesC) {
    const pn = schema.propertyNames
    const ki = ctx.varCounter++
    lines.push(`if(typeof ${v}==='object'&&${v}!==null&&!Array.isArray(${v})){for(const _k${ki} in ${v}){`)
    if (pn.minLength !== undefined) {
      lines.push(`if(_k${ki}.length<${pn.minLength}){${fail('minLength', 'propertyNames/minLength', `{limit:${pn.minLength}}`, `'must NOT have fewer than ${pn.minLength} characters'`)}}`)
    }
    if (pn.maxLength !== undefined) {
      lines.push(`if(_k${ki}.length>${pn.maxLength}){${fail('maxLength', 'propertyNames/maxLength', `{limit:${pn.maxLength}}`, `'must NOT have more than ${pn.maxLength} characters'`)}}`)
    }
    if (pn.pattern) {
      const ri = ctx.varCounter++
      ctx.closureVars.push(`_re${ri}`)
      ctx.closureVals.push(new RegExp(pn.pattern))
      lines.push(`if(!_re${ri}.test(_k${ki})){${fail('pattern', 'propertyNames/pattern', `{pattern:${JSON.stringify(pn.pattern)}}`, `'must match pattern "${pn.pattern}"'`)}}`)
    }
    if (pn.const !== undefined) {
      lines.push(`if(_k${ki}!==${JSON.stringify(pn.const)}){${fail('const', 'propertyNames/const', `{allowedValue:${JSON.stringify(pn.const)}}`, "'must be equal to constant'")}}`)
    }
    if (pn.enum) {
      const ei = ctx.varCounter++
      ctx.closureVars.push(`_es${ei}`)
      ctx.closureVals.push(new Set(pn.enum))
      lines.push(`if(!_es${ei}.has(_k${ki})){${fail('enum', 'propertyNames/enum', `{allowedValues:${JSON.stringify(pn.enum)}}`, "'must be equal to one of the allowed values'")}}`)
    }
    lines.push(`}}`)
  }

  // items
  if (schema.items) {
    const startIdx = schema.prefixItems ? schema.prefixItems.length : 0
    const idx = `_j${ctx.varCounter}`, elem = `_ei${ctx.varCounter}`
    ctx.varCounter++
    const childPath = childPathDynExpr(pathExpr, idx)
    lines.push(`if(Array.isArray(${v})){for(let ${idx}=${startIdx};${idx}<${v}.length;${idx}++){const ${elem}=${v}[${idx}]`)
    genCodeC(schema.items, elem, childPath, lines, ctx, schemaPrefix+'/items')
    lines.push(`}}`)
  }

  // prefixItems
  if (schema.prefixItems) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      const childPath = childPathExpr(pathExpr, String(i))
      lines.push(`if(Array.isArray(${v})&&${v}.length>${i}){`)
      genCodeC(schema.prefixItems[i], `${v}[${i}]`, childPath, lines, ctx, schemaPrefix+'/prefixItems/'+i)
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
    lines.push(`if(_cc${ci}<${minC}){${fail('contains', 'contains', `{limit:${minC}}`, `'contains: need at least ${minC} match(es)'`)}}`)
    if (maxC !== undefined) lines.push(`if(_cc${ci}>${maxC}){${fail('contains', 'contains', `{limit:${maxC}}`, `'contains: at most ${maxC} match(es)'`)}}`)
    lines.push(`}`)
  }

  // allOf
  if (schema.allOf) { for (let _ai = 0; _ai < schema.allOf.length; _ai++) genCodeC(schema.allOf[_ai], v, pathExpr, lines, ctx, schemaPrefix+'/allOf/'+_ai) }

  // anyOf
  if (schema.anyOf) {
    const fi = ctx.varCounter++
    const fns = schema.anyOf.map(sub => { const sl = []; genCode(sub, '_av', sl, ctx); return sl.length === 0 ? `function(_av){return true}` : `function(_av){${sl.join(';')};return true}` })
    lines.push(`{const _af${fi}=[${fns.join(',')}];let _am=false;for(let _ai=0;_ai<_af${fi}.length;_ai++){if(_af${fi}[_ai](${v})){_am=true;break}}if(!_am){${fail('anyOf', 'anyOf', '{}', "'must match a schema in anyOf'")}}}`)
  }

  // oneOf
  if (schema.oneOf) {
    const fi = ctx.varCounter++
    const fns = schema.oneOf.map(sub => { const sl = []; genCode(sub, '_ov', sl, ctx); return sl.length === 0 ? `function(_ov){return true}` : `function(_ov){${sl.join(';')};return true}` })
    lines.push(`{const _of${fi}=[${fns.join(',')}];let _oc=0;for(let _oi=0;_oi<_of${fi}.length;_oi++){if(_of${fi}[_oi](${v}))_oc++;if(_oc>1)break}if(_oc!==1){${fail('oneOf', 'oneOf', '{}', "'must match exactly one schema in oneOf'")}}}`)
  }

  // not
  if (schema.not) {
    const sl = []; genCode(schema.not, '_nv', sl, ctx)
    const nfn = sl.length === 0 ? `function(_nv){return true}` : `function(_nv){${sl.join(';')};return true}`
    const fi = ctx.varCounter++
    lines.push(`{const _nf${fi}=${nfn};if(_nf${fi}(${v})){${fail('not', 'not', '{}', "'must NOT be valid'")}}}`)
  }

  // if/then/else
  if (schema.if) {
    const sl = []; genCode(schema.if, '_iv', sl, ctx)
    const fi = ctx.varCounter++
    const ifFn = sl.length === 0 ? `function(_iv){return true}` : `function(_iv){${sl.join(';')};return true}`
    lines.push(`{const _if${fi}=${ifFn}`)
    if (schema.then) { lines.push(`if(_if${fi}(${v})){`); genCodeC(schema.then, v, pathExpr, lines, ctx, schemaPrefix+'/then'); lines.push(`}`) }
    if (schema.else) { lines.push(`${schema.then ? 'else' : `if(!_if${fi}(${v}))`}{`); genCodeC(schema.else, v, pathExpr, lines, ctx, schemaPrefix+'/else'); lines.push(`}`) }
    lines.push(`}`)
  }

  // Close type-success block if opened
  if (types) {
    lines.push(`}`)
  }
}

// Collect statically-known evaluated properties/items from a schema.
// Returns { props: string[], items: number|null, allProps: bool, allItems: bool, dynamic: bool }
function collectEvaluated(schema, schemaMap, rootDefs) {
  if (typeof schema !== 'object' || schema === null) return { props: [], items: null, allProps: false, allItems: false, dynamic: false }
  const defs = rootDefs || schema.$defs || schema.definitions || null
  const result = { props: [], items: null, allProps: false, allItems: false, dynamic: false }
  _collectEval(schema, result, defs, schemaMap, new Set(), true)
  return result
}

function _collectEval(schema, result, defs, schemaMap, refStack, isRoot) {
  if (typeof schema !== 'object' || schema === null) return
  if (result.allProps && result.allItems) return

  // $ref — inline
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
    if (m && defs && defs[m[1]]) {
      if (refStack.has(schema.$ref)) { result.dynamic = true; return }
      refStack.add(schema.$ref)
      _collectEval(defs[m[1]], result, defs, schemaMap, refStack)
      refStack.delete(schema.$ref)
    } else if (schemaMap && typeof schemaMap.get === 'function') {
      let resolved = schemaMap.has(schema.$ref) ? schemaMap.get(schema.$ref) : null
      // Relative URI resolution
      if (!resolved && !schema.$ref.includes('://') && !schema.$ref.startsWith('#')) {
        for (const [id, s] of schemaMap) {
          if (id.endsWith('/' + schema.$ref)) { resolved = s; break }
        }
      }
      if (resolved) {
        if (refStack.has(schema.$ref)) { result.dynamic = true; return }
        refStack.add(schema.$ref)
        _collectEval(resolved, result, defs, schemaMap, refStack)
        refStack.delete(schema.$ref)
      }
    }
    // In 2020-12, $ref can coexist with siblings — don't return early if there are other keywords
    const hasOtherKeywords = Object.keys(schema).some(k => k !== '$ref' && k !== '$defs' && k !== 'definitions' && k !== '$schema' && k !== '$id')
    if (!hasOtherKeywords) return
  }

  // properties → static keys
  if (schema.properties) {
    for (const k of Object.keys(schema.properties)) {
      if (!result.props.includes(k)) result.props.push(k)
    }
  }

  // additionalProperties: true/schema → all props evaluated
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    result.allProps = true
  }

  // patternProperties → dynamic
  if (schema.patternProperties) {
    result.dynamic = true
  }

  // prefixItems → max index
  if (schema.prefixItems) {
    const count = schema.prefixItems.length
    result.items = result.items === null ? count : Math.max(result.items, count)
  }

  // items: schema/true → all items evaluated
  if (schema.items && typeof schema.items === 'object') {
    result.allItems = true
  }
  if (schema.items === true) {
    result.allItems = true
  }

  // contains: marks matching items as evaluated (not ALL items)
  // Always set dynamic since which items match depends on the data
  if (schema.contains) {
    result.dynamic = true
  }

  // unevaluatedProperties: true/schema → all props evaluated (for nested schemas only)
  // At root level, unevaluatedProperties is what we're computing FOR, not a contributor
  if (!isRoot && (schema.unevaluatedProperties === true || (typeof schema.unevaluatedProperties === 'object' && schema.unevaluatedProperties !== null))) {
    result.allProps = true
  }
  // unevaluatedItems: true/schema → all items evaluated (for nested schemas only)
  if (!isRoot && (schema.unevaluatedItems === true || (typeof schema.unevaluatedItems === 'object' && schema.unevaluatedItems !== null))) {
    result.allItems = true
  }

  // allOf → merge all (unconditional)
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      _collectEval(sub, result, defs, schemaMap, refStack)
    }
  }

  // anyOf / oneOf → dynamic (conditional merge)
  if (schema.anyOf || schema.oneOf) {
    result.dynamic = true
    const branches = schema.anyOf || schema.oneOf
    for (const sub of branches) {
      _collectEval(sub, result, defs, schemaMap, refStack)
    }
  }

  // if/then/else → dynamic (branch-dependent)
  if (schema.if && (schema.then || schema.else)) {
    result.dynamic = true
    _collectEval(schema.if, result, defs, schemaMap, refStack)
    if (schema.then) _collectEval(schema.then, result, defs, schemaMap, refStack)
    if (schema.else) _collectEval(schema.else, result, defs, schemaMap, refStack)
  } else if (schema.if) {
    // Standalone if (no then/else) still produces annotations per spec
    // Only collect properties and patterns, not deep items (contains etc.)
    result.dynamic = true
    if (schema.if.properties) {
      for (const k of Object.keys(schema.if.properties)) {
        if (!result.props.includes(k)) result.props.push(k)
      }
    }
    if (schema.if.patternProperties) {
      // patternProperties contribute to dynamic evaluation
    }
  }

  // dependentSchemas → dynamic
  if (schema.dependentSchemas) {
    result.dynamic = true
    for (const sub of Object.values(schema.dependentSchemas)) {
      _collectEval(sub, result, defs, schemaMap, refStack)
    }
  }

  // not → contributes nothing (spec: annotations from not are discarded)
}

module.exports = { compileToJS, compileToJSCodegen, compileToJSCodegenWithErrors, compileToJSCombined, collectEvaluated, AJV_MESSAGES }
