// typebox 1.x is ESM only
// includes format: 'email' since typebox 1.x supports RFC formats
//
// NOTE: not an apples-to-apples comparison.
// typebox is a TypeScript type builder, ata is a JSON Schema validator.
// this benchmark exists because people asked for the comparison.

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const Type = (await import("typebox")).default;
const { Compile } = await import("typebox/compile");

const ataSchema = {
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

const tbSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    email: Type.String({ format: "email" }),
    age: Type.Integer({ minimum: 0, maximum: 150 }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

const validDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };
const invalidDoc = { id: -1, name: "", email: "not-an-email", age: 200, active: "yes" };

const ataV = new Validator(ataSchema);
ataV.validate(validDoc);
const tbV = Compile(tbSchema);

// correctness check
console.log("correctness:");
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

  group("compile", () => {
    bench("ata", () => do_not_optimize(new Validator(ataSchema)));
    bench("typebox", () => do_not_optimize(Compile(tbSchema)));
  });

  group("first validation (compile + check)", () => {
    bench("ata", () => {
      const v = new Validator(ataSchema);
      do_not_optimize(v.isValidObject(validDoc));
    });
    bench("typebox", () => {
      const c = Compile(tbSchema);
      do_not_optimize(c.Check(validDoc));
    });
  });
});

run();
