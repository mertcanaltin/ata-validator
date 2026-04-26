/**
 * Shared scoreboard helpers for the ata perf rig.
 *
 * Each canonical bench file imports `runBench` from here and calls it
 * instead of bare `await run()`. When SCOREBOARD=1 is set the bench emits
 * one `SCOREBOARD_JSON:{...}` line to stdout; otherwise mitata prints its
 * normal markdown table.
 *
 * Registry key format
 * -------------------
 * Simple case (ata vs competitors, bench alias is literally "ata"):
 *   '<group label>': '<metric id>'
 *
 * Compound case (multiple ata variants in the same group, no fixed alias):
 *   '<group label>|<bench alias>': '<metric id>'
 *
 * The lookup tries the compound key first, then falls back to the plain
 * group label (expecting bench alias === 'ata').
 */

import { run } from 'mitata'

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

export const REGISTRY = [
  {
    file: 'bench_complex_mitata.mjs',
    metrics: {
      'complex schema: validate (valid)':         'complex.validate.valid',
      'complex schema: validate (invalid)':       'complex.validate.invalid',
      'complex schema: isValidObject (valid)':    'complex.isvalid.valid',
      'cross-ref: validate (valid)':              'crossref.validate.valid',
      'cross-ref: validate (invalid)':            'crossref.validate.invalid',
      'complex schema: compilation':              'complex.compile',
    },
  },
  {
    file: 'bench_dynamicref_mitata.mjs',
    metrics: {
      // All benches in this file are ata variants (no ajv competitor).
      // Capture only the two scenarios that matter for the perf gate.
      // Key format: '<group>|<alias>' because there is no single "ata" bench.
      'validate (valid doc)|$dynamicRef tree': 'dynamicref.tree.valid',
      'validate (valid doc)|$anchor array':    'anchor.array.valid',
      // "normal schema" baseline and "compilation" group are omitted —
      // they do not correspond to a scoreboard metric.
    },
  },
  {
    file: 'bench_unevaluated_mitata.mjs',
    metrics: {
      // ata bench is registered only when ataSupported === true at runtime.
      // If it is absent mitata simply never fires the bench and the trial
      // for alias "ata" will be missing; runBench skips missing entries.
      'baseline: additionalProperties:false (valid)':                    'unevaluated.baseline.valid',
      'Tier 1: unevaluatedProperties:false — properties only (valid)':   'unevaluated.tier1.valid',
      'Tier 1: unevaluatedProperties:false — properties only (invalid)': 'unevaluated.tier1.invalid',
      'Tier 2: allOf + unevaluatedProperties:false (valid)':             'unevaluated.tier2.valid',
      'Tier 2.5: if/then/else + unevaluatedProperties:false (valid)':    'unevaluated.tier25.valid',
      'Tier 3: anyOf + unevaluatedProperties:false (valid)':             'unevaluated.tier3.valid',
      'Tier 3: anyOf + unevaluatedProperties:false (invalid)':           'unevaluated.tier3.invalid',
      'unevaluatedItems: prefixItems (valid)':                           'unevaluated.items.valid',
      'unevaluatedItems: prefixItems (invalid — extra item)':            'unevaluated.items.invalid',
      'unevaluatedItems: allOf + prefixItems (valid)':                   'unevaluated.items2.valid',
      // "compilation: unevaluated schemas" is omitted — bench aliases are
      // "ajv tier1" / "ata tier1" / etc., not the standard "ata" alias,
      // and the group is not part of the perf gate.
    },
  },
  {
    file: 'bench_all_mitata.mjs',
    metrics: {
      'validate (valid)':                    'ecosystem.validate.valid',
      'validate (invalid)':                  'ecosystem.validate.invalid',
      'compilation':                         'ecosystem.compile',
      'first validation (compile + validate)': 'ecosystem.first',
    },
  },
  {
    file: 'bench_large_mitata.mjs',
    metrics: {
      // Groups are generated dynamically: "<N> users — JS object path".
      // We capture the JS-object path (direct in-memory validation) for the
      // three sizes that appear in the scoreboard gate. Bench alias is
      // "ata  validate(obj)" (two spaces — matches the source exactly).
      '10 users — JS object path|ata  validate(obj)':    'large.10users',
      '100 users — JS object path|ata  validate(obj)':   'large.100users',
      '1000 users — JS object path|ata  validate(obj)':  'large.1000users',
      // 50-user and 500-user sizes are not part of the perf gate; omitted.
      // JSON-string path groups are omitted; they duplicate the metric family.
    },
  },
  {
    file: 'bench_invalid_fair.mjs',
    metrics: {
      // Bench aliases here are "ata isValidObject" and "ata validate".
      // Use compound keys for all groups.
      'invalid document (boolean result)|ata isValidObject': 'realworld.invalid_fair',
      // Other groups omitted — not part of the scoreboard gate.
    },
  },
  // bench_ndjson_batch.js is handled separately via its own SCOREBOARD
  // instrumentation (it does not use mitata). See the note in that file.
]

// ---------------------------------------------------------------------------
// REALWORLD_SUBSET
// ---------------------------------------------------------------------------

export const REALWORLD_SUBSET = new Set([
  'realworld.invalid_fair',
  'realworld.ndjson_10k',
  'large.10users',
  'large.100users',
  'large.1000users',
])

// ---------------------------------------------------------------------------
// runBench
// ---------------------------------------------------------------------------

export async function runBench(filename) {
  if (!process.env.SCOREBOARD) {
    await run()       // normal mode: mitata prints its markdown table
    return
  }

  const result = await run({ print: () => {} })   // suppress markdown output

  const entry = REGISTRY.find(e => e.file === filename)
  if (!entry) {
    console.error(`SCOREBOARD: unknown bench file ${filename}`)
    process.exit(2)
  }

  const out = { file: filename, metrics: {} }

  for (const trial of result.benchmarks ?? []) {
    const groupLabel = result.layout[trial.group]?.name
    if (!groupLabel) continue

    // Try compound key first (group|alias), then plain group key (alias === 'ata').
    const compoundKey = `${groupLabel}|${trial.alias}`
    let metricId = entry.metrics[compoundKey]
    if (!metricId && trial.alias === 'ata') {
      metricId = entry.metrics[groupLabel]
    }
    if (!metricId) continue

    const ns = trial.runs?.[0]?.stats?.avg
    if (typeof ns !== 'number') continue

    out.metrics[metricId] = { ns }
  }

  console.log('SCOREBOARD_JSON:' + JSON.stringify(out))
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function median(xs) {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function iqr(xs) {
  if (xs.length < 4) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length / 4)]
  const q3 = sorted[Math.floor((sorted.length * 3) / 4)]
  return q3 - q1
}
