const { Validator } = require("../index");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
let Blaze, blazeTemplate;
try {
  Blaze = require("@sourcemeta/blaze").Blaze;
  blazeTemplate = require("./blaze_template.json");
} catch {}


// Generate a larger, more realistic schema and data
const schema = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1 },
          email: { type: "string", format: "email" },
          age: { type: "integer", minimum: 0, maximum: 150 },
          active: { type: "boolean" },
          role: { enum: ["admin", "user", "moderator"] },
          scores: {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 100 },
            minItems: 1,
          },
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              zip: { type: "string" },
            },
            required: ["street", "city", "country"],
          },
        },
        required: ["id", "name", "email", "active", "role"],
      },
    },
    metadata: {
      type: "object",
      properties: {
        total: { type: "integer" },
        page: { type: "integer", minimum: 1 },
        perPage: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["total", "page", "perPage"],
    },
  },
  required: ["users", "metadata"],
};

function makeData(userCount) {
  const users = [];
  for (let i = 0; i < userCount; i++) {
    users.push({
      id: i + 1,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      age: 20 + (i % 50),
      active: i % 3 !== 0,
      role: ["admin", "user", "moderator"][i % 3],
      scores: [85, 92, 78, 95, 88],
      address: {
        street: `${100 + i} Main St`,
        city: "Istanbul",
        country: "Turkey",
        zip: "34000",
      },
    });
  }
  return { users, metadata: { total: userCount, page: 1, perPage: Math.min(userCount, 100) } };
}

function bench(label, iterations, fn) {
  for (let i = 0; i < 100; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = iterations / (elapsed / 1000);
  console.log(
    `  ${label.padEnd(50)} ${Math.round(opsPerSec).toString().padStart(10)} ops/sec`
  );
  return opsPerSec;
}

function compare(label, results) {
  const best = results.reduce((a, b) => a.ops > b.ops ? a : b);
  for (const r of results) {
    if (r === best) continue;
    const ratio = best.ops / r.ops;
    console.log(`  >>> ${best.name} ${ratio.toFixed(2)}x faster than ${r.name}`);
  }
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);
const ataValidator = new Validator(schema);

let blazeValidate;
if (Blaze && blazeTemplate) {
  const evaluator = new Blaze(blazeTemplate);
  blazeValidate = (data) => evaluator.validate(data);
}

const runners = [
  { name: "ata", validateObj: (d) => ataValidator.validate(d), validateJSON: (s) => ataValidator.validateJSON(s) },
  { name: "ajv", validateObj: (d) => ajvValidate(d), validateJSON: (s) => ajvValidate(JSON.parse(s)) },
];
if (blazeValidate) {
  runners.push({ name: "blaze", validateObj: (d) => blazeValidate(d), validateJSON: (s) => blazeValidate(JSON.parse(s)) });
}

console.log("==========================================================");
console.log("  ata vs ajv" + (blazeValidate ? " vs blaze" : "") + " — Benchmark");
console.log("  Both directions: JSON string and JS object pipelines");
console.log("==========================================================");

for (const count of [10, 50, 100, 500, 1000]) {
  const data = makeData(count);
  const jsonStr = JSON.stringify(data);

  console.log(`\n--- ${count} users (${(jsonStr.length / 1024).toFixed(1)} KB JSON) ---`);

  const N = count >= 500 ? 1000 : count >= 100 ? 5000 : count >= 50 ? 10000 : 20000;

  console.log("\n  [A] JSON string -> validation result:");
  const jsonResults = [];
  for (const r of runners) {
    const ops = bench(`${r.name.padEnd(6)} validateJSON(str)`, N, () => r.validateJSON(jsonStr));
    jsonResults.push({ name: r.name, ops });
  }
  compare("JSON", jsonResults);

  console.log("\n  [B] JS object -> validation result:");
  const objResults = [];
  for (const r of runners) {
    const ops = bench(`${r.name.padEnd(6)} validate(obj)`, N, () => r.validateObj(data));
    objResults.push({ name: r.name, ops });
  }
  compare("Object", objResults);
}
console.log();
