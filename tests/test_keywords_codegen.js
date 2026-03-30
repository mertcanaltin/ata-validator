'use strict'

const { compileToJSCodegen } = require('../lib/js-compiler')

let passed = 0
let failed = 0

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

function assertValid(fn, data, msg) {
  assert(fn !== null, `validator compiled (got null) — ${msg}`)
  assert(fn(data) === true, `expected valid: ${msg} — data: ${JSON.stringify(data)}`)
}

function assertInvalid(fn, data, msg) {
  assert(fn !== null, `validator compiled (got null) — ${msg}`)
  assert(fn(data) === false, `expected invalid: ${msg} — data: ${JSON.stringify(data)}`)
}

console.log('\n--- patternProperties codegen ---\n')

test('patternProperties: single pattern, valid key', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: { '^S_': { type: 'string' } }
  })
  assertValid(fn, { S_foo: 'hello' }, 'matching key with string value')
  assertValid(fn, { other: 123 }, 'non-matching key skipped')
  assertValid(fn, {}, 'empty object')
})

test('patternProperties: single pattern, invalid key', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: { '^S_': { type: 'string' } }
  })
  assertInvalid(fn, { S_foo: 123 }, 'matching key with wrong type')
})

test('patternProperties: multiple patterns', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: {
      '^i_': { type: 'integer' },
      '^s_': { type: 'string' }
    }
  })
  assertValid(fn, { i_count: 5, s_name: 'abc' }, 'both valid')
  assertInvalid(fn, { i_count: 'bad' }, 'integer pattern with string')
  assertInvalid(fn, { s_name: 42 }, 'string pattern with number')
})

test('patternProperties: ignores non-objects', () => {
  const fn = compileToJSCodegen({
    patternProperties: { '^x': { type: 'string' } }
  })
  assertValid(fn, 'hello', 'string is not object — skip')
  assertValid(fn, 42, 'number is not object — skip')
  assertValid(fn, null, 'null is not object — skip')
  assertValid(fn, [1, 2], 'array is not object — skip')
})

test('patternProperties: with properties + additionalProperties: false', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    properties: { name: { type: 'string' } },
    patternProperties: { '^x_': { type: 'integer' } },
    additionalProperties: false
  })
  assertValid(fn, { name: 'Alice', x_count: 5 }, 'allowed props and pattern match')
  assertValid(fn, { name: 'Bob' }, 'only static prop')
  assertValid(fn, { x_val: 10 }, 'only pattern prop')
  assertInvalid(fn, { name: 'Alice', extra: 'bad' }, 'unknown key rejected')
  assertInvalid(fn, { x_val: 'bad' }, 'pattern match with wrong type')
})

test('patternProperties: null values on non-matching keys are ok', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: { '^req_': { type: 'string' } }
  })
  assertValid(fn, { req_name: 'ok', other: null }, 'null on non-matching key ok')
})

test('patternProperties: bail on boolean sub-schema', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: { '^x': false }
  })
  assert(fn === null, 'should bail to null for boolean sub-schema')
})

test('patternProperties: bail on unicode property escape in pattern', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    patternProperties: { '\\p{L}+': { type: 'string' } }
  })
  assert(fn === null, 'should bail for unicode property escape')
})

console.log('\n--- dependentSchemas codegen ---\n')

test('dependentSchemas: basic — key present triggers schema', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    dependentSchemas: {
      credit_card: {
        required: ['billing_address']
      }
    }
  })
  assertValid(fn, { credit_card: '1234', billing_address: '123 Main St' }, 'both present')
  assertValid(fn, { name: 'Alice' }, 'trigger key absent — schema not applied')
  assertInvalid(fn, { credit_card: '1234' }, 'trigger key present, required missing')
})

test('dependentSchemas: ignores non-objects', () => {
  const fn = compileToJSCodegen({
    dependentSchemas: {
      foo: { required: ['bar'] }
    }
  })
  assertValid(fn, 'string value', 'non-object — skip dependentSchemas')
  assertValid(fn, 42, 'number — skip')
  assertValid(fn, null, 'null — skip')
})

test('dependentSchemas: key with special characters', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    dependentSchemas: {
      'foo-bar': { required: ['baz'] }
    }
  })
  assertValid(fn, { 'foo-bar': true, baz: 1 }, 'hyphenated key valid')
  assertInvalid(fn, { 'foo-bar': true }, 'hyphenated key missing dependency')
})

test('dependentSchemas: bail on boolean sub-schema', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    dependentSchemas: { foo: false }
  })
  assert(fn === null, 'should bail for boolean dependentSchemas sub-schema')
})

console.log('\n--- propertyNames codegen ---\n')

test('propertyNames: maxLength', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { maxLength: 5 }
  })
  assertValid(fn, { abc: 1, de: 2 }, 'keys within maxLength')
  assertInvalid(fn, { toolong: 1 }, 'key exceeds maxLength')
})

test('propertyNames: minLength', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { minLength: 3 }
  })
  assertValid(fn, { abc: 1, defg: 2 }, 'keys meet minLength')
  assertInvalid(fn, { ab: 1 }, 'key too short')
})

test('propertyNames: pattern', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { pattern: '^[a-z]+$' }
  })
  assertValid(fn, { foo: 1, bar: 2 }, 'all lowercase keys')
  assertInvalid(fn, { Foo: 1 }, 'uppercase key fails pattern')
  assertInvalid(fn, { foo1: 1 }, 'key with digit fails pattern')
})

test('propertyNames: const', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { const: 'onlyKey' }
  })
  assertValid(fn, { onlyKey: 1 }, 'only the const key allowed')
  assertValid(fn, {}, 'empty object valid')
  assertInvalid(fn, { onlyKey: 1, other: 2 }, 'extra key fails const check')
})

test('propertyNames: enum', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { enum: ['foo', 'bar', 'baz'] }
  })
  assertValid(fn, { foo: 1, bar: 2 }, 'all keys in enum')
  assertValid(fn, {}, 'empty object valid')
  assertInvalid(fn, { foo: 1, qux: 2 }, 'key not in enum')
})

test('propertyNames: ignores non-objects', () => {
  const fn = compileToJSCodegen({
    propertyNames: { maxLength: 3 }
  })
  assertValid(fn, 'string', 'string — skip propertyNames')
  assertValid(fn, 42, 'number — skip')
  assertValid(fn, null, 'null — skip')
  assertValid(fn, [1, 2, 3], 'array — skip')
})

test('propertyNames: empty object always valid', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { minLength: 10, pattern: '^z' }
  })
  assertValid(fn, {}, 'empty object has no keys to fail')
})

test('propertyNames: bail on boolean', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: false
  })
  assert(fn === null, 'should bail for boolean propertyNames=false')
})

test('propertyNames: bail on unsupported keyword', () => {
  const fn = compileToJSCodegen({
    type: 'object',
    propertyNames: { type: 'string', format: 'email' }
  })
  assert(fn === null, 'should bail for unsupported keyword in propertyNames')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
