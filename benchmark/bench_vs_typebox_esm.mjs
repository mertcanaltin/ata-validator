// typebox 1.x is ESM only, JSON Schema compliant with RFC format support.
// both sides use the same raw JSON Schema object (per sinclairzx81's suggestion).
// measured with mitata for process isolation.

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const { Compile } = await import("typebox/compile");

// same schema for both -- raw JSON Schema, no Type.Object() wrapper
const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
  },
  required: ["id", "name", "email", "age", "active"],
  additionalProperties: false,
};

const validDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };
const invalidDoc = { id: -1, name: "", email: "not-an-email", age: 200, active: "yes" };

const ataV = new Validator(schema);
ataV.validate(validDoc);
const tbV = Compile(schema);

console.log("correctness (same schema object for both):");
console.log("  ata  valid:", ataV.isValidObject(validDoc), " invalid:", ataV.isValidObject(invalidDoc));
console.log("  tb   valid:", tbV.Check(validDoc), " invalid:", tbV.Check(invalidDoc));
console.log();

summary(() => {
  group("boolean check (valid)", () => {
    bench("ata", () => do_not_optimize(ataV.isValidObject(validDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(validDoc)));
  });

  group("boolean check (invalid)", () => {
    bench("ata", () => do_not_optimize(ataV.isValidObject(invalidDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(invalidDoc)));
  });

  group("compile (same raw schema)", () => {
    bench("ata", () => do_not_optimize(new Validator(schema)));
    bench("typebox", () => do_not_optimize(Compile(schema)));
  });

  group("first validation (compile + check)", () => {
    bench("ata", () => {
      const v = new Validator(schema);
      do_not_optimize(v.isValidObject(validDoc));
    });
    bench("typebox", () => {
      const c = Compile(schema);
      do_not_optimize(c.Check(validDoc));
    });
  });
});

run();
