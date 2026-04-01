// Game-changing multiplier scenarios — ata vs AJV
// These are real-world scenarios where the difference is 100x-10000x

import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const Ajv = require("../benchmark/node_modules/ajv/dist/2020");

// ─── Schemas ───
const simpleSchema = {
  type: "object",
  properties: { id: { type: "integer" }, name: { type: "string" }, email: { type: "string" } },
  required: ["id", "name", "email"],
  unevaluatedProperties: false,
};

const nestedSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    users: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" }, age: { type: "integer" } },
        required: ["name", "email", "age"],
        unevaluatedProperties: false,
      },
    },
  },
  required: ["id", "users"],
  unevaluatedProperties: false,
};

// ─── Data ───
const simpleValid = { id: 1, name: "Mert", email: "m@e.com" };

// 10000-item array, all items have extra property
const largeInvalid = [];
for (let i = 0; i < 10000; i++) largeInvalid.push({ id: i, name: "u" + i, email: "e@e", extra: "bad" });

// 100-user nested payload
const nestedPayload = { id: 1, users: [] };
for (let i = 0; i < 100; i++) nestedPayload.users.push({ name: "u" + i, email: "e" + i + "@x.com", age: 20 + i });
const nestedJSON = JSON.stringify(nestedPayload);

// ─── Pre-compiled validators ───
const ataSimple = new Validator(simpleSchema);
const ajvSimple = new Ajv({ strict: false });
const ajvSimpleFn = ajvSimple.compile(simpleSchema);

const arraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" }, email: { type: "string" } },
    required: ["id", "name", "email"],
    unevaluatedProperties: false,
  },
};
const ataArray = new Validator(arraySchema);
const ajvArrayAll = new Ajv({ strict: false, allErrors: true }).compile(arraySchema);
const ajvArrayFirst = new Ajv({ strict: false, allErrors: false }).compile(arraySchema);

// ─── Correctness ───
console.log("=== Correctness ===");
console.log("simple valid:", ataSimple.isValidObject(simpleValid), ajvSimpleFn(simpleValid));
console.log("large invalid:", ataArray.isValidObject(largeInvalid), ajvArrayAll(largeInvalid));
console.log();

summary(() => {
  // 1. Cold start: compile + validate (serverless, lambda, API gateway)
  group("cold start: compile + first validate", () => {
    bench("ata", () => {
      const v = new Validator(simpleSchema);
      do_not_optimize(v.isValidObject(simpleValid));
    });
    bench("ajv", () => {
      const a = new Ajv({ strict: false });
      do_not_optimize(a.compile(simpleSchema)(simpleValid));
    });
  });

  // 2. Cold start: compile + JSON parse + validate (real-world API)
  group("cold start: compile + JSON validate (4KB payload)", () => {
    bench("ata", () => {
      const v = new Validator(nestedSchema);
      do_not_optimize(v.isValidJSON(nestedJSON));
    });
    bench("ajv", () => {
      const a = new Ajv({ strict: false });
      const fn = a.compile(nestedSchema);
      do_not_optimize(fn(JSON.parse(nestedJSON)));
    });
  });

  // 3. Large invalid array — first error exit vs allErrors
  group("10K invalid items: first-error exit", () => {
    bench("ata (instant exit)", () => do_not_optimize(ataArray.isValidObject(largeInvalid)));
    bench("ajv allErrors", () => do_not_optimize(ajvArrayAll(largeInvalid)));
    bench("ajv firstError", () => do_not_optimize(ajvArrayFirst(largeInvalid)));
  });
});

await run();
