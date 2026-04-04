// Browser compatibility tests — verifies ata works without native addon.
// Simulates browser environment by stubbing node-gyp-build before require.

const Module = require("module");

// Intercept node-gyp-build to simulate browser "browser" field stubbing
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "node-gyp-build") {
    // Return a module that throws when called, same as bundler stub
    return require.resolve("./browser_stub");
  }
  return origResolve.call(this, request, parent, isMain, options);
};

// Clear cached index.js so it re-requires with our stub
delete require.cache[require.resolve("../index")];

const { Validator, validate, version, createPaddedBuffer, SIMDJSON_PADDING } = require("../index");

// Restore original resolve
Module._resolveFilename = origResolve;

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

console.log("\nBrowser Compatibility Tests (no native addon)\n");

// --- Core validation ---

test("validate: valid object", () => {
  const v = new Validator({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const result = v.validate({ name: "hello" });
  assert(result.valid === true, "expected valid");
  assert(result.errors.length === 0, "expected no errors");
});

test("validate: invalid object", () => {
  const v = new Validator({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const result = v.validate({});
  assert(result.valid === false, "expected invalid");
  assert(result.errors.length > 0, "expected errors");
});

test("isValidObject: boolean check", () => {
  const v = new Validator({
    type: "object",
    properties: { age: { type: "integer" } },
    required: ["age"],
  });
  assert(v.isValidObject({ age: 25 }) === true, "expected true");
  assert(v.isValidObject({}) === false, "expected false");
});

test("validateJSON: valid string", () => {
  const v = new Validator({
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  });
  const result = v.validateJSON('{"x":42}');
  assert(result.valid === true, "expected valid");
});

test("validateJSON: invalid string", () => {
  const v = new Validator({
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  });
  const result = v.validateJSON('{"x":"not a number"}');
  assert(result.valid === false, "expected invalid");
});

test("isValidJSON: boolean check", () => {
  const v = new Validator({
    type: "object",
    properties: { x: { type: "number" } },
  });
  assert(v.isValidJSON('{"x":1}') === true, "expected true");
  assert(v.isValidJSON("bad json") === false, "expected false for bad json");
});

// --- One-shot validate ---

test("validate() function: one-shot", () => {
  const result = validate(
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { a: "ok" }
  );
  assert(result.valid === true, "expected valid");
});

// --- Standard Schema V1 ---

test("~standard: valid input returns value", () => {
  const v = new Validator({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const result = v["~standard"].validate({ name: "test" });
  assert("value" in result, "expected value property");
  assert(!("issues" in result), "expected no issues");
});

test("~standard: invalid input returns issues", () => {
  const v = new Validator({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const result = v["~standard"].validate({});
  assert("issues" in result, "expected issues property");
  assert(result.issues.length > 0, "expected at least one issue");
  assert(typeof result.issues[0].message === "string", "expected message");
});

// --- Options (defaults, coerceTypes, removeAdditional) ---

test("defaults applied without native", () => {
  const v = new Validator({
    type: "object",
    properties: {
      name: { type: "string" },
      role: { type: "string", default: "user" },
    },
    required: ["name"],
  });
  const data = { name: "test" };
  v.validate(data);
  assert(data.role === "user", "expected default applied");
});

test("coerceTypes without native", () => {
  const v = new Validator(
    {
      type: "object",
      properties: { age: { type: "integer" } },
    },
    { coerceTypes: true }
  );
  const data = { age: "25" };
  v.validate(data);
  assert(data.age === 25, "expected string coerced to integer");
});

test("removeAdditional without native", () => {
  const v = new Validator(
    {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
    { removeAdditional: true }
  );
  const data = { name: "test", extra: "removed" };
  v.validate(data);
  assert(!("extra" in data), "expected extra property removed");
});

// --- Buffer APIs throw clear errors ---

test("isValid throws without native", () => {
  const v = new Validator({ type: "object" });
  let threw = false;
  try {
    v.isValid(Buffer.from("{}"));
  } catch (e) {
    threw = true;
    assert(e.message.includes("Native addon required"), "expected native error");
  }
  assert(threw, "expected isValid to throw");
});

test("countValid throws without native", () => {
  const v = new Validator({ type: "object" });
  let threw = false;
  try {
    v.countValid(Buffer.from("{}"));
  } catch (e) {
    threw = true;
  }
  assert(threw, "expected countValid to throw");
});

test("isValidParallel throws without native", () => {
  const v = new Validator({ type: "object" });
  let threw = false;
  try {
    v.isValidParallel(Buffer.from("{}"));
  } catch (e) {
    threw = true;
  }
  assert(threw, "expected isValidParallel to throw");
});

// --- version() fallback ---

test("version returns a string", () => {
  const v = version();
  assert(typeof v === "string", "expected string");
  assert(v.length > 0, "expected non-empty");
});

// --- SIMDJSON_PADDING export ---

test("SIMDJSON_PADDING is 64", () => {
  assert(SIMDJSON_PADDING === 64, "expected 64");
});

// --- Complex schema without native ---

test("complex nested schema validates correctly", () => {
  const v = new Validator({
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["name", "tags"],
      },
    },
    required: ["user"],
  });
  assert(
    v.validate({ user: { name: "a", tags: ["x"] } }).valid === true,
    "valid nested"
  );
  assert(
    v.validate({ user: { name: "", tags: ["x"] } }).valid === false,
    "invalid name"
  );
  assert(v.validate({}).valid === false, "missing user");
});

// --- Schema reuse ---

test("schema reuse across multiple validations", () => {
  const v = new Validator({
    type: "object",
    properties: { x: { type: "integer" } },
    required: ["x"],
  });
  for (let i = 0; i < 100; i++) {
    assert(v.validate({ x: i }).valid === true, `iteration ${i}`);
  }
  assert(v.validate({}).valid === false, "missing x");
});

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) process.exit(1);
