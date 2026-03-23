const { Validator } = require("../index");
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

const ataValidator = new Validator(schema);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);

console.log("\n==========================================================");
console.log("  ata vs ajv — Real-world Benchmark");
console.log("  The honest comparison: JSON string → validation result");
console.log("==========================================================\n");

// ============================================================
// 1. The real comparison: JSON string in, boolean out
// ============================================================
console.log("1. JSON string → validate (the real pipeline):\n");

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

// ============================================================
// 2. Fast boolean check (no error details)
// ============================================================
console.log("\n2. Fast boolean check — isValidJSON (ata) vs JSON.parse + validate (ajv):\n");

const ataFastValid = bench("   ata  isValidJSON(str)", () => {
  ataValidator.isValidJSON(validJsonStr);
});
const ajvFastValid = bench("   ajv  JSON.parse(str) + validate(obj)", () => {
  ajvValidate(JSON.parse(validJsonStr));
});

// ============================================================
// 3. JS object validation (ajv's home turf)
// ============================================================
console.log("\n3. JS object → validate (ajv's home turf):\n");

bench("   ata  validate(jsObject)", () => {
  ataValidator.validate(validDoc);
});
bench("   ajv  validate(jsObject)", () => {
  ajvValidate(validDoc);
});

// ============================================================
// 4. Schema compilation
// ============================================================
console.log("\n4. Schema compilation:\n");

const ataCompile = bench("   ata  compile", () => {
  new Validator(schema);
});
const ajvCompile = bench("   ajv  compile", () => {
  const a = new Ajv({ allErrors: true });
  addFormats(a);
  a.compile(schema);
});

// ============================================================
// Summary
// ============================================================
console.log("\n==========================================================");
console.log("  Summary — JSON string → validate (the real comparison)");
console.log("==========================================================");

function ratio(a, b, aName, bName) {
  const r = a / b;
  if (r >= 1) return `  ${aName} is ${r.toFixed(1)}x FASTER`;
  return `  ${bName} is ${(1/r).toFixed(1)}x faster`;
}

console.log(`\n  Valid doc:     ata ${Math.round(ataJsonValid).toLocaleString()} vs ajv ${Math.round(ajvJsonValid).toLocaleString()} ops/sec`);
console.log(ratio(ataJsonValid, ajvJsonValid, "ata", "ajv"));

console.log(`\n  Invalid doc:   ata ${Math.round(ataJsonInvalid).toLocaleString()} vs ajv ${Math.round(ajvJsonInvalid).toLocaleString()} ops/sec`);
console.log(ratio(ataJsonInvalid, ajvJsonInvalid, "ata", "ajv"));

console.log(`\n  isValidJSON:   ata ${Math.round(ataFastValid).toLocaleString()} vs ajv ${Math.round(ajvFastValid).toLocaleString()} ops/sec`);
console.log(ratio(ataFastValid, ajvFastValid, "ata", "ajv"));

console.log(`\n  Compilation:   ata ${Math.round(ataCompile).toLocaleString()} vs ajv ${Math.round(ajvCompile).toLocaleString()} ops/sec`);
console.log(ratio(ataCompile, ajvCompile, "ata", "ajv"));

console.log();
