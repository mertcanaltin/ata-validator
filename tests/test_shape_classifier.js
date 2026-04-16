'use strict';
const { classify } = require("../lib/shape-classifier");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

console.log("\nshape-classifier tier 0 accept tests\n");

test("simple object -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
    required: ["id"],
  });
  assert(r.tier === 0, `expected tier 0, got ${r.tier}`);
});

test("object with enum -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { role: { type: "string", enum: ["a", "b"] } },
  });
  assert(r.tier === 0);
});

test("object with numeric ranges -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { age: { type: "integer", minimum: 0, maximum: 150 } },
  });
  assert(r.tier === 0);
});

test("object with string length -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
  });
  assert(r.tier === 0);
});

test("object with additionalProperties false -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { id: { type: "integer" } },
    additionalProperties: false,
  });
  assert(r.tier === 0);
});

test("object with const -> tier 0", () => {
  const r = classify({
    type: "object",
    properties: { kind: { type: "string", const: "fixed" } },
  });
  assert(r.tier === 0);
});

test("top-level primitive string -> tier 0", () => {
  assert(classify({ type: "string" }).tier === 0);
  assert(classify({ type: "string", minLength: 1 }).tier === 0);
});

test("top-level primitive integer -> tier 0", () => {
  assert(classify({ type: "integer", minimum: 0 }).tier === 0);
});

test("top-level primitive boolean -> tier 0", () => {
  assert(classify({ type: "boolean" }).tier === 0);
});

test("empty-properties object stays tier 0", () => {
  const r = classify({ type: "object", properties: {} });
  assert(r.tier === 0);
});

test("10-property object (upper bound) -> tier 0", () => {
  const props = {};
  for (let i = 0; i < 10; i++) props[`p${i}`] = { type: "string" };
  assert(classify({ type: "object", properties: props }).tier === 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
