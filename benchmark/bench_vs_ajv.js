const { Validator } = require("../index");
const native = require("node-gyp-build")(require("path").resolve(__dirname, ".."));
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
    tags: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      maxItems: 10,
    },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zip: { type: "string", pattern: "^[0-9]{5}$" },
      },
      required: ["street", "city"],
    },
  },
  required: ["id", "name", "email", "active"],
};

const validDoc = {
  id: 42,
  name: "Mert Can Altin",
  email: "mert@example.com",
  age: 26,
  active: true,
  tags: ["nodejs", "cpp", "performance"],
  address: { street: "123 Main St", city: "Istanbul", zip: "34000" },
};

const invalidDoc = {
  id: -1,
  name: "",
  email: "not-an-email",
  age: 200,
  active: "yes",
  tags: ["a", "a"],
  address: { zip: "abc" },
};

const validJsonStr = JSON.stringify(validDoc);
const invalidJsonStr = JSON.stringify(invalidDoc);

const N = 100000;

function bench(label, fn) {
  for (let i = 0; i < 1000; i++) fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < N; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = N / (elapsed / 1000);
  console.log(
    `  ${label.padEnd(50)} ${Math.round(opsPerSec).toString().padStart(10)} ops/sec  (${elapsed.toFixed(2)} ms)`
  );
  return opsPerSec;
}

function ratio(a, b, aName, bName) {
  const r = a / b;
  if (r >= 1) return `  ${aName} is ${r.toFixed(1)}x faster`;
  return `  ${bName} is ${(1/r).toFixed(1)}x faster`;
}

const ataValidator = new Validator(schema);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);

console.log("\n==========================================================");
console.log("  ata vs ajv — Apples-to-Apples Benchmark");
console.log("==========================================================\n");

// ============================================================
// 1. JS object -> validate (the common Node.js case)
// ============================================================
console.log("1. JS object -> validate (most common in Node.js apps):\n");

console.log("   Valid document:");
const ataObjValid = bench("   ata  validate(obj)", () => {
  ataValidator.validate(validDoc);
});
const ajvObjValid = bench("   ajv  validate(obj)", () => {
  ajvValidate(validDoc);
});

console.log("\n   Valid document (fast boolean):");
const ataObjFast = bench("   ata  isValidObject(obj)", () => {
  ataValidator.isValidObject(validDoc);
});
const ajvObjFast = bench("   ajv  validate(obj)", () => {
  ajvValidate(validDoc);
});

console.log("\n   Invalid document:");
const ataObjInvalid = bench("   ata  validate(obj)", () => {
  ataValidator.validate(invalidDoc);
});
const ajvObjInvalid = bench("   ajv  validate(obj)", () => {
  ajvValidate(invalidDoc);
});

// ============================================================
// 2. JSON string -> validate (data from network/disk/service)
// ============================================================
console.log("\n2. JSON string -> validate (data from network, disk, or another service):\n");

console.log("   Valid document:");
const ataJsonValid = bench("   ata  validateJSON(str)", () => {
  ataValidator.validateJSON(validJsonStr);
});
const ajvJsonValid = bench("   ajv  JSON.parse(str) + validate(obj)", () => {
  ajvValidate(JSON.parse(validJsonStr));
});

console.log("\n   Invalid document:");
const ataJsonInvalid = bench("   ata  validateJSON(str)", () => {
  ataValidator.validateJSON(invalidJsonStr);
});
const ajvJsonInvalid = bench("   ajv  JSON.parse(str) + validate(obj)", () => {
  ajvValidate(JSON.parse(invalidJsonStr));
});

console.log("\n   Fast boolean (valid):");
const ataFastValid = bench("   ata  isValidJSON(str)", () => {
  ataValidator.isValidJSON(validJsonStr);
});
const ajvFastJsonValid = bench("   ajv  JSON.parse(str) + validate(obj)", () => {
  ajvValidate(JSON.parse(validJsonStr));
});

// ============================================================
// 3. Schema compilation
// ============================================================
console.log("\n3. Schema compilation:\n");

const COMPILE_N = 1000;
function benchCompile(label, fn) {
  for (let i = 0; i < 10; i++) fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < COMPILE_N; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = COMPILE_N / (elapsed / 1000);
  console.log(
    `  ${label.padEnd(50)} ${Math.round(opsPerSec).toString().padStart(10)} ops/sec  (${elapsed.toFixed(2)} ms)`
  );
  return opsPerSec;
}

const ataCompile = benchCompile("   ata  native.CompiledSchema(str)", () => {
  new native.CompiledSchema(JSON.stringify(schema));
});
const ajvCompile = benchCompile("   ajv  compile", () => {
  const a = new Ajv({ allErrors: true });
  addFormats(a);
  a.compile(schema);
});

// ============================================================
// Summary
// ============================================================
console.log("\n==========================================================");
console.log("  Summary");
console.log("==========================================================");

console.log("\n  JS object (the common case):");
console.log(`    validate(obj) valid:    ata ${Math.round(ataObjValid).toLocaleString()} vs ajv ${Math.round(ajvObjValid).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataObjValid, ajvObjValid, "ata", "ajv"));
console.log(`    isValidObject(obj):     ata ${Math.round(ataObjFast).toLocaleString()} vs ajv ${Math.round(ajvObjFast).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataObjFast, ajvObjFast, "ata", "ajv"));
console.log(`    validate(obj) invalid:  ata ${Math.round(ataObjInvalid).toLocaleString()} vs ajv ${Math.round(ajvObjInvalid).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataObjInvalid, ajvObjInvalid, "ata", "ajv"));

console.log("\n  JSON string (network/disk):");
console.log(`    validateJSON valid:     ata ${Math.round(ataJsonValid).toLocaleString()} vs ajv ${Math.round(ajvJsonValid).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataJsonValid, ajvJsonValid, "ata", "ajv"));
console.log(`    validateJSON invalid:   ata ${Math.round(ataJsonInvalid).toLocaleString()} vs ajv ${Math.round(ajvJsonInvalid).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataJsonInvalid, ajvJsonInvalid, "ata", "ajv"));
console.log(`    isValidJSON:            ata ${Math.round(ataFastValid).toLocaleString()} vs ajv ${Math.round(ajvFastJsonValid).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataFastValid, ajvFastJsonValid, "ata", "ajv"));

console.log(`\n  Compilation:              ata ${Math.round(ataCompile).toLocaleString()} vs ajv ${Math.round(ajvCompile).toLocaleString()} ops/sec`);
console.log("  " + ratio(ataCompile, ajvCompile, "ata", "ajv"));

console.log();
