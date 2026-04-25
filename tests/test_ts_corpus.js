#!/usr/bin/env node
'use strict';

// Corpus-driven TS generator correctness check.
//
// Walks the JSON Schema Test Suite (Draft 2020-12) shipped under tests/suite,
// extracts every unique schema, runs the ata generator to emit validator.mjs
// and validator.d.mts, then invokes tsc on a synthesised use.ts that imports
// the type predicate and narrows an unknown value through it.
//
// A failure means either:
//   - generation threw on a schema the validator otherwise accepts, or
//   - tsc rejects the emitted .d.mts on a structurally valid use.
//
// Per-file PASS/FAIL counts are printed; the overall exit code is non-zero
// only when the failure rate exceeds CORPUS_TS_FAIL_BUDGET (default 0).
// Set the env var to a percentage to track regression while iterating.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { Validator } = require('..');
const { toTypeScript } = require('../lib/ts-gen');

const DRAFT = process.env.CORPUS_DRAFT || 'draft2020-12';
const SUITE_DIR = path.join(__dirname, 'suite', 'tests', DRAFT);
const TSC_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsc');
const FAIL_BUDGET_PCT = Number(process.env.CORPUS_TS_FAIL_BUDGET || '0');
const ONLY = process.env.CORPUS_ONLY ? new Set(process.env.CORPUS_ONLY.split(',')) : null;

const USE_TS = `import { isValid, type T } from './validator.mjs'
declare const x: unknown
if (isValid(x)) {
  const _typed: T = x
  void _typed
}
`;

// Minimal runtime shim used when the schema does not produce a standalone
// module (e.g. cross-document $ref). The TS generator output can still be
// type-checked against this surface; correctness of the runtime is covered
// by the existing validator suite.
const STUB_MJS = `export const isValid = () => false
export const validate = () => ({ valid: false, errors: [] })
export default { isValid, validate }
`;

function listSuiteFiles() {
  const files = [];
  for (const name of fs.readdirSync(SUITE_DIR)) {
    if (!name.endsWith('.json')) continue;
    if (ONLY && !ONLY.has(name)) continue;
    files.push(path.join(SUITE_DIR, name));
  }
  return files.sort();
}

function extractSchemas(filePath) {
  const cases = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const schemas = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c || typeof c !== 'object') continue;
    const s = c.schema;
    if (s === true || s === false) continue;
    if (typeof s !== 'object' || s === null) continue;
    schemas.push({ index: i, description: c.description || `case_${i}`, schema: s });
  }
  return schemas;
}

function runOne(workDir, schema) {
  let v;
  try {
    v = new Validator(schema);
  } catch (err) {
    return { kind: 'skip', reason: 'validator rejected schema' };
  }

  let modSrc;
  try {
    modSrc = v.toStandaloneModule({ format: 'esm' });
  } catch (err) {
    return { kind: 'fail', reason: `toStandaloneModule threw: ${err.message}` };
  }
  // If the validator declines to compile a standalone module, fall back to
  // a stub so the .d.mts can still be type-checked. The runtime correctness
  // for these schemas is exercised by the validator suite separately.
  if (!modSrc) modSrc = STUB_MJS;

  let dts;
  try {
    dts = toTypeScript(schema, { name: 'T' });
  } catch (err) {
    return { kind: 'fail', reason: `toTypeScript threw: ${err.message}` };
  }
  if (!dts || dts.indexOf('export') === -1) {
    return { kind: 'skip', reason: 'no exported TS type' };
  }

  fs.writeFileSync(path.join(workDir, 'validator.mjs'), modSrc);
  fs.writeFileSync(path.join(workDir, 'validator.d.mts'), dts);
  fs.writeFileSync(path.join(workDir, 'use.ts'), USE_TS);

  const result = spawnSync(TSC_BIN, [
    '--target', 'ES2022',
    '--module', 'ESNext',
    '--moduleResolution', 'bundler',
    '--strict',
    '--noEmit',
    '--lib', 'ES2022',
    path.join(workDir, 'use.ts'),
  ], { encoding: 'utf8' });

  if (result.status === 0) return { kind: 'pass' };
  return {
    kind: 'fail',
    reason: ((result.stdout || '') + (result.stderr || '')).trim().split('\n').slice(0, 4).join(' | '),
  };
}

function main() {
  const files = listSuiteFiles();
  if (files.length === 0) {
    process.stdout.write(`no suite files under ${SUITE_DIR}\n`);
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-ts-corpus-'));
  process.stdout.write(`\nTS generator corpus run [${DRAFT}]: ${files.length} suite files\n`);
  process.stdout.write(`temp dir: ${tmpRoot}\n`);
  process.stdout.write('='.repeat(72) + '\n');

  let totalAttempted = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const failureSamples = [];
  const skipReasons = new Map();

  for (const file of files) {
    const base = path.basename(file, '.json');
    const schemas = extractSchemas(file);
    if (schemas.length === 0) continue;

    let pass = 0, fail = 0, skip = 0;
    for (const entry of schemas) {
      const work = path.join(tmpRoot, `${base}_${entry.index}`);
      fs.mkdirSync(work, { recursive: true });
      const r = runOne(work, entry.schema);
      if (r.kind === 'pass') { pass++; totalPassed++; }
      else if (r.kind === 'fail') {
        fail++; totalFailed++;
        if (failureSamples.length < 30) {
          failureSamples.push({ file: base, idx: entry.index, desc: entry.description, reason: r.reason });
        }
      } else {
        skip++; totalSkipped++;
        skipReasons.set(r.reason, (skipReasons.get(r.reason) || 0) + 1);
      }
      totalAttempted++;
    }

    const status = fail === 0 ? 'PASS' : 'FAIL';
    const label = base.padEnd(36);
    process.stdout.write(`  ${status}  ${label}  ${pass} pass  ${fail} fail  ${skip} skip\n`);
  }

  process.stdout.write('='.repeat(72) + '\n');
  const considered = totalPassed + totalFailed;
  const failPct = considered > 0 ? (totalFailed / considered) * 100 : 0;
  process.stdout.write(
    `${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped ` +
    `(${totalAttempted} attempted, ${failPct.toFixed(2)}% fail rate among compilable)\n`
  );

  if (failureSamples.length > 0) {
    process.stdout.write('\nFirst failures:\n');
    for (const f of failureSamples) {
      process.stdout.write(`  ${f.file}#${f.idx}  ${f.desc}\n    ${f.reason}\n`);
    }
  }

  if (skipReasons.size > 0) {
    process.stdout.write('\nSkip categories:\n');
    const sorted = Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      process.stdout.write(`  ${String(count).padStart(4)}  ${reason}\n`);
    }
  }

  if (failPct > FAIL_BUDGET_PCT) {
    process.stdout.write(`\nfail rate ${failPct.toFixed(2)}% exceeds budget ${FAIL_BUDGET_PCT}%\n`);
    process.exit(1);
  }
}

main();
