'use strict';
const { buildTier0Plan } = require("../lib/tier0");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

console.log("\ntier 0 plan emitter tests\n");

test("plan: constraint tuple shape for object", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
    required: ["id"],
  });
  assert(plan.isPrimitive === false);
  assert(plan.constraints.length === 2);
  assert(plan.requiredMask === 0b01, `expected 0b01, got ${plan.requiredMask.toString(2)}`);
  assert(plan.additionalAllowed === true, "additionalProperties default is true");
  assert(plan.constraints[0].key === "id");
  assert(plan.constraints[1].key === "name");
});

test("plan: additionalProperties false propagates", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { id: { type: "integer" } },
    additionalProperties: false,
  });
  assert(plan.additionalAllowed === false);
});

test("plan: no required -> requiredMask 0", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
  });
  assert(plan.requiredMask === 0);
});

test("plan: all required", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
    required: ["a", "b", "c"],
  });
  assert(plan.requiredMask === 0b111);
});

test("plan: enum builds Set", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { role: { type: "string", enum: ["admin", "user"] } },
  });
  const c = plan.constraints[0];
  assert(c.hasEnum === true);
  assert(c.enumSet.has("admin"));
  assert(c.enumSet.has("user"));
  assert(!c.enumSet.has("guest"));
});

test("plan: minimum/maximum numeric fields", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { age: { type: "integer", minimum: 0, maximum: 150 } },
  });
  const c = plan.constraints[0];
  assert(c.min === 0);
  assert(c.max === 150);
  // numFlags: F_MIN (1) | F_MAX (2) = 3; exclMin/exclMax/mult bits not set
  assert(c.numFlags === 3, `numFlags=${c.numFlags} expected 3`);
});

test("plan: const value", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { kind: { type: "string", const: "X" } },
  });
  const c = plan.constraints[0];
  assert(c.hasConst === true);
  assert(c.constVal === "X");
});

test("plan: top-level primitive marked isPrimitive", () => {
  const plan = buildTier0Plan({ type: "string", minLength: 1 });
  assert(plan.isPrimitive === true);
  assert(plan.constraints.length === 1);
  assert(plan.constraints[0].minLen === 1);
});

test("plan: knownKeys set populated", () => {
  const plan = buildTier0Plan({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
  });
  assert(plan.knownKeys instanceof Set);
  assert(plan.knownKeys.has("a"));
  assert(plan.knownKeys.has("b"));
  assert(plan.knownKeys.size === 2);
});

const { tier0Validate } = require("../lib/tier0");
const build = buildTier0Plan;

console.log("\ntier 0 validator tests\n");

test("validate: accepts valid object", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" }, name: { type: "string" } }, required: ["id"] });
  assert(tier0Validate(plan, { id: 1, name: "a" }) === true);
});

test("validate: rejects missing required", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
  assert(tier0Validate(plan, {}) === false);
});

test("validate: rejects wrong type", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
  assert(tier0Validate(plan, { id: "x" }) === false);
});

test("validate: rejects non-object", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" } } });
  assert(tier0Validate(plan, null) === false);
  assert(tier0Validate(plan, []) === false);
  assert(tier0Validate(plan, "x") === false);
  assert(tier0Validate(plan, 42) === false);
});

test("validate: enforces enum", () => {
  const plan = build({ type: "object", properties: { role: { type: "string", enum: ["a", "b"] } } });
  assert(tier0Validate(plan, { role: "a" }) === true);
  assert(tier0Validate(plan, { role: "c" }) === false);
});

test("validate: optional property absent is ok", () => {
  const plan = build({ type: "object", properties: { active: { type: "boolean" } } });
  assert(tier0Validate(plan, {}) === true);
});

test("validate: enforces min/max integer", () => {
  const plan = build({ type: "object", properties: { age: { type: "integer", minimum: 0, maximum: 150 } } });
  assert(tier0Validate(plan, { age: 0 }) === true);
  assert(tier0Validate(plan, { age: 150 }) === true);
  assert(tier0Validate(plan, { age: -1 }) === false);
  assert(tier0Validate(plan, { age: 151 }) === false);
  assert(tier0Validate(plan, { age: 30.5 }) === false);
});

test("validate: enforces min/max number", () => {
  const plan = build({ type: "object", properties: { score: { type: "number", minimum: 0, maximum: 100 } } });
  assert(tier0Validate(plan, { score: 0 }) === true);
  assert(tier0Validate(plan, { score: 99.5 }) === true);
  assert(tier0Validate(plan, { score: -0.1 }) === false);
});

test("validate: enforces string length", () => {
  const plan = build({ type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 5 } } });
  assert(tier0Validate(plan, { s: "ab" }) === true);
  assert(tier0Validate(plan, { s: "abcde" }) === true);
  assert(tier0Validate(plan, { s: "a" }) === false);
  assert(tier0Validate(plan, { s: "abcdef" }) === false);
});

test("validate: additionalProperties false rejects extras", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" } }, additionalProperties: false });
  assert(tier0Validate(plan, { id: 1 }) === true);
  assert(tier0Validate(plan, { id: 1, extra: "x" }) === false);
});

test("validate: additionalProperties default true accepts extras", () => {
  const plan = build({ type: "object", properties: { id: { type: "integer" } } });
  assert(tier0Validate(plan, { id: 1, extra: "x" }) === true);
});

test("validate: top-level primitive string", () => {
  const plan = build({ type: "string", minLength: 1 });
  assert(tier0Validate(plan, "a") === true);
  assert(tier0Validate(plan, "") === false);
  assert(tier0Validate(plan, 1) === false);
  assert(tier0Validate(plan, null) === false);
});

test("validate: top-level primitive integer with range", () => {
  const plan = build({ type: "integer", minimum: 0, maximum: 10 });
  assert(tier0Validate(plan, 5) === true);
  assert(tier0Validate(plan, -1) === false);
  assert(tier0Validate(plan, 11) === false);
});

test("validate: const enforcement", () => {
  const plan = build({ type: "object", properties: { kind: { type: "string", const: "fixed" } } });
  assert(tier0Validate(plan, { kind: "fixed" }) === true);
  assert(tier0Validate(plan, { kind: "other" }) === false);
});

test("validate: exclusiveMinimum", () => {
  const plan = build({ type: "object", properties: { n: { type: "number", exclusiveMinimum: 0 } } });
  assert(tier0Validate(plan, { n: 0.1 }) === true);
  assert(tier0Validate(plan, { n: 0 }) === false);
  assert(tier0Validate(plan, { n: -1 }) === false);
});

test("validate: boolean type", () => {
  const plan = build({ type: "object", properties: { b: { type: "boolean" } } });
  assert(tier0Validate(plan, { b: true }) === true);
  assert(tier0Validate(plan, { b: false }) === true);
  assert(tier0Validate(plan, { b: 0 }) === false);
  assert(tier0Validate(plan, { b: "true" }) === false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
