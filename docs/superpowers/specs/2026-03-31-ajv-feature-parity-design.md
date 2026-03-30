# ata-validator: Ajv Feature Parity

**Date:** 2026-03-31
**Goal:** Close the feature gap with ajv while maintaining ata's performance advantage. After this work, ata does everything ajv does — faster.

## Scope

1. Cross-schema `$ref` resolution with `$id` support
2. Draft 7 keyword support (auto-detection via `$schema`)
3. `patternProperties`, `dependentSchemas`, `propertyNames` JS codegen (currently NAPI fallback only)
4. Fuzz testing with libFuzzer (parallel workstream, issue #5)

## Out of Scope

- `$dynamicRef` / `$dynamicAnchor`
- `unevaluatedItems` / `unevaluatedProperties`
- `$vocabulary`
- `$anchor` (standalone, without `$defs`)
- Draft 4 / Draft 6 support
- Runtime HTTP fetch for remote schemas

---

## 1. Cross-Schema `$ref` Resolution

### API

```js
// Option 1: schemas array (most common)
const v = new Validator(mainSchema, {
  schemas: [addressSchema, personSchema]
})

// Option 2: schemas object (manual keys)
const v = new Validator(mainSchema, {
  schemas: { address: addressSchema, person: personSchema }
})

// Option 3: addSchema (incremental)
const v = new Validator(mainSchema)
v.addSchema(addressSchema)
v.addSchema(personSchema)
```

No separate `SchemaRegistry` class. Everything lives on `Validator`.

### Schema requirements

- Every schema in `schemas` must have a `$id` field (or manual key in object form)
- `$ref` values can be full URIs (`https://example.com/schemas/address`) or bare ids (`address`)
- All refs are resolved at compile time — zero runtime overhead

### `buildSchemaMap` (new, called once in constructor)

```js
function buildSchemaMap(schemas) {
  if (!schemas) return null
  const map = new Map()
  const list = Array.isArray(schemas) ? schemas : Object.values(schemas)
  for (const s of list) {
    const id = s.$id
    if (!id) throw new Error('Schema in schemas option must have $id')
    map.set(id, s)
  }
  return map
}
```

### Ref resolution changes

Three codegen functions need updates: `genCode`, `genCodeE`, `genCodeC`.

Current flow (local only):
```
schema.$ref → match #/$defs/Name → lookup rootDefs → recursive genCode
```

New flow:
```
schema.$ref → try local defs first → try schemaMap lookup → recursive genCode
```

All three functions get the same pattern:
```js
if (schema.$ref) {
  // 1. Local ref (existing)
  const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
  if (m && ctx.rootDefs?.[m[1]]) {
    if (ctx.refStack.has(schema.$ref)) return  // circular guard
    ctx.refStack.add(schema.$ref)
    genCode(ctx.rootDefs[m[1]], v, lines, ctx, knownType)
    ctx.refStack.delete(schema.$ref)
    return
  }
  // 2. Cross-schema ref (new)
  if (ctx.schemaMap?.has(schema.$ref)) {
    if (ctx.refStack.has(schema.$ref)) return  // circular guard
    ctx.refStack.add(schema.$ref)
    genCode(ctx.schemaMap.get(schema.$ref), v, lines, ctx, knownType)
    ctx.refStack.delete(schema.$ref)
    return
  }
}
```

**Bug fix included:** `genCodeE` and `genCodeC` currently lack circular ref guards for local refs. Adding them for both local and cross-schema refs.

### Closure-based path (`compileToJS`)

`resolveRef()` gets a `schemaMap` parameter:
```js
function resolveRef(ref, defs, schemaMap) {
  // 1. Local ref
  const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
  if (m && defs?.[m[1]]) {
    const entry = defs[m[1]]
    return (d) => entry.fn ? entry.fn(d) : true
  }
  // 2. Cross-schema ref
  if (schemaMap?.has(ref)) {
    const fn = compileToJS(schemaMap.get(ref))
    return fn || null
  }
  return null
}
```

### `codegenSafe` update

Current: `if (schema.$id) return false` — this blocks any schema with `$id`.
New: `$id` is allowed (it's just metadata for the registry). The bail condition for `$ref` is relaxed to allow cross-schema refs when `schemaMap` is available.

### Compiler function signatures

All codegen entry points get an optional `schemaMap` parameter:
- `compileToJSCodegen(schema, schemaMap)`
- `compileToJSCombined(schema, VALID_RESULT, schemaMap)`
- `compileToJSCodegenWithErrors(schema, schemaMap)`
- `compileToJS(schema, defs, schemaMap)`

### Cache key update

```js
// Old: schemaStr only
const cached = _compileCache.get(schemaStr)

// New: schemaStr + sorted $id fingerprint
const cacheKey = schemaMap
  ? schemaStr + '\0' + [...schemaMap.keys()].sort().join('\0')
  : schemaStr
```

### `addSchema` behavior

`addSchema()` can only be called before the first `validate()`/`isValidObject()` call. Once lazy compilation is triggered, the schema map is frozen. Calling `addSchema()` after compilation throws an error. This is simpler than ajv's approach (which allows adding schemas at any time) but matches ata's lazy compilation model and avoids cache invalidation complexity.

### NAPI fallback

When codegen bails, the NAPI path also needs schema map support. The C++ `CompiledSchema` constructor receives a merged schema with all `$defs` inlined from the schema map. This avoids C++ changes — normalization happens in JS before passing to NAPI.

---

## 2. Draft 7 Support

### Detection

```js
const DRAFT7_SCHEMAS = new Set([
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
])

function isDraft7(schema) {
  return schema.$schema && DRAFT7_SCHEMAS.has(schema.$schema)
}
```

If `$schema` is absent, assume 2020-12 (current default behavior preserved).

### Normalization (compile-time, in-place)

Called once in constructor, before any compilation:

```js
function normalizeDraft7(schema) {
  if (!isDraft7(schema)) return schema

  // 1. definitions → $defs (ata already supports both, but normalize for consistency)
  if (schema.definitions && !schema.$defs) {
    schema.$defs = schema.definitions
    delete schema.definitions
  }

  // 2. dependencies → dependentSchemas + dependentRequired
  if (schema.dependencies) {
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (Array.isArray(value)) {
        schema.dependentRequired = schema.dependentRequired || {}
        schema.dependentRequired[key] = value
      } else {
        schema.dependentSchemas = schema.dependentSchemas || {}
        schema.dependentSchemas[key] = value
      }
    }
    delete schema.dependencies
  }

  // 3. items (array form) → prefixItems
  if (Array.isArray(schema.items)) {
    schema.prefixItems = schema.items
    // additionalItems → items (new semantic)
    if (schema.additionalItems !== undefined) {
      schema.items = schema.additionalItems
      delete schema.additionalItems
    } else {
      delete schema.items
    }
  }

  // 4. Recurse into sub-schemas
  const subs = ['properties', 'patternProperties', '$defs', 'definitions',
                'dependentSchemas']
  for (const key of subs) {
    if (schema[key] && typeof schema[key] === 'object') {
      for (const v of Object.values(schema[key])) {
        if (typeof v === 'object' && v !== null) normalizeDraft7(v)
      }
    }
  }
  const arraySubs = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
  for (const key of arraySubs) {
    if (Array.isArray(schema[key])) {
      for (const s of schema[key]) {
        if (typeof s === 'object' && s !== null) normalizeDraft7(s)
      }
    }
  }
  for (const key of ['items', 'contains', 'not', 'if', 'then', 'else',
                      'additionalProperties', 'propertyNames']) {
    if (typeof schema[key] === 'object' && schema[key] !== null) {
      normalizeDraft7(schema[key])
    }
  }

  return schema
}
```

### `$ref` sibling behavior

Draft 7: `$ref` overrides all sibling keywords (they are ignored).
Draft 2020-12: `$ref` is evaluated alongside siblings.

Current ata behavior: codegen bails on `$ref` with siblings (`codegenSafe` line 460). This is correct for both drafts — Draft 7 because siblings should be ignored (bailing is conservative-correct), and 2020-12 because the interaction is complex.

No change needed. If we later want to optimize Draft 7 `$ref` + siblings, we can strip siblings during normalization. But for now, NAPI fallback handles it correctly.

### Performance impact

Normalization is a single recursive tree walk, once per schema. Cost: negligible compared to compilation. The pipeline after normalization sees only 2020-12 keywords — zero branching in hot paths.

---

## 3. Keyword Codegen Expansion

### 3a. `patternProperties`

Generated code pattern (inside `genCode`):

```js
// Schema: { properties: { name: ... }, patternProperties: { "f.*o": { type: "integer" } }, additionalProperties: false }

if(typeof d==='object'&&d!==null&&!Array.isArray(d)){
  for(const _k in d){
    let _m=false
    if(_k==='name'){_m=true; /* existing property validation */ }
    if(_re0.test(_k)){_m=true; if(!Number.isInteger(d[_k]))return false}
    if(!_m)return false  // additionalProperties: false
  }
}
```

Implementation details:
- Regex objects created at compile time as closure variables (same pattern as `schema.pattern`)
- Multiple patterns: a key can match multiple patterns, all must validate
- `additionalProperties` interaction: a key is "matched" if it hits `properties` OR any `patternProperties` pattern
- Boolean sub-schema in `patternProperties` (e.g., `"b.*": false`): bail to NAPI — `codegenSafe` already rejects boolean sub-schemas

The existing `additionalProperties` deferred check (js-compiler.js line 760-775) needs refactoring. Currently it has two paths:
1. Without `patternProperties`: count-based or key-list check
2. With `patternProperties`: Set-based check (but this path currently returns null / bails)

New approach: when `patternProperties` is present, generate a unified `for..in` loop that checks properties, pattern matches, and additional props in a single pass.

### 3b. `dependentSchemas`

Generated code pattern:

```js
// Schema: { dependentSchemas: { bar: { properties: { foo: { type: "integer" } } } } }

if(typeof d==='object'&&d!==null&&!Array.isArray(d)){
  if('bar' in d){
    // recursive genCode for the dependent schema, applied to same data 'd'
    if(d.foo!==undefined&&!Number.isInteger(d.foo))return false
  }
}
```

Implementation:
- For each entry in `dependentSchemas`: emit `if(key in d){ ... }`
- Inside the block: call `genCode(dependentSchema, v, lines, ctx)` recursively
- The dependent schema validates the entire object, not just the triggering property
- Boolean sub-schema bail: same as other keywords
- Key escaping: use `JSON.stringify(key)` for special characters (tabs, quotes — per test suite)

### 3c. `propertyNames`

Generated code pattern:

```js
// Schema: { propertyNames: { maxLength: 3, pattern: "^a+$" } }

if(typeof d==='object'&&d!==null&&!Array.isArray(d)){
  for(const _k in d){
    if(_k.length>3)return false
    if(!_re0.test(_k))return false
  }
}
```

Supported `propertyNames` sub-keywords (fast path, codegen):
- `maxLength` / `minLength` — `_k.length` check (note: ASCII length, not UTF-8 codepoints. For most property names this is identical. If `minLength`/`maxLength` is used with non-ASCII keys, NAPI fallback handles it correctly via C++ `utf8_length`)
- `pattern` — regex test on key
- `const` — `_k === constValue`
- `enum` — `Set.has(_k)`

NAPI fallback for:
- `propertyNames: false` — already in `codegenSafe` (line 470)
- `propertyNames: true` — noop, skip entirely
- Complex `propertyNames` schema (with `type`, `$ref`, `allOf`, `format`, etc.) — bail to NAPI

### `codegenSafe` updates

Remove the blanket bail for these three keywords:
```js
// OLD (js-compiler.js lines 517-519):
if (schema.patternProperties || schema.dependentSchemas || schema.propertyNames) return null

// NEW: only bail on specific unsafe sub-patterns
```

New checks:
- `patternProperties`: bail if any value is boolean schema, or if pattern contains Unicode property escapes (`\p{`)
- `dependentSchemas`: bail if any value is boolean schema
- `propertyNames`: bail if value is boolean, or if value contains keywords beyond `maxLength`/`minLength`/`pattern`/`const`/`enum`

### Error path codegen (`genCodeE`, `genCodeC`)

Same keyword support added to error-collecting codegen functions. Pattern identical to `genCode` but with error pushing instead of `return false`.

---

## 4. Fuzz Testing (Parallel Workstream)

Per issue #5 (pi0), integrate libFuzzer for continuous mutation testing.

### Scope

- Fuzz the C++ validation engine (`ata.cpp`) with mutated schemas and data
- Fuzz the JS codegen pipeline — generate random schemas, compile, validate random data, compare output with NAPI path (differential fuzzing)
- Fuzz the Draft 7 normalization — random Draft 7 schemas, normalize, validate, compare with direct 2020-12 equivalent

### Differential fuzzing strategy

For every generated schema + data pair:
1. Validate via JS codegen path
2. Validate via NAPI C++ path
3. Results must match — any divergence is a bug

This catches codegen correctness bugs that unit tests miss.

### Integration

- Local: `npm run fuzz` runs libFuzzer corpus
- CI: fuzz corpus runs on PR checks
- OSS-Fuzz: future goal (after stabilization)

---

## 5. Test Plan

### Cross-schema `$ref`
- Basic cross-ref: schema A references schema B by `$id`
- Chained refs: A → B → C
- Circular refs: A → B → A (should not infinite loop)
- Missing ref: compile-time error
- `schemas` option: array form and object form
- `addSchema()`: add after constructor, before first validation
- Cache correctness: same schema with different `schemas` option produces different validators
- JSON Schema Test Suite `ref.json` and `refRemote.json` (currently skipped — enable)

### Draft 7
- Auto-detection via `$schema` field
- `dependencies` split into `dependentRequired` + `dependentSchemas`
- `items` array form → `prefixItems` + `items`
- `additionalItems` → `items` swap
- Nested normalization (Draft 7 sub-schemas inside properties, allOf, etc.)
- No `$schema` field → defaults to 2020-12
- JSON Schema Test Suite: run `draft7/` test files (add to `run_suite.js`)

### Keyword codegen
- `patternProperties`: single pattern, multiple patterns, with `properties`, with `additionalProperties: false`
- `dependentSchemas`: single dependency, with `additionalProperties`, escaped characters
- `propertyNames`: maxLength, minLength, pattern, const, enum
- All three: compare codegen output with NAPI fallback (differential testing)
- JSON Schema Test Suite: enable `patternProperties.json`, `dependentSchemas.json`, `propertyNames.json` in `run_suite.js`

### Fuzz testing
- Schema mutation corpus
- Data mutation corpus
- Differential: codegen vs NAPI agreement
- Memory safety: no crashes, leaks, or undefined behavior

---

## 6. Migration Guide (for ajv users)

```js
// ajv
const ajv = new Ajv()
ajv.addSchema(addressSchema)
ajv.addSchema(personSchema)
const validate = ajv.compile(mainSchema)
validate(data)

// ata (drop-in replacement)
const v = new Validator(mainSchema, {
  schemas: [addressSchema, personSchema]
})
v.validate(data)
```

Key differences from ajv:
- No separate `compile()` step — compilation is lazy on first `validate()` call
- No `new Ajv()` instance — each `Validator` is self-contained
- Draft auto-detection — no need to import `Ajv2020` vs `Ajv`
- All refs resolved at compile time — no `compileAsync()` or `loadSchema` needed
