// Focused single-metric bench for simple validate(obj) valid path.
// Hot loop only, no mitata. Designed for xctrace Time Profiler sampling.
//
// Usage:
//   node benchmark/bench_simple_validate.mjs                         (default 60M iters, ~3s warm)
//   ITERS=200_000_000 node benchmark/bench_simple_validate.mjs       (longer for xctrace)
//
// xctrace:
//   xctrace record --template "Time Profiler" --launch -- \
//     env ITERS=300000000 node benchmark/bench_simple_validate.mjs \
//     --output traces/simple-current.trace
//
// Schema matches README's "Simple Schema (7 properties, type + format + range + nested object)"
// — copied verbatim from benchmark/bench_vs_ajv.js so the regressed metric (22→35ns) is reproduced.

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Validator } = require('../index.js')

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    active: { type: 'boolean' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
      maxItems: 10,
    },
    address: {
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' },
        zip: { type: 'string', pattern: '^[0-9]{5}$' },
      },
      required: ['street', 'city'],
    },
  },
  required: ['id', 'name', 'email', 'active'],
}

const validDoc = {
  id: 42,
  name: 'Mert Can Altin',
  email: 'mert@example.com',
  age: 26,
  active: true,
  tags: ['nodejs', 'cpp', 'performance'],
  address: { street: '123 Main St', city: 'Istanbul', zip: '34000' },
}

const v = new Validator(schema)

// Sanity check
const r = v.validate(validDoc)
if (!r.valid) {
  console.error('FATAL: doc not valid', r.errors)
  process.exit(1)
}

// Warmup (force JIT compilation of the validate path)
for (let i = 0; i < 100_000; i++) v.validate(validDoc)

const ITERS = Number(process.env.ITERS ?? 60_000_000)

// Hot loop. `sink` keeps V8 from eliding the call.
let sink = 0
const t0 = process.hrtime.bigint()
for (let i = 0; i < ITERS; i++) {
  const out = v.validate(validDoc)
  sink ^= out.valid ? 1 : 0
}
const t1 = process.hrtime.bigint()

const totalNs = Number(t1 - t0)
const perOp = totalNs / ITERS
console.log(`simple.validate.valid: ${perOp.toFixed(2)} ns/op (${ITERS} iters, sink=${sink})`)
