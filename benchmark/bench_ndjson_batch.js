#!/usr/bin/env node
'use strict'

/**
 * NDJSON batch validation: ata countValid vs ajv per-message loop.
 *
 * ata sends the whole buffer to native (simdjson scans lines + validates each),
 * ajv has to JSON.parse + validate each line in JS.
 *
 * This is where simdjson's structural advantage plus N-API call amortization
 * shows up. ajv cannot match: pure JS, per-message JS<->engine crossing.
 */

const { Validator } = require('../index')
const Ajv = require('./node_modules/ajv')

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    role: { type: 'string', enum: ['admin', 'user', 'guest'] },
    active: { type: 'boolean' },
    score: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['id', 'name', 'email'],
}

function makeNdjson(n, invalidRatio = 0.05) {
  const lines = []
  for (let i = 0; i < n; i++) {
    const roll = Math.random()
    if (roll < invalidRatio) {
      lines.push(JSON.stringify({ id: -1, name: '', email: 123 }))
    } else {
      lines.push(JSON.stringify({
        id: i + 1, name: `user${i}`, email: `u${i}@example.com`,
        age: 20 + (i % 50), role: ['admin','user','guest'][i % 3],
        active: i % 2 === 0, score: 50 + (i % 50),
      }))
    }
  }
  return lines.join('\n')
}

function benchAta(buffer, rounds) {
  const v = new Validator(schema)
  for (let i = 0; i < 5; i++) v.countValid(buffer)
  const t0 = process.hrtime.bigint()
  let total = 0
  for (let i = 0; i < rounds; i++) total += v.countValid(buffer)
  const t1 = process.hrtime.bigint()
  return { ns: Number(t1 - t0), validCount: total / rounds }
}

function benchAjv(ndjsonStr, rounds) {
  const ajv = new Ajv({ allErrors: false })
  const validate = ajv.compile(schema)
  const lines = ndjsonStr.split('\n')
  for (let i = 0; i < 5; i++) {
    let c = 0
    for (const l of lines) {
      try { if (validate(JSON.parse(l))) c++ } catch {}
    }
  }
  const t0 = process.hrtime.bigint()
  let total = 0
  for (let i = 0; i < rounds; i++) {
    let c = 0
    for (const l of lines) {
      try { if (validate(JSON.parse(l))) c++ } catch {}
    }
    total += c
  }
  const t1 = process.hrtime.bigint()
  return { ns: Number(t1 - t0), validCount: total / rounds }
}

function benchAjvNoTryCatch(ndjsonStr, rounds) {
  // Optimistic ajv path: skip try/catch by pre-parsing once
  // (gives ajv its best shot — still pure JS per message, but no SyntaxError handling)
  const ajv = new Ajv({ allErrors: false })
  const validate = ajv.compile(schema)
  const lines = ndjsonStr.split('\n')
  const parsed = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
  for (let i = 0; i < 5; i++) {
    let c = 0
    for (const p of parsed) if (p !== null && validate(p)) c++
  }
  const t0 = process.hrtime.bigint()
  let total = 0
  for (let i = 0; i < rounds; i++) {
    let c = 0
    for (const p of parsed) if (p !== null && validate(p)) c++
    total += c
  }
  const t1 = process.hrtime.bigint()
  return { ns: Number(t1 - t0), validCount: total / rounds }
}

function main() {
  const sizes = [100, 1000, 10000, 100000]
  const target = 5 * 1e9 // ~5 seconds per benchmark
  const scoreboardMetrics = {}

  if (!process.env.SCOREBOARD) {
    console.log('NDJSON batch validation: ata countValid vs ajv loop')
    console.log('='.repeat(64))
  }

  for (const n of sizes) {
    const ndjson = makeNdjson(n, 0.05)
    const buffer = Buffer.from(ndjson)
    // Pick rounds so each benchmark runs ~5s at ata's expected rate
    // (conservative — will be fine even if ata is slow)
    const rounds = Math.max(5, Math.ceil(target / (n * 1000)))

    if (!process.env.SCOREBOARD) {
      console.log(`\n--- ${n.toLocaleString()} messages (${(buffer.length / 1024).toFixed(1)} KB), ${rounds} rounds ---`)
    }

    const ataR = benchAta(buffer, rounds)

    if (process.env.SCOREBOARD) {
      // Capture per-message ns for the 10k size (the scoreboard gate metric).
      if (n === 10000) {
        const nsPerMsg = ataR.ns / (n * rounds)
        scoreboardMetrics['realworld.ndjson_10k'] = { ns: nsPerMsg }
      }
      continue
    }

    const ajvR = benchAjv(ndjson, rounds)
    const ajvFastR = benchAjvNoTryCatch(ndjson, rounds)

    const ataMsgPerSec = (n * rounds * 1e9) / ataR.ns
    const ajvMsgPerSec = (n * rounds * 1e9) / ajvR.ns
    const ajvFastMsgPerSec = (n * rounds * 1e9) / ajvFastR.ns

    console.log(`  ata countValid:                  ${ataMsgPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} msg/s   (valid: ${ataR.validCount})`)
    console.log(`  ajv loop (parse+validate):       ${ajvMsgPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} msg/s   (valid: ${ajvR.validCount})`)
    console.log(`  ajv loop (pre-parsed, no try):   ${ajvFastMsgPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} msg/s   (valid: ${ajvFastR.validCount})`)
    console.log(`  ata vs ajv:                      ${(ataMsgPerSec / ajvMsgPerSec).toFixed(2)}x`)
    console.log(`  ata vs ajv (no parse overhead):  ${(ataMsgPerSec / ajvFastMsgPerSec).toFixed(2)}x`)
  }

  if (process.env.SCOREBOARD) {
    console.log('SCOREBOARD_JSON:' + JSON.stringify({ file: 'bench_ndjson_batch.js', metrics: scoreboardMetrics }))
  }
}

main()
