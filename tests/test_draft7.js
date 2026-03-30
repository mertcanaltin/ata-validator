'use strict'
const { normalizeDraft7, isDraft7 } = require('../lib/draft7')

let passed = 0, failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
    passed++
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`)
    failed++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

console.log('\nDraft 7 Normalization Tests\n')

test('isDraft7 detects draft-07 schema', () => {
  assert(isDraft7({ $schema: 'http://json-schema.org/draft-07/schema#' }))
  assert(isDraft7({ $schema: 'http://json-schema.org/draft-07/schema' }))
  assert(!isDraft7({ $schema: 'https://json-schema.org/draft/2020-12/schema' }))
  assert(!isDraft7({ type: 'string' }))
  assert(!isDraft7({}))
})

test('definitions → $defs', () => {
  const s = { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { foo: { type: 'string' } } }
  normalizeDraft7(s)
  assert(s.$defs && s.$defs.foo.type === 'string', 'should have $defs.foo')
  assert(!s.definitions, 'definitions should be deleted')
})

test('dependencies (array) → dependentRequired', () => {
  const s = { $schema: 'http://json-schema.org/draft-07/schema#', dependencies: { foo: ['bar', 'baz'] } }
  normalizeDraft7(s)
  assert(deepEqual(s.dependentRequired, { foo: ['bar', 'baz'] }))
  assert(!s.dependencies, 'dependencies should be deleted')
  assert(!s.dependentSchemas, 'no dependentSchemas for array deps')
})

test('dependencies (schema) → dependentSchemas', () => {
  const s = { $schema: 'http://json-schema.org/draft-07/schema#', dependencies: { foo: { required: ['bar'] } } }
  normalizeDraft7(s)
  assert(deepEqual(s.dependentSchemas, { foo: { required: ['bar'] } }))
  assert(!s.dependencies, 'dependencies should be deleted')
  assert(!s.dependentRequired, 'no dependentRequired for schema deps')
})

test('dependencies (mixed) → split', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    dependencies: {
      foo: ['bar'],
      baz: { required: ['qux'] }
    }
  }
  normalizeDraft7(s)
  assert(deepEqual(s.dependentRequired, { foo: ['bar'] }))
  assert(deepEqual(s.dependentSchemas, { baz: { required: ['qux'] } }))
  assert(!s.dependencies)
})

test('items (array) → prefixItems', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    items: [{ type: 'string' }, { type: 'number' }]
  }
  normalizeDraft7(s)
  assert(deepEqual(s.prefixItems, [{ type: 'string' }, { type: 'number' }]))
  assert(s.items === undefined, 'items should be deleted when no additionalItems')
})

test('items (array) + additionalItems → prefixItems + items', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    items: [{ type: 'string' }],
    additionalItems: { type: 'number' }
  }
  normalizeDraft7(s)
  assert(deepEqual(s.prefixItems, [{ type: 'string' }]))
  assert(deepEqual(s.items, { type: 'number' }))
  assert(s.additionalItems === undefined)
})

test('items (array) + additionalItems: false → prefixItems + items: false', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    items: [{ type: 'string' }],
    additionalItems: false
  }
  normalizeDraft7(s)
  assert(deepEqual(s.prefixItems, [{ type: 'string' }]))
  assert(s.items === false)
  assert(s.additionalItems === undefined)
})

test('items (schema) stays as items', () => {
  const s = { $schema: 'http://json-schema.org/draft-07/schema#', items: { type: 'string' } }
  normalizeDraft7(s)
  assert(deepEqual(s.items, { type: 'string' }))
  assert(s.prefixItems === undefined)
})

test('nested normalization in properties', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: {
      nested: {
        definitions: { inner: { type: 'number' } },
        dependencies: { x: ['y'] }
      }
    }
  }
  normalizeDraft7(s)
  assert(s.properties.nested.$defs && s.properties.nested.$defs.inner.type === 'number')
  assert(deepEqual(s.properties.nested.dependentRequired, { x: ['y'] }))
  assert(!s.properties.nested.definitions)
  assert(!s.properties.nested.dependencies)
})

test('nested normalization in allOf/anyOf/oneOf', () => {
  const s = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    allOf: [{ definitions: { a: { type: 'string' } } }]
  }
  normalizeDraft7(s)
  assert(s.allOf[0].$defs && s.allOf[0].$defs.a.type === 'string')
})

test('non-draft-7 schema is not modified', () => {
  const s = { definitions: { foo: { type: 'string' } }, dependencies: { a: ['b'] } }
  const original = JSON.stringify(s)
  normalizeDraft7(s)
  assert(JSON.stringify(s) === original, 'should not modify non-draft-7 schema')
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
