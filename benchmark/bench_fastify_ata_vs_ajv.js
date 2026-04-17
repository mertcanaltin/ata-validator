#!/usr/bin/env node
'use strict'

/**
 * Fastify pipeline benchmark: ajv (default) vs ata (setValidatorCompiler)
 * Both servers use identical routes and schema, real HTTP requests via autocannon.
 */

const { Validator } = require('../index')
const autocannon = require('autocannon')

const DURATION = 5
const CONNECTIONS = 10
const PIPELINING = 10

const schemas = Array.from({ length: 10 }, (_, i) => ({
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string' },
    [`field_${i}`]: { type: 'string' },
    active: { type: 'boolean' },
  },
  required: ['id', 'name', 'email'],
}))

const validBody = JSON.stringify({
  id: 42, name: 'alice', email: 'a@b.com', field_0: 'x', active: true,
})
const invalidBody = JSON.stringify({
  id: -1, name: '', email: 123, active: 'yes',
})

function ataValidatorCompiler({ schema }) {
  const v = new Validator(schema)
  return function validate(data) {
    const result = v.validate(data)
    if (result.valid) return { value: data }
    const error = new Error(result.errors.map(e => e.message).join(', '))
    error.validation = result.errors
    return { error }
  }
}

function bench(port, body, title) {
  return new Promise((resolve) => {
    autocannon({
      url: `http://127.0.0.1:${port}/route-0`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duration: DURATION,
      connections: CONNECTIONS,
      pipelining: PIPELINING,
    }, (err, result) => {
      console.log(`  ${title}`)
      console.log(`    ${result.requests.average.toLocaleString()} req/s | p50 ${result.latency.p50.toFixed(2)}ms | p99 ${result.latency.p99.toFixed(2)}ms`)
      resolve(result)
    })
  })
}

async function main() {
  const Fastify = require('fastify')

  // --- ajv server (Fastify default) ---
  const ajvApp = Fastify({ logger: false })
  for (let i = 0; i < 10; i++) {
    ajvApp.post(`/route-${i}`, { schema: { body: schemas[i] } }, async () => ({ ok: true }))
  }
  await ajvApp.listen({ port: 3010, host: '127.0.0.1' })

  // --- ata server ---
  const ataApp = Fastify({ logger: false })
  ataApp.setValidatorCompiler(ataValidatorCompiler)
  for (let i = 0; i < 10; i++) {
    ataApp.post(`/route-${i}`, { schema: { body: schemas[i] } }, async () => ({ ok: true }))
  }
  await ataApp.listen({ port: 3011, host: '127.0.0.1' })

  console.log('\nFastify Pipeline: ajv vs ata (setValidatorCompiler)')
  console.log('='.repeat(60))
  console.log(`${DURATION}s, ${CONNECTIONS} connections, ${PIPELINING} pipelining, 10 routes\n`)

  // Warmup
  await bench(3010, validBody, 'warmup ajv')
  await bench(3011, validBody, 'warmup ata')
  console.log('')

  // Valid
  console.log('Valid payload:')
  const ajvV = await bench(3010, validBody, 'Fastify + ajv')
  const ataV = await bench(3011, validBody, 'Fastify + ata')
  const validRatio = (ataV.requests.average / ajvV.requests.average).toFixed(2)
  console.log(`  -> ata/ajv: ${validRatio}x throughput\n`)

  // Invalid
  console.log('Invalid payload:')
  const ajvI = await bench(3010, invalidBody, 'Fastify + ajv')
  const ataI = await bench(3011, invalidBody, 'Fastify + ata')
  const invalidRatio = (ataI.requests.average / ajvI.requests.average).toFixed(2)
  console.log(`  -> ata/ajv: ${invalidRatio}x throughput\n`)

  console.log('Summary')
  console.log('-'.repeat(60))
  console.log(`  Valid:   ajv ${ajvV.requests.average.toLocaleString()} req/s vs ata ${ataV.requests.average.toLocaleString()} req/s (${validRatio}x)`)
  console.log(`  Invalid: ajv ${ajvI.requests.average.toLocaleString()} req/s vs ata ${ataI.requests.average.toLocaleString()} req/s (${invalidRatio}x)`)

  await ajvApp.close()
  await ataApp.close()
}

main().catch(console.error)
