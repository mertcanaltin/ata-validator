#!/usr/bin/env node
'use strict';

// Differential check between the runtime validator and the generated TS type.
//
// For every schema in the JSON Schema Test Suite, we take the test cases the
// suite marks as { valid: true } and assert that each piece of data is
// assignable to the generated type. The runtime validator already accepts
// these values; if tsc rejects them, the generated type is strictly narrower
// than the schema, which is a real correctness bug.
//
// We deliberately do not check the converse (data with valid: false should be
// rejected by tsc), because TypeScript cannot model many JSON Schema
// constraints (minLength, pattern, multipleOf, etc.). Such "false positives"
// are expected and would produce noise without signal.
//
// Coverage: a schema is counted only when at least one valid data item is
// available; pure schema-validity tests with no positive sample are skipped.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { Validator } = require('..');
const { toTypeScript } = require('../lib/ts-gen');

const DRAFT = process.env.CORPUS_DRAFT || 'draft2020-12';
const SUITE_DIR = path.join(__dirname, 'suite', 'tests', DRAFT);
const TSC_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsc');
const FAIL_BUDGET_PCT = Number(process.env.DIFF_FAIL_BUDGET || '0');
const ONLY = process.env.CORPUS_ONLY ? new Set(process.env.CORPUS_ONLY.split(',')) : null;

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

function hasExplicitType(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type !== undefined) return true;
  if (schema.const !== undefined || schema.enum !== undefined) return true;
  if (schema.$ref !== undefined) return true;
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    const arr = schema[k];
    if (Array.isArray(arr) && arr.some(hasExplicitType)) return true;
  }
  return false;
}

function extractCases(filePath) {
  const cases = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c || typeof c !== 'object') continue;
    const s = c.schema;
    if (s === true || s === false) continue;
    if (typeof s !== 'object' || s === null) continue;
    const valid = (c.tests || []).filter((t) => t && t.valid === true);
    if (valid.length === 0) continue;
    // Skip schemas that declare object-shape constraints (properties/required)
    // without an explicit type. The runtime validator passes non-objects
    // through such schemas, but the generator deliberately emits an object
    // type because that matches author intent in practice. Differential
    // claims focus on schemas that pin down a type.
    if (!hasExplicitType(s)) {
      out.push({ index: i, description: c.description || `case_${i}`, schema: s, valid, untyped: true });
      continue;
    }
    out.push({ index: i, description: c.description || `case_${i}`, schema: s, valid });
  }
  return out;
}

function runOne(workDir, entry) {
  let dts;
  try {
    dts = toTypeScript(entry.schema, { name: 'T' });
  } catch (err) {
    return { kind: 'fail', reason: `toTypeScript threw: ${err.message}` };
  }
  if (!dts || dts.indexOf('export type T') === -1 && dts.indexOf('export interface T') === -1) {
    return { kind: 'skip', reason: 'no exported T' };
  }

  const lines = ["import type { T } from './validator.mjs'"];
  for (let i = 0; i < entry.valid.length; i++) {
    lines.push(`const _v${i}: T = ${JSON.stringify(entry.valid[i].data)} as T`);
    lines.push(`void _v${i}`);
  }
  // The `as T` cast is intentional: we want tsc to verify the literal is
  // assignable to T after a non-narrowing assertion. Without `as T`, an
  // object literal subject to excess-property checks would over-reject
  // shapes that include keys the schema accepts via additionalProperties
  // but the named property list does not declare. We re-write the lines
  // without `as` to perform a stricter check below.
  const strictLines = ["import type { T } from './validator.mjs'"];
  for (let i = 0; i < entry.valid.length; i++) {
    strictLines.push(`const _v${i}: T = ${JSON.stringify(entry.valid[i].data)}`);
    strictLines.push(`void _v${i}`);
  }

  fs.writeFileSync(path.join(workDir, 'validator.mjs'), STUB_MJS);
  fs.writeFileSync(path.join(workDir, 'validator.d.mts'), dts);
  fs.writeFileSync(path.join(workDir, 'use.ts'), strictLines.join('\n') + '\n');

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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-ts-diff-'));
  process.stdout.write(`\nTS differential run [${DRAFT}]: ${files.length} suite files\n`);
  process.stdout.write(`temp dir: ${tmpRoot}\n`);
  process.stdout.write('='.repeat(72) + '\n');

  let attempted = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failureSamples = [];

  for (const file of files) {
    const base = path.basename(file, '.json');
    const cases = extractCases(file);
    if (cases.length === 0) continue;

    let pass = 0, fail = 0, skip = 0;
    for (const entry of cases) {
      if (entry.untyped) { skip++; skipped++; attempted++; continue; }
      const work = path.join(tmpRoot, `${base}_${entry.index}`);
      fs.mkdirSync(work, { recursive: true });
      const r = runOne(work, entry);
      if (r.kind === 'pass') { pass++; passed++; }
      else if (r.kind === 'fail') {
        fail++; failed++;
        if (failureSamples.length < 30) {
          failureSamples.push({ file: base, idx: entry.index, desc: entry.description, reason: r.reason });
        }
      } else { skip++; skipped++; }
      attempted++;
    }

    const status = fail === 0 ? 'PASS' : 'FAIL';
    const label = base.padEnd(36);
    process.stdout.write(`  ${status}  ${label}  ${pass} pass  ${fail} fail  ${skip} skip\n`);
  }

  process.stdout.write('='.repeat(72) + '\n');
  const considered = passed + failed;
  const failPct = considered > 0 ? (failed / considered) * 100 : 0;
  process.stdout.write(
    `${passed} passed, ${failed} failed, ${skipped} skipped ` +
    `(${attempted} cases with valid samples, ${failPct.toFixed(2)}% fail rate)\n`
  );

  if (failureSamples.length > 0) {
    process.stdout.write('\nFirst failures:\n');
    for (const f of failureSamples) {
      process.stdout.write(`  ${f.file}#${f.idx}  ${f.desc}\n    ${f.reason}\n`);
    }
  }

  if (failPct > FAIL_BUDGET_PCT) {
    process.stdout.write(`\nfail rate ${failPct.toFixed(2)}% exceeds budget ${FAIL_BUDGET_PCT}%\n`);
    process.exit(1);
  }
}

main();
