// Deep V8 profiling for unevaluated keywords
// Run with: node --trace-deopt --trace-opt --allow-natives-syntax benchmark/profile_v8_deep.js
const { Validator, compileToJSCodegen } = (() => {
  const { Validator } = require('../index')
  const { compileToJSCodegen } = require('../lib/js-compiler')
  return { Validator, compileToJSCodegen }
})()

// ─── Schemas ───
const schemas = {
  tier1: {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' } },
    required: ['id', 'name', 'email'],
    unevaluatedProperties: false,
  },
  tier2: {
    type: 'object',
    properties: { id: { type: 'integer' } },
    allOf: [{ properties: { name: { type: 'string' } } }, { properties: { email: { type: 'string' } } }],
    required: ['id', 'name', 'email'],
    unevaluatedProperties: false,
  },
  tier3: {
    type: 'object',
    properties: { kind: { type: 'string' } },
    required: ['kind'],
    anyOf: [
      { properties: { name: { type: 'string' }, age: { type: 'integer' } } },
      { properties: { title: { type: 'string' }, year: { type: 'integer' } } },
    ],
    unevaluatedProperties: false,
  },
  items: {
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
    unevaluatedItems: false,
  },
  // Baseline: same structure, additionalProperties instead
  baseline: {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' } },
    required: ['id', 'name', 'email'],
    additionalProperties: false,
  },
}

// Print generated code for each
console.log('=== Generated Code ===\n')
for (const [name, schema] of Object.entries(schemas)) {
  const fn = compileToJSCodegen(schema)
  console.log(`--- ${name} ---`)
  console.log(fn ? fn._source : 'null (codegen failed)')
  console.log()
}

// ─── Data ───
const data = {
  tier1_valid: { id: 1, name: 'Mert', email: 'm@e.com' },
  tier1_invalid: { id: 1, name: 'Mert', email: 'm@e.com', extra: true },
  tier3_valid: { kind: 'person', name: 'Mert', age: 28 },
  tier3_invalid: { kind: 'person', name: 'Mert', age: 28, extra: true },
  items_valid: ['hello', 42, true],
  items_invalid: ['hello', 42, true, 'extra'],
}

// Compile validators
const validators = {}
for (const [name, schema] of Object.entries(schemas)) {
  validators[name] = new Validator(schema)
}

// Warmup — ensure V8 JIT compiles everything
console.log('=== Warmup ===')
for (let i = 0; i < 50000; i++) {
  validators.tier1.isValidObject(data.tier1_valid)
  validators.tier1.isValidObject(data.tier1_invalid)
  validators.tier3.isValidObject(data.tier3_valid)
  validators.tier3.isValidObject(data.tier3_invalid)
  validators.items.isValidObject(data.items_valid)
  validators.items.isValidObject(data.items_invalid)
  validators.baseline.isValidObject(data.tier1_valid)
}
console.log('Warmup done.\n')

// ─── Benchmark each individually ───
function bench(label, fn, N) {
  const start = process.hrtime.bigint()
  for (let i = 0; i < N; i++) fn()
  const end = process.hrtime.bigint()
  const ns = Number(end - start) / N
  console.log(`${label}: ${ns.toFixed(2)} ns/iter`)
  return ns
}

const N = 5_000_000
console.log('=== Benchmarks ===\n')

const t_baseline = bench('baseline valid      ', () => validators.baseline.isValidObject(data.tier1_valid), N)
const t_tier1_v = bench('tier1 valid          ', () => validators.tier1.isValidObject(data.tier1_valid), N)
const t_tier1_i = bench('tier1 invalid        ', () => validators.tier1.isValidObject(data.tier1_invalid), N)
const t_tier3_v = bench('tier3 valid          ', () => validators.tier3.isValidObject(data.tier3_valid), N)
const t_tier3_i = bench('tier3 invalid        ', () => validators.tier3.isValidObject(data.tier3_invalid), N)
const t_items_v = bench('items valid          ', () => validators.items.isValidObject(data.items_valid), N)
const t_items_i = bench('items invalid        ', () => validators.items.isValidObject(data.items_invalid), N)

console.log('\n=== Analysis ===')
console.log(`tier1 vs baseline: ${(t_baseline / t_tier1_v).toFixed(2)}x (should be ~1.0)`)
console.log(`tier3 overhead vs tier1: ${(t_tier3_v / t_tier1_v).toFixed(2)}x`)
console.log(`tier3 function call overhead: ${(t_tier3_v - t_tier1_v).toFixed(2)} ns`)
