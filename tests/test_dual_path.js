'use strict'

// Dual-path regression test: verifies JS codegen and NAPI C++ validator
// produce identical results for the same inputs.

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const schemas = [
  { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  { type: 'object', properties: { role: { enum: ['a', 'b', 'c'] } }, required: ['role'] },
  { type: 'object', properties: { v: { const: 42 } }, required: ['v'] },
  { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'integer' } } }] },
  { anyOf: [{ type: 'string' }, { type: 'integer' }] },
  { oneOf: [{ type: 'string', minLength: 1 }, { type: 'integer', minimum: 0 }] },
  { not: { type: 'string' } },
  { if: { properties: { x: { type: 'string' } }, required: ['x'] }, then: { properties: { y: { type: 'integer' } }, required: ['y'] }, else: { properties: { z: { type: 'boolean' } } } },
  { type: 'object', properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 0, maximum: 150 } }, required: ['email'] },
  { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { type: 'array', items: { type: 'string' }, uniqueItems: true },
  { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
  { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, dependentRequired: { a: ['b'] } },
  { type: 'array', contains: { type: 'integer', minimum: 10 } },
  { type: 'string', pattern: '^[a-z]+$' },
]

const testData = [
  { name: 'Mert' }, { name: 123 }, { role: 'a' }, { role: 'x' },
  42, 'hello', null, true, false, [], {},
  { a: 'hi', b: 5 }, { a: 'hi' }, 'short', '',
  { email: 'a@b.com', age: 25 }, { email: 'bad' }, { email: 'a@b.com', age: -1 },
  [{ id: 1 }, { id: 2 }], [{ id: 'x' }], ['a', 'b', 'c'], ['a', 'a'],
  { a: 'ok' }, { a: 'ok', extra: 1 },
  { a: 'hi', b: 'there' }, { a: 'hi' },
  [1, 5, 15], [1, 2, 3],
  'abc', 'ABC', '123',
  { x: 'hi', y: 5 }, { x: 'hi' }, { x: 5, z: true }, { x: 5 },
  { v: 42 }, { v: 43 },
]

// Write a helper script that both runs use
const helperPath = path.join(__dirname, '_dual_helper.js')
fs.writeFileSync(helperPath, `
'use strict';
const { Validator } = require('../index');
const schemas = ${JSON.stringify(schemas)};
const testData = ${JSON.stringify(testData)};
const results = [];
for (const schema of schemas) {
  const v = new Validator(schema);
  for (const data of testData) {
    results.push(v.validate(data).valid ? 1 : 0);
  }
}
process.stdout.write(JSON.stringify(results));
`)

console.log('Dual-path regression test: JS codegen vs NAPI C++\n')

const root = path.resolve(__dirname, '..')
let codegen, napi

try {
  codegen = JSON.parse(execSync(`node ${helperPath}`, { cwd: root, env: { ...process.env, ATA_FORCE_NAPI: '' } }).toString())
} catch (e) {
  fs.unlinkSync(helperPath)
  console.error('Codegen path failed:', e.stderr?.toString() || e.message)
  process.exit(1)
}

try {
  napi = JSON.parse(execSync(`node ${helperPath}`, { cwd: root, env: { ...process.env, ATA_FORCE_NAPI: '1' } }).toString())
} catch (e) {
  fs.unlinkSync(helperPath)
  console.error('NAPI path failed:', e.stderr?.toString() || e.message)
  process.exit(1)
}

fs.unlinkSync(helperPath)

let pass = 0, fail = 0
for (let i = 0; i < codegen.length; i++) {
  if (codegen[i] !== napi[i]) {
    const si = Math.floor(i / testData.length)
    const di = i % testData.length
    console.log(`  MISMATCH  schema[${si}] + data[${di}]: codegen=${codegen[i]} napi=${napi[i]}`)
    console.log(`    schema: ${JSON.stringify(schemas[si])}`)
    console.log(`    data:   ${JSON.stringify(testData[di])}`)
    fail++
  } else {
    pass++
  }
}

console.log(`\n${pass} matched, ${fail} mismatches out of ${codegen.length} checks`)
if (fail > 0) {
  console.log('\nFAIL: codegen and NAPI paths disagree')
  process.exit(1)
} else {
  console.log('\nPASS: both paths produce identical results')
}
