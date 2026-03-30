// ata vs Zod vs Valibot vs TypeBox 1.x
// same validation logic, different tools.
//
// NOTE: these are different categories.
// ata and typebox are JSON Schema validators.
// zod and valibot are schema-builder DSLs.
// this benchmark exists because people asked for the comparison.
// measured with mitata for process isolation.

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

// ata
const { Validator } = require("../index.js");

// zod
const { z } = require("zod");

// valibot
const v = require("valibot");

// typebox 1.x
const Type = (await import("typebox")).default;
const { Compile } = await import("typebox/compile");

// same validation: object with id, name, email, age, active
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
};

const zodSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  active: z.boolean(),
});

const valibotSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  email: v.pipe(v.string(), v.email()),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(150)),
  active: v.boolean(),
});

const tbSchema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
  },
  required: ["id", "name", "email", "age", "active"],
};

const validDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };
const invalidDoc = { id: -1, name: "", email: "bad", age: 200, active: "yes" };

// pre-compile
const ataV = new Validator(ataSchema);
ataV.validate(validDoc);
const tbV = Compile(tbSchema);

// correctness check
console.log("correctness (valid doc):");
console.log("  ata:     ", ataV.isValidObject(validDoc));
console.log("  zod:     ", zodSchema.safeParse(validDoc).success);
console.log("  valibot: ", v.safeParse(valibotSchema, validDoc).success);
console.log("  typebox: ", tbV.Check(validDoc));
console.log("");
console.log("correctness (invalid doc):");
console.log("  ata:     ", ataV.isValidObject(invalidDoc));
console.log("  zod:     ", zodSchema.safeParse(invalidDoc).success);
console.log("  valibot: ", v.safeParse(valibotSchema, invalidDoc).success);
console.log("  typebox: ", tbV.Check(invalidDoc));
console.log("");

summary(() => {
  group("validate (valid data)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(validDoc)));
    bench("zod", () => do_not_optimize(zodSchema.safeParse(validDoc)));
    bench("valibot", () => do_not_optimize(v.safeParse(valibotSchema, validDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(validDoc)));
  });

  group("validate (invalid data)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(invalidDoc)));
    bench("zod", () => do_not_optimize(zodSchema.safeParse(invalidDoc)));
    bench("valibot", () => do_not_optimize(v.safeParse(valibotSchema, invalidDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(invalidDoc)));
  });

  group("boolean check (valid data)", () => {
    bench("ata", () => do_not_optimize(ataV.isValidObject(validDoc)));
    bench("zod", () => do_not_optimize(zodSchema.safeParse(validDoc).success));
    bench("valibot", () => do_not_optimize(v.safeParse(valibotSchema, validDoc).success));
    bench("typebox", () => do_not_optimize(tbV.Check(validDoc)));
  });
});

run();
