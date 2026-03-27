'use strict'

// CI pipeline simulation: process starts cold, compiles schemas, runs validations, exits.
// Measures total wall time from require() to last validation.

const schemas = [
  { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 100 }, email: { type: 'string', format: 'email' }, active: { type: 'boolean' } }, required: ['id', 'name', 'email'] },
  { type: 'object', properties: { title: { type: 'string', minLength: 1 }, price: { type: 'number', minimum: 0 }, currency: { type: 'string', enum: ['USD', 'EUR', 'TRY'] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 10 } }, required: ['title', 'price'] },
  { type: 'object', properties: { query: { type: 'string', minLength: 1 }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'] },
  { type: 'object', properties: { userId: { type: 'integer', minimum: 1 }, items: { type: 'array', items: { type: 'object', properties: { productId: { type: 'integer' }, quantity: { type: 'integer', minimum: 1, maximum: 99 } }, required: ['productId', 'quantity'] }, minItems: 1, maxItems: 50 } }, required: ['userId', 'items'] },
  { type: 'object', properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } }, required: ['email', 'password'] },
]

const testData = [
  { valid: { id: 1, name: 'Mert', email: 'mert@test.com', active: true }, invalid: { id: -1, name: '', email: 'bad', active: 'no' } },
  { valid: { title: 'Widget', price: 9.99, currency: 'USD', tags: ['sale'] }, invalid: { title: '', price: -1 } },
  { valid: { query: 'test', page: 1, limit: 20 }, invalid: { query: '', page: 0 } },
  { valid: { userId: 1, items: [{ productId: 1, quantity: 2 }] }, invalid: { userId: -1, items: [] } },
  { valid: { email: 'a@b.com', password: '12345678' }, invalid: { email: 'bad', password: '123' } },
]

function runAta(schemaCount, validationsPerSchema) {
  const { Validator } = require('../index')
  const start = performance.now()

  const validators = []
  for (let i = 0; i < schemaCount; i++) {
    validators.push(new Validator(schemas[i % schemas.length]))
  }

  let validCount = 0
  let invalidCount = 0
  for (let i = 0; i < schemaCount; i++) {
    const data = testData[i % testData.length]
    for (let j = 0; j < validationsPerSchema; j++) {
      const r1 = validators[i].validate(data.valid)
      if (r1.valid) validCount++
      const r2 = validators[i].validate(data.invalid)
      if (!r2.valid) invalidCount++
    }
  }

  return { elapsed: performance.now() - start, validCount, invalidCount }
}

function runAjv(schemaCount, validationsPerSchema) {
  const Ajv = require('./node_modules/ajv')
  const addFormats = require('./node_modules/ajv-formats')
  const start = performance.now()

  const ajv = new Ajv({ allErrors: true })
  addFormats(ajv)

  const validators = []
  for (let i = 0; i < schemaCount; i++) {
    validators.push(ajv.compile(schemas[i % schemas.length]))
  }

  let validCount = 0
  let invalidCount = 0
  for (let i = 0; i < schemaCount; i++) {
    const data = testData[i % testData.length]
    for (let j = 0; j < validationsPerSchema; j++) {
      const r1 = validators[i](data.valid)
      if (r1) validCount++
      const r2 = validators[i](data.invalid)
      if (!r2) invalidCount++
    }
  }

  return { elapsed: performance.now() - start, validCount, invalidCount }
}

console.log('==========================================================')
console.log('  CI Pipeline Simulation: require + compile + validate')
console.log('==========================================================\n')

const scenarios = [
  { schemas: 5, validations: 100, label: 'small test suite (5 schemas, 100 validations each)' },
  { schemas: 20, validations: 500, label: 'medium test suite (20 schemas, 500 validations each)' },
  { schemas: 50, validations: 1000, label: 'large test suite (50 schemas, 1000 validations each)' },
]

for (const s of scenarios) {
  const ata = runAta(s.schemas, s.validations)
  const ajv = runAjv(s.schemas, s.validations)
  const ratio = ajv.elapsed / ata.elapsed

  console.log(`  ${s.label}:`)
  console.log(`    ata: ${ata.elapsed.toFixed(2)}ms (${ata.validCount + ata.invalidCount} validations)`)
  console.log(`    ajv: ${ajv.elapsed.toFixed(2)}ms (${ajv.validCount + ajv.invalidCount} validations)`)
  console.log(`    ata is ${ratio.toFixed(1)}x faster\n`)
}
