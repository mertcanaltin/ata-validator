const { Validator } = require("../index");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
  },
  required: ["id", "name"],
};

console.log("\nLazy Compilation Tests\n");

// --- Core lazy behavior ---

test("constructor does not eagerly compile (_initialized is false)", () => {
  const v = new Validator(schema);
  assert(v._initialized === false, "_initialized should be false after constructor");
});

test("constructor does not eagerly compile native (_nativeReady is false)", () => {
  const v = new Validator(schema);
  assert(v._nativeReady === false, "_nativeReady should be false after constructor");
});

test("validate() triggers compilation and returns correct result", () => {
  const v = new Validator(schema);
  const result = v.validate({ id: 1, name: "test" });
  assert(result.valid === true, "valid doc should pass");
  assert(v._initialized === true, "_initialized should be true after validate");
});

test("validate() returns errors for invalid data", () => {
  const v = new Validator(schema);
  const result = v.validate({ id: -1, name: "" });
  assert(result.valid === false, "invalid doc should fail");
});

test("isValidObject() triggers compilation", () => {
  const v = new Validator(schema);
  const result = v.isValidObject({ id: 1, name: "test" });
  assert(result === true, "valid doc should return true");
  assert(v._jsFn !== null, "codegen should be compiled after isValidObject");
});

test("validateJSON() triggers compilation", () => {
  const v = new Validator(schema);
  const json = JSON.stringify({ id: 1, name: "test" });
  const result = v.validateJSON(json);
  assert(result.valid === true, "valid JSON should pass");
  assert(v._initialized === true, "_initialized should be true after validateJSON");
});

test("isValidJSON() triggers compilation", () => {
  const v = new Validator(schema);
  const json = JSON.stringify({ id: 1, name: "test" });
  const result = v.isValidJSON(json);
  assert(result === true, "valid JSON should return true");
  assert(v._initialized === true, "_initialized should be true after isValidJSON");
});

// --- Multiple calls: second call uses compiled function ---

test("second validate() call works correctly (stub replaced)", () => {
  const v = new Validator(schema);
  v.validate({ id: 1, name: "a" });
  const result = v.validate({ id: 2, name: "b" });
  assert(result.valid === true, "second call should also work");
});

// --- toStandalone() triggers compilation ---

test("toStandalone() works without calling validate() first", () => {
  const v = new Validator(schema);
  const standalone = v.toStandalone();
  assert(typeof standalone === "string", "toStandalone should return string");
  assert(standalone.includes("boolFn"), "should contain boolFn");
  assert(v._initialized === true, "_initialized should be true after toStandalone");
});

// --- Native methods trigger _ensureNative ---

test("isValid() triggers native compilation", () => {
  const v = new Validator(schema);
  const buf = Buffer.from(JSON.stringify({ id: 1, name: "test" }));
  const result = v.isValid(buf);
  assert(typeof result === "boolean", "isValid should return boolean");
  assert(v._nativeReady === true, "_nativeReady should be true after isValid");
});

// --- Standard Schema interface works with lazy ---

test("~standard validate works with lazy compilation", () => {
  const v = new Validator(schema);
  const std = v["~standard"];
  const result = std.validate({ id: 1, name: "test" });
  assert(result.value !== undefined, "valid should return { value }");
  assert(v._initialized === true, "_initialized should be true");
});

// --- Options preserved through lazy compilation ---

test("coerceTypes option works with lazy compilation", () => {
  const s = {
    type: "object",
    properties: { age: { type: "integer" } },
  };
  const v = new Validator(s, { coerceTypes: true });
  const data = { age: "42" };
  v.validate(data);
  assert(data.age === 42, "age should be coerced to integer");
});

test("defaults are applied with lazy compilation", () => {
  const s = {
    type: "object",
    properties: {
      name: { type: "string", default: "unknown" },
    },
  };
  const v = new Validator(s);
  const data = {};
  v.validate(data);
  assert(data.name === "unknown", "default should be applied");
});

// --- Constructor speed test ---

test("constructor is fast (no compilation)", () => {
  const start = performance.now();
  const N = 10000;
  for (let i = 0; i < N; i++) {
    new Validator(schema);
  }
  const elapsed = performance.now() - start;
  const perSchema = (elapsed / N) * 1000; // microseconds
  console.log(`    constructor time: ${perSchema.toFixed(2)} us/schema`);
  // Should be well under 10us per schema (just JSON.parse + store)
  assert(perSchema < 50, `constructor too slow: ${perSchema.toFixed(2)} us`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
