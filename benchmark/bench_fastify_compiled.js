#!/usr/bin/env node
'use strict'

/**
 * Fastify + ata compile (build-time validators) vs Fastify + ajv vs Fastify + ata runtime.
 * Measures: runtime req/s, server startup time for N routes, memory.
 */

const { Validator } = require('../index')
const autocannon = require('autocannon')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DURATION = 4
const CONNECTIONS = 10
const PIPELINING = 10

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    role: { type: 'string', enum: ['admin','user','guest'] },
    active: { type: 'boolean' },
  },
  required: ['id','name','email'],
}

const validBody = JSON.stringify({
  id: 1, name: 'alice', email: 'a@b.com', age: 30, role: 'user', active: true,
})
const invalidBody = JSON.stringify({ id: -1, name: '', email: 123 })

// Pre-compile once with ata compile, write to a temp file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-bench-'))
const compiledPath = path.join(tmpDir, 'compiled.cjs')
const v = new Validator(schema)
fs.writeFileSync(compiledPath, v.toStandaloneModule({ format: 'cjs' }))
const compiledMod = require(compiledPath)

// Validator compilers
function ataRuntimeCompiler({ schema }) {
  const v = new Validator(schema)
  return (data) => {
    const r = v.validate(data)
    if (r.valid) return { value: data }
    const e = new Error(''); e.validation = r.errors; return { error: e }
  }
}

function ataCompiledCompiler() {
  // Compiled validator is already baked; ignore the schema param.
  return (data) => {
    const r = compiledMod.validate(data)
    if (r.valid) return { value: data }
    const e = new Error(''); e.validation = r.errors; return { error: e }
  }
}

function run(port, body, label) {
  return new Promise((resolve) => {
    const inst = autocannon({
      url: `http://127.0.0.1:${port}/u`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duration: DURATION,
      connections: CONNECTIONS,
      pipelining: PIPELINING,
    }, (err, res) => {
      if (err) throw err
      console.log(`  ${label.padEnd(36)} ${res.requests.average.toLocaleString().padStart(10)} req/s  p99 ${res.latency.p99.toFixed(2)}ms`)
      resolve(res)
    })
    autocannon.track(inst, { renderProgressBar: false, renderLatencyTable: false, renderResultsTable: false })
  })
}

async function measureStartup(nRoutes) {
  const Fastify = require('fastify')

  const configs = [
    { name: 'ajv (default)', compiler: null },
    { name: 'ata runtime', compiler: ataRuntimeCompiler },
    { name: 'ata compile', compiler: ataCompiledCompiler },
  ]

  console.log(`\nServer ready time with ${nRoutes} routes (schema compile + register):`)
  for (const cfg of configs) {
    const app = Fastify({ logger: false })
    if (cfg.compiler) app.setValidatorCompiler(cfg.compiler)
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < nRoutes; i++) {
      app.post(`/r${i}`, { schema: { body: schema } }, async () => ({ ok: true }))
    }
    await app.ready()
    const t1 = process.hrtime.bigint()
    const ms = Number(t1 - t0) / 1e6
    console.log(`  ${cfg.name.padEnd(36)} ${ms.toFixed(2).padStart(8)} ms`)
    await app.close()
  }
}

async function measureThroughput() {
  const Fastify = require('fastify')

  const ajvSrv = Fastify({ logger: false })
  ajvSrv.post('/u', { schema: { body: schema } }, async () => ({ ok: true }))
  await ajvSrv.listen({ port: 3501, host: '127.0.0.1' })

  const ataRunSrv = Fastify({ logger: false })
  ataRunSrv.setValidatorCompiler(ataRuntimeCompiler)
  ataRunSrv.post('/u', { schema: { body: schema } }, async () => ({ ok: true }))
  await ataRunSrv.listen({ port: 3502, host: '127.0.0.1' })

  const ataCompSrv = Fastify({ logger: false })
  ataCompSrv.setValidatorCompiler(ataCompiledCompiler)
  ataCompSrv.post('/u', { schema: { body: schema } }, async () => ({ ok: true }))
  await ataCompSrv.listen({ port: 3503, host: '127.0.0.1' })

  console.log(`\nThroughput (${DURATION}s, ${CONNECTIONS} conn, pipelining=${PIPELINING}):\n`)

  // Warm up
  await run(3501, validBody, 'warmup ajv')
  await run(3502, validBody, 'warmup ata runtime')
  await run(3503, validBody, 'warmup ata compile')
  console.log('')

  console.log('Valid payload:')
  const a1 = await run(3501, validBody, 'Fastify + ajv')
  const b1 = await run(3502, validBody, 'Fastify + ata runtime')
  const c1 = await run(3503, validBody, 'Fastify + ata compile')
  console.log(`  ata runtime vs ajv: ${(b1.requests.average / a1.requests.average).toFixed(3)}x`)
  console.log(`  ata compile vs ajv: ${(c1.requests.average / a1.requests.average).toFixed(3)}x\n`)

  console.log('Invalid payload:')
  const a2 = await run(3501, invalidBody, 'Fastify + ajv')
  const b2 = await run(3502, invalidBody, 'Fastify + ata runtime')
  const c2 = await run(3503, invalidBody, 'Fastify + ata compile')
  console.log(`  ata runtime vs ajv: ${(b2.requests.average / a2.requests.average).toFixed(3)}x`)
  console.log(`  ata compile vs ajv: ${(c2.requests.average / a2.requests.average).toFixed(3)}x\n`)

  await ajvSrv.close()
  await ataRunSrv.close()
  await ataCompSrv.close()
}

async function main() {
  console.log('Fastify: ajv vs ata runtime vs ata compile')
  console.log('='.repeat(64))

  for (const n of [10, 50, 200]) {
    await measureStartup(n)
  }

  await measureThroughput()

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
