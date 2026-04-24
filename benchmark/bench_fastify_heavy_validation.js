#!/usr/bin/env node
'use strict'

/**
 * Heavy-validation Fastify endpoint: nested schema, array payload,
 * enum + format + length constraints. Representative of admission
 * controllers, bulk ingest APIs, complex form validators — cases
 * where validation is a meaningful slice of request time.
 */

const { Validator } = require('../index')
const autocannon = require('autocannon')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DURATION = 5
const CONNECTIONS = 10
const PIPELINING = 10

const schema = {
  type: 'object',
  properties: {
    orgId: { type: 'string', minLength: 8, maxLength: 32 },
    requestId: { type: 'string', minLength: 8 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          sku: { type: 'string', minLength: 3, maxLength: 20 },
          price: { type: 'number', minimum: 0, maximum: 1000000 },
          quantity: { type: 'integer', minimum: 1, maximum: 10000 },
          category: { type: 'string', enum: ['book','media','food','apparel','electronics','misc'] },
          flags: {
            type: 'object',
            properties: {
              taxable: { type: 'boolean' },
              discounted: { type: 'boolean' },
              giftWrap: { type: 'boolean' },
            },
          },
          tags: { type: 'array', items: { type: 'string', maxLength: 30 } },
          attributes: {
            type: 'object',
            properties: {
              color: { type: 'string', maxLength: 30 },
              size: { type: 'string', maxLength: 10 },
              weight: { type: 'number', minimum: 0 },
            },
          },
        },
        required: ['id','sku','price','quantity','category'],
      },
    },
    user: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        email: { type: 'string', minLength: 5, maxLength: 200 },
        tier: { type: 'string', enum: ['free','pro','enterprise'] },
      },
      required: ['id','email','tier'],
    },
  },
  required: ['orgId','requestId','items','user'],
}

function makeItem(i) {
  return {
    id: i + 1,
    sku: `SKU-${1000 + i}`,
    price: 10 + (i % 500),
    quantity: 1 + (i % 50),
    category: ['book','media','food','apparel','electronics','misc'][i % 6],
    flags: { taxable: i % 2 === 0, discounted: i % 3 === 0, giftWrap: i % 5 === 0 },
    tags: ['new', `t-${i}`, 'hot'],
    attributes: { color: ['red','blue','green'][i % 3], size: 'M', weight: i * 0.1 },
  }
}

const validBody = JSON.stringify({
  orgId: 'org-abc123',
  requestId: 'req-x9k2p4-2026-04-24',
  items: Array.from({ length: 50 }, (_, i) => makeItem(i)),
  user: { id: 7, email: 'alice@example.com', tier: 'pro' },
})

const invalidBody = JSON.stringify({
  orgId: 'org-abc123',
  requestId: 'req-x9k2p4-2026-04-24',
  items: Array.from({ length: 50 }, (_, i) => {
    const it = makeItem(i)
    if (i === 42) it.category = 'unknown' // late-in-array invalid
    return it
  }),
  user: { id: 7, email: 'alice@example.com', tier: 'pro' },
})

// Pre-compile with ata compile
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-heavy-'))
const compiledPath = path.join(tmpDir, 'compiled.cjs')
const v = new Validator(schema)
fs.writeFileSync(compiledPath, v.toStandaloneModule({ format: 'cjs' }))
const vAbort = new Validator(schema, { abortEarly: true })
const compiledMod = require(compiledPath)

function runtimeCompiler({ schema }) {
  const v = new Validator(schema)
  return (d) => { const r = v.validate(d); return r.valid ? { value: d } : { error: Object.assign(new Error(''), { validation: r.errors }) } }
}
function runtimeAbortCompiler({ schema }) {
  const v = new Validator(schema, { abortEarly: true })
  return (d) => { const r = v.validate(d); return r.valid ? { value: d } : { error: Object.assign(new Error(''), { validation: r.errors }) } }
}
function compileCompiler() {
  return (d) => { const r = compiledMod.validate(d); return r.valid ? { value: d } : { error: Object.assign(new Error(''), { validation: r.errors }) } }
}

function run(port, body, label) {
  return new Promise((resolve) => {
    const inst = autocannon({
      url: `http://127.0.0.1:${port}/p`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duration: DURATION,
      connections: CONNECTIONS,
      pipelining: PIPELINING,
    }, (err, res) => {
      if (err) throw err
      console.log(`  ${label.padEnd(38)} ${res.requests.average.toLocaleString().padStart(10)} req/s  p99 ${res.latency.p99.toFixed(2)}ms`)
      resolve(res)
    })
    autocannon.track(inst, { renderProgressBar: false, renderLatencyTable: false, renderResultsTable: false })
  })
}

async function main() {
  const Fastify = require('fastify')

  const ajv = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  ajv.post('/p', { schema: { body: schema } }, async () => ({ ok: true }))
  await ajv.listen({ port: 3601, host: '127.0.0.1' })

  const ata = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  ata.setValidatorCompiler(runtimeCompiler)
  ata.post('/p', { schema: { body: schema } }, async () => ({ ok: true }))
  await ata.listen({ port: 3602, host: '127.0.0.1' })

  const ataAb = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  ataAb.setValidatorCompiler(runtimeAbortCompiler)
  ataAb.post('/p', { schema: { body: schema } }, async () => ({ ok: true }))
  await ataAb.listen({ port: 3603, host: '127.0.0.1' })

  const ataCmp = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  ataCmp.setValidatorCompiler(compileCompiler)
  ataCmp.post('/p', { schema: { body: schema } }, async () => ({ ok: true }))
  await ataCmp.listen({ port: 3604, host: '127.0.0.1' })

  console.log(`\nHeavy validation Fastify: payload ${validBody.length.toLocaleString()} bytes, 50 items`)
  console.log('='.repeat(72))
  console.log(`${DURATION}s, ${CONNECTIONS} conn, pipelining=${PIPELINING}\n`)

  // Warm up
  await run(3601, validBody, 'warmup ajv')
  await run(3602, validBody, 'warmup ata runtime')
  await run(3603, validBody, 'warmup ata runtime abortEarly')
  await run(3604, validBody, 'warmup ata compile')
  console.log('')

  console.log('Valid payload:')
  const a1 = await run(3601, validBody, 'Fastify + ajv')
  const b1 = await run(3602, validBody, 'Fastify + ata runtime')
  const c1 = await run(3603, validBody, 'Fastify + ata + abortEarly')
  const d1 = await run(3604, validBody, 'Fastify + ata compile')
  console.log(`  ata runtime vs ajv:       ${(b1.requests.average / a1.requests.average).toFixed(3)}x`)
  console.log(`  ata abortEarly vs ajv:    ${(c1.requests.average / a1.requests.average).toFixed(3)}x`)
  console.log(`  ata compile vs ajv:       ${(d1.requests.average / a1.requests.average).toFixed(3)}x\n`)

  console.log('Invalid payload (item 42 has bad category):')
  const a2 = await run(3601, invalidBody, 'Fastify + ajv')
  const b2 = await run(3602, invalidBody, 'Fastify + ata runtime')
  const c2 = await run(3603, invalidBody, 'Fastify + ata + abortEarly')
  const d2 = await run(3604, invalidBody, 'Fastify + ata compile')
  console.log(`  ata runtime vs ajv:       ${(b2.requests.average / a2.requests.average).toFixed(3)}x`)
  console.log(`  ata abortEarly vs ajv:    ${(c2.requests.average / a2.requests.average).toFixed(3)}x`)
  console.log(`  ata compile vs ajv:       ${(d2.requests.average / a2.requests.average).toFixed(3)}x\n`)

  await ajv.close()
  await ata.close()
  await ataAb.close()
  await ataCmp.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
