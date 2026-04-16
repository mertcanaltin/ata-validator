// First-call cold start benchmark: measures the TRUE one-shot cost where nothing
// is cached yet. Relevant to serverless cold starts, CLI tools, config parsing.
// Each iteration runs in a fresh Node.js process to avoid any JIT/cache carryover.
//
// Run: node bench_first_call.mjs
// Output: median/p95/p99 over N fresh-process runs.

import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

const schemas = {
  S1: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      active: { type: "boolean" },
    },
    required: ["id", "name"],
  },
  S2: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 100 },
      email: { type: "string" },
      age: { type: "integer", minimum: 0, maximum: 150 },
      role: { type: "string", enum: ["admin", "user", "guest"] },
      active: { type: "boolean" },
      score: { type: "number", minimum: 0, maximum: 100 },
      tag: { type: "string", maxLength: 20 },
      createdAt: { type: "string" },
      flags: { type: "string" },
    },
    required: ["id", "name", "email"],
  },
};
const payloads = {
  S1: { id: 1, name: "alice", active: true },
  S2: { id: 1, name: "alice", email: "a@b.com", age: 30, role: "user", active: true, score: 95.5, tag: "t1", createdAt: "2026-04-16", flags: "x" },
};

function runChild(scriptPath) {
  const r = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  const out = r.stdout.trim();
  const ns = parseInt(out, 10);
  return ns;
}

function measure(label, script, runs = 50) {
  const tmp = `/tmp/ata_bench_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(tmp, script);
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(runChild(tmp));
  unlinkSync(tmp);
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(runs * 0.5)];
  const p95 = samples[Math.floor(runs * 0.95)];
  const p99 = samples[Math.floor(runs * 0.99)];
  console.log(`${label.padEnd(50)}  p50=${(p50/1000).toFixed(1).padStart(8)} µs  p95=${(p95/1000).toFixed(1).padStart(8)} µs  p99=${(p99/1000).toFixed(1).padStart(8)} µs`);
  return { p50, p95, p99 };
}

const cwd = process.cwd();

for (const [name, schema] of Object.entries(schemas)) {
  const data = payloads[name];
  const schemaJson = JSON.stringify(schema);
  const dataJson = JSON.stringify(data);

  measure(`${name}: ata new Validator + isValidObject`,
`import {Validator} from "${cwd}/../index.js";
const schema = ${schemaJson};
const data = ${dataJson};
const t0 = process.hrtime.bigint();
const v = new Validator(schema);
const r = v.isValidObject(data);
const ns = Number(process.hrtime.bigint() - t0);
if (!r) process.stderr.write("unexpected invalid\\n");
console.log(ns);`);

  measure(`${name}: ajv compile + validate`,
`import {createRequire} from "module";
const require = createRequire(import.meta.url);
const Ajv = require("${cwd}/node_modules/ajv");
const schema = ${schemaJson};
const data = ${dataJson};
const t0 = process.hrtime.bigint();
const ajv = new Ajv();
const v = ajv.compile(schema);
const r = v(data);
const ns = Number(process.hrtime.bigint() - t0);
if (!r) process.stderr.write("unexpected invalid\\n");
console.log(ns);`);

  console.log();
}
