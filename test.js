const { Validator, validate, version } = require("./index");

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

console.log(`\nata v${version()} - Node.js Binding Tests\n`);

// --- Validator class ---

test("Validator: valid document", () => {
  const v = new Validator({ type: "string" });
  const r = v.validate("hello");
  assert(r.valid, "should be valid");
});

test("Validator: invalid document", () => {
  const v = new Validator({ type: "string" });
  const r = v.validate(42);
  assert(!r.valid, "should be invalid");
  assert(r.errors.length > 0, "should have errors");
});

test("Validator: complex schema", () => {
  const v = new Validator({
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "integer", minimum: 0 },
    },
    required: ["name"],
  });

  const r1 = v.validate({ name: "Mert", age: 25 });
  assert(r1.valid, "valid doc should pass");

  const r2 = v.validate({ age: -1 });
  assert(!r2.valid, "missing required should fail");
});

test("Validator: accepts JS objects", () => {
  const v = new Validator({ type: "object" });
  const r = v.validate({ key: "value" });
  assert(r.valid, "should accept JS object");
});

// --- One-shot validate ---

test("validate(): one-shot valid", () => {
  const r = validate({ type: "number" }, 42);
  assert(r.valid);
});

test("validate(): one-shot invalid", () => {
  const r = validate({ type: "number" }, "hello");
  assert(!r.valid);
});

// --- Format validation ---

test("format: email", () => {
  const v = new Validator({ type: "string", format: "email" });
  assert(v.validate("user@example.com").valid);
  assert(!v.validate("not-email").valid);
});

test("format: date", () => {
  const v = new Validator({ type: "string", format: "date" });
  assert(v.validate("2026-03-21").valid);
  assert(!v.validate("nope").valid);
});

// --- Error details ---

test("error details include path and message", () => {
  const v = new Validator({
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  });
  const r = v.validate({ name: 123, age: "old" });
  assert(!r.valid);
  assert(r.errors.length >= 2, "should have at least 2 errors");
  assert(r.errors.some((e) => e.path.includes("name")));
  assert(r.errors.some((e) => e.path.includes("age")));
});

// --- Schema reuse ---

test("schema reuse across validations", () => {
  const v = new Validator({ type: "string", maxLength: 5 });
  assert(v.validate("hi").valid);
  assert(v.validate("hello").valid);
  assert(!v.validate("toolong").valid);
  assert(!v.validate(42).valid);
});

// --- V8 Fast API: isValid ---

test("isValid: valid buffer", () => {
  const v = new Validator({ type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
  assert(v.isValid(Buffer.from('{"id":1}')) === true, "should be valid");
});

test("isValid: invalid buffer", () => {
  const v = new Validator({ type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
  assert(v.isValid(Buffer.from('{"id":"not_int"}')) === false, "should be invalid");
});

test("isValid: string input", () => {
  const v = new Validator({ type: "string" });
  assert(v.isValid('"hello"') === true, "should accept string input");
  assert(v.isValid('42') === false, "should reject non-string");
});

test("isValid: empty object missing required", () => {
  const v = new Validator({ type: "object", required: ["name"] });
  assert(v.isValid(Buffer.from('{}')) === false, "should fail required");
});

test("isValid: invalid JSON", () => {
  const v = new Validator({ type: "object" });
  assert(v.isValid(Buffer.from('{bad json}')) === false, "should reject bad JSON");
});

test("isValid: complex schema", () => {
  const v = new Validator({
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      email: { type: "string", format: "email" },
    },
    required: ["name", "age"],
  });
  assert(v.isValid(Buffer.from('{"name":"Mert","age":26,"email":"m@e.com"}')) === true);
  assert(v.isValid(Buffer.from('{"name":"","age":26}')) === false, "minLength");
  assert(v.isValid(Buffer.from('{"name":"Mert","age":-1}')) === false, "minimum");
  assert(v.isValid(Buffer.from('{"name":"Mert"}')) === false, "required age");
});

test("isValid: Uint8Array input", () => {
  const v = new Validator({ type: "number" });
  const buf = Buffer.from("42");
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  assert(v.isValid(u8) === true, "should accept Uint8Array");
});

// --- V8 Fast API: countValid ---

test("countValid: NDJSON buffer", () => {
  const v = new Validator({ type: "object", required: ["id"] });
  const ndjson = Buffer.from('{"id":1}\n{"id":2}\n{"bad":true}\n');
  assert(v.countValid(ndjson) === 2, "should count 2 valid");
});

test("countValid: all valid", () => {
  const v = new Validator({ type: "number" });
  const ndjson = Buffer.from("1\n2\n3\n");
  assert(v.countValid(ndjson) === 3, "all 3 valid");
});

test("countValid: all invalid", () => {
  const v = new Validator({ type: "number" });
  const ndjson = Buffer.from('"a"\n"b"\n');
  assert(v.countValid(ndjson) === 0, "none valid");
});

test("countValid: empty buffer", () => {
  const v = new Validator({ type: "number" });
  assert(v.countValid(Buffer.alloc(0)) === 0, "empty = 0");
});

test("countValid: string input", () => {
  const v = new Validator({ type: "number" });
  assert(v.countValid("1\n2\n3\n") === 3, "should accept string");
});

// --- V8 Fast API: batchIsValid ---

test("batchIsValid: mixed buffers", () => {
  const v = new Validator({ type: "object", required: ["id"] });
  const bufs = [
    Buffer.from('{"id":1}'),
    Buffer.from('{"nope":true}'),
    Buffer.from('{"id":3}'),
  ];
  assert(v.batchIsValid(bufs) === 2, "2 of 3 valid");
});

test("batchIsValid: empty array", () => {
  const v = new Validator({ type: "number" });
  assert(v.batchIsValid([]) === 0, "empty = 0");
});

test("batchIsValid: single buffer", () => {
  const v = new Validator({ type: "string" });
  assert(v.batchIsValid([Buffer.from('"hello"')]) === 1, "1 valid");
});

test("batchIsValid: all invalid", () => {
  const v = new Validator({ type: "integer" });
  const bufs = [Buffer.from('"a"'), Buffer.from('"b"')];
  assert(v.batchIsValid(bufs) === 0, "none valid");
});

console.log(`\n${passed}/${passed + failed} tests passed.\n`);
process.exit(failed > 0 ? 1 : 0);
