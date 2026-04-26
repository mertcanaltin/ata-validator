// Focused single-metric bench for complex validate(obj) valid path.
// Hot loop only, no mitata. Designed for xctrace Time Profiler sampling.
//
// Schema matches README's "Complex Schema (patternProperties + dependentSchemas + propertyNames + additionalProperties)"
// — copied verbatim from benchmark/bench_complex_mitata.mjs.

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Validator } = require('../index.js')

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
  },
  required: ['id', 'name', 'email'],
  patternProperties: {
    '^x-': { type: 'string' },
  },
  propertyNames: { maxLength: 20 },
  dependentSchemas: {
    email: { required: ['name'] },
  },
  additionalProperties: false,
}

const validDoc = { id: 1, name: 'Mert', email: 'mert@test.com', tags: ['dev'], 'x-custom': 'val' }

const v = new Validator(schema)

const r = v.validate(validDoc)
if (!r.valid) {
  console.error('FATAL: doc not valid', r.errors)
  process.exit(1)
}

for (let i = 0; i < 100_000; i++) v.validate(validDoc)

const ITERS = Number(process.env.ITERS ?? 60_000_000)

let sink = 0
const t0 = process.hrtime.bigint()
for (let i = 0; i < ITERS; i++) {
  const out = v.validate(validDoc)
  sink ^= out.valid ? 1 : 0
}
const t1 = process.hrtime.bigint()

const totalNs = Number(t1 - t0)
const perOp = totalNs / ITERS
console.log(`complex.validate.valid: ${perOp.toFixed(2)} ns/op (${ITERS} iters, sink=${sink})`)
