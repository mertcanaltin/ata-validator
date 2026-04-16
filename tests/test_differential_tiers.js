'use strict';
// Differential: Tier 0 boolean result must match codegen boolean result for every case.

const { Validator } = require("../index");
const { classify } = require("../lib/shape-classifier");
const { buildTier0Plan, tier0Validate } = require("../lib/tier0");

let total = 0;
const divergences = [];

function diff(label, schema, cases) {
  const c = classify(schema);
  if (c.tier !== 0) {
    console.log(`  SKIP  ${label} (tier ${c.tier}, not tier 0)`);
    return;
  }
  const plan = buildTier0Plan(schema);
  // Force codegen path by creating a Validator, then triggering compile
  const cg = new Validator(JSON.parse(JSON.stringify(schema))); // fresh schema to bypass identity cache
  cg._ensureCompiled();
  const cgFn = cg._jsFn;
  if (!cgFn) {
    console.log(`  FAIL  ${label}: codegen _jsFn not produced`);
    return;
  }
  let pass = 0, divergent = 0;
  for (const data of cases) {
    total++;
    const t0 = tier0Validate(plan, data);
    const cgR = cgFn(data);
    if (t0 !== cgR) {
      divergent++;
      divergences.push({ label, schema, data, tier0: t0, codegen: cgR });
    } else {
      pass++;
    }
  }
  console.log(`  ${divergent === 0 ? "PASS" : "FAIL"}  ${label}: ${pass}/${cases.length} match`);
}

console.log("\ntier 0 vs codegen differential\n");

diff("simple-required", {
  type: "object",
  properties: { id: { type: "integer" }, name: { type: "string" } },
  required: ["id"],
}, [
  { id: 1, name: "a" },
  { id: 1 },
  { id: "x" },
  null,
  [],
  { name: "a" },
  { id: 1, extra: "x" },
  {},
  "string",
  42,
]);

diff("enum-prop", {
  type: "object",
  properties: { role: { type: "string", enum: ["admin", "user"] } },
}, [
  { role: "admin" },
  { role: "user" },
  { role: "guest" },
  {},
  { role: 1 },
  { role: null },
]);

diff("numeric-range", {
  type: "object",
  properties: { age: { type: "integer", minimum: 0, maximum: 150 } },
}, [
  { age: 0 },
  { age: 150 },
  { age: -1 },
  { age: 151 },
  { age: 30.5 },
  { age: "30" },
  { age: null },
  {},
]);

diff("string-length", {
  type: "object",
  properties: { s: { type: "string", minLength: 2, maxLength: 5 } },
}, [
  { s: "ab" },
  { s: "abcde" },
  { s: "a" },
  { s: "abcdef" },
  { s: "" },
  {},
  { s: 42 },
]);

diff("additional-false", {
  type: "object",
  properties: { id: { type: "integer" } },
  additionalProperties: false,
}, [
  { id: 1 },
  { id: 1, extra: "x" },
  {},
  { other: "x" },
  null,
]);

diff("top-level-string", {
  type: "string",
  minLength: 1,
}, [
  "a",
  "abc",
  "",
  1,
  null,
  [],
  {},
]);

diff("top-level-integer-range", {
  type: "integer",
  minimum: 0,
  maximum: 10,
}, [
  0,
  5,
  10,
  -1,
  11,
  5.5,
  "5",
  null,
]);

diff("boolean-prop", {
  type: "object",
  properties: { b: { type: "boolean" } },
}, [
  { b: true },
  { b: false },
  { b: 0 },
  { b: "true" },
  {},
]);

diff("const-prop", {
  type: "object",
  properties: { kind: { type: "string", const: "X" } },
}, [
  { kind: "X" },
  { kind: "Y" },
  { kind: null },
  {},
]);

diff("exclusive-bounds", {
  type: "object",
  properties: { n: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 100 } },
}, [
  { n: 1 },
  { n: 99.9 },
  { n: 0 },
  { n: 100 },
  { n: -1 },
  { n: 101 },
]);

console.log(`\ntotal: ${total} cases, ${divergences.length} divergences`);
if (divergences.length > 0) {
  console.log("\nDIVERGENCES:");
  for (const d of divergences) console.log("  " + JSON.stringify(d));
  process.exit(1);
}
process.exit(0);
