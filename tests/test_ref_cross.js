'use strict'

const { Validator } = require('..')
const assert = require('assert')

// Helper: run a test and report pass/fail
function test(name, fn) {
  try {
    fn()
    console.log('  PASS:', name)
  } catch (err) {
    console.log('  FAIL:', name)
    console.log('       ', err.message)
    process.exitCode = 1
  }
}

// Helper: assert a test is expected to fail (Task 4 codegen not wired yet)
function testExpectedFail(name, fn) {
  try {
    fn()
    console.log('  EXPECTED-FAIL (but passed):', name)
  } catch (err) {
    console.log('  EXPECTED-FAIL (ok):', name, '—', err.message)
  }
}

console.log('\n=== schemas option: array form ===')

test('array form: buildSchemaMap stores schemas by $id', () => {
  const address = { $id: 'address', type: 'object', properties: { city: { type: 'string' } } }
  const v = new Validator(
    { $id: 'main', type: 'object', properties: { addr: { $ref: 'address' } } },
    { schemas: [address] }
  )
  assert.ok(v._schemaMap instanceof Map)
  assert.ok(v._schemaMap.has('address'))
  assert.strictEqual(v._schemaMap.get('address'), address)
})

test('array form: throws if schema missing $id', () => {
  assert.throws(
    () => new Validator({ type: 'object' }, { schemas: [{ type: 'string' }] }),
    /must have \$id/i
  )
})

test('array form: multiple schemas stored', () => {
  const s1 = { $id: 'schema-a', type: 'string' }
  const s2 = { $id: 'schema-b', type: 'number' }
  const v = new Validator({ type: 'object' }, { schemas: [s1, s2] })
  assert.ok(v._schemaMap.has('schema-a'))
  assert.ok(v._schemaMap.has('schema-b'))
})

console.log('\n=== schemas option: object form ===')

test('object form: keyed by explicit key when no $id', () => {
  const address = { type: 'object', properties: { city: { type: 'string' } } }
  const v = new Validator({ type: 'object' }, { schemas: { address } })
  assert.ok(v._schemaMap.has('address'))
  assert.strictEqual(v._schemaMap.get('address'), address)
})

test('object form: prefers $id over key', () => {
  const address = { $id: 'real-address', type: 'object' }
  const v = new Validator({ type: 'object' }, { schemas: { someKey: address } })
  assert.ok(v._schemaMap.has('real-address'))
  assert.ok(!v._schemaMap.has('someKey'))
})

test('object form: multiple schemas stored', () => {
  const v = new Validator(
    { type: 'object' },
    { schemas: { a: { type: 'string' }, b: { type: 'number' } } }
  )
  assert.ok(v._schemaMap.has('a'))
  assert.ok(v._schemaMap.has('b'))
})

console.log('\n=== addSchema() API ===')

test('addSchema: stores schema by $id', () => {
  const v = new Validator({ type: 'object' })
  v.addSchema({ $id: 'my-def', type: 'string' })
  assert.ok(v._schemaMap.has('my-def'))
})

test('addSchema: throws after compilation', () => {
  const v = new Validator({ type: 'object' })
  v.validate({}) // triggers compilation
  assert.throws(
    () => v.addSchema({ $id: 'late', type: 'string' }),
    /Cannot add schema after compilation/
  )
})

test('addSchema: throws without $id', () => {
  const v = new Validator({ type: 'object' })
  assert.throws(
    () => v.addSchema({ type: 'string' }),
    /must have \$id/i
  )
})

test('addSchema: throws when schema is null', () => {
  const v = new Validator({ type: 'object' })
  assert.throws(
    () => v.addSchema(null),
    /must have \$id/i
  )
})

test('addSchema: multiple schemas can be added', () => {
  const v = new Validator({ type: 'object' })
  v.addSchema({ $id: 'def-a', type: 'string' })
  v.addSchema({ $id: 'def-b', type: 'number' })
  assert.ok(v._schemaMap.has('def-a'))
  assert.ok(v._schemaMap.has('def-b'))
})

test('addSchema: overwrites existing $id', () => {
  const v = new Validator({ type: 'object' })
  v.addSchema({ $id: 'my-def', type: 'string' })
  v.addSchema({ $id: 'my-def', type: 'number' })
  assert.strictEqual(v._schemaMap.get('my-def').type, 'number')
})

console.log('\n=== schemaMap initial state ===')

test('no schemas option: _schemaMap is empty Map', () => {
  const v = new Validator({ type: 'object' })
  assert.ok(v._schemaMap instanceof Map)
  assert.strictEqual(v._schemaMap.size, 0)
})

test('null schemas option: _schemaMap is empty Map', () => {
  const v = new Validator({ type: 'object' }, { schemas: null })
  assert.ok(v._schemaMap instanceof Map)
  assert.strictEqual(v._schemaMap.size, 0)
})

console.log('\n=== cache correctness ===')

test('same schema with different schemas option: both get their own schemaMap', () => {
  const mainSchema = { type: 'object', properties: { x: { $ref: 'dep' } } }
  const dep1 = { $id: 'dep', type: 'string' }
  const dep2 = { $id: 'dep', type: 'number' }
  const v1 = new Validator(mainSchema, { schemas: [dep1] })
  const v2 = new Validator(mainSchema, { schemas: [dep2] })
  assert.strictEqual(v1._schemaMap.get('dep').type, 'string')
  assert.strictEqual(v2._schemaMap.get('dep').type, 'number')
})

// ===== Cross-ref validation tests (expected to fail — Task 4 will wire codegen) =====

console.log('\n=== cross-ref validation (expected to fail until Task 4) ===')

testExpectedFail('basic cross-ref: validates string via $ref', () => {
  const stringDef = { $id: 'string-def', type: 'string' }
  const v = new Validator(
    { type: 'object', properties: { name: { $ref: 'string-def' } }, required: ['name'] },
    { schemas: [stringDef] }
  )
  const ok = v.validate({ name: 'alice' })
  assert.ok(ok.valid, 'should pass for string')
  const bad = v.validate({ name: 123 })
  assert.ok(!bad.valid, 'should fail for number')
})

testExpectedFail('chained refs: A -> B -> C', () => {
  const c = { $id: 'c', type: 'integer' }
  const b = { $id: 'b', properties: { val: { $ref: 'c' } } }
  const a = { $id: 'a', properties: { inner: { $ref: 'b' } } }
  const v = new Validator(a, { schemas: [b, c] })
  assert.ok(v.validate({ inner: { val: 42 } }).valid)
  assert.ok(!v.validate({ inner: { val: 'nope' } }).valid)
})

testExpectedFail('circular refs: A -> B -> A (should not crash)', () => {
  const b = { $id: 'b', properties: { a: { $ref: 'a' } } }
  const a = { $id: 'a', type: 'object', properties: { b: { $ref: 'b' } } }
  const v = new Validator(a, { schemas: [b] })
  // Should not throw/crash
  v.validate({ b: { a: {} } })
})

testExpectedFail('isValidObject with cross-schema ref', () => {
  const numDef = { $id: 'num', type: 'number' }
  const v = new Validator(
    { type: 'object', properties: { score: { $ref: 'num' } } },
    { schemas: [numDef] }
  )
  assert.strictEqual(v.isValidObject({ score: 3.14 }), true)
  assert.strictEqual(v.isValidObject({ score: 'bad' }), false)
})

testExpectedFail('addSchema() cross-ref validation', () => {
  const v = new Validator({
    type: 'object',
    properties: { tag: { $ref: 'tag-def' } }
  })
  v.addSchema({ $id: 'tag-def', type: 'string', minLength: 1 })
  assert.ok(v.validate({ tag: 'hello' }).valid)
  assert.ok(!v.validate({ tag: '' }).valid)
})

console.log('\ndone.\n')
