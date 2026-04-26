// all validators, same schema, same run, mitata process-isolated
// this is the single source of truth for all benchmark numbers

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { runBench } from "./_scoreboard-helpers.mjs";

const { Validator } = require("../index.js");
const Ajv = require("../benchmark/node_modules/ajv");
const addFormats = require("../benchmark/node_modules/ajv-formats");
const { z } = require("zod");
const v = require("valibot");
const { Compile } = await import("typebox/compile");

// same schema for everyone
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
};

const validDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };
const invalidDoc = { id: -1, name: "", email: "bad", age: 200, active: "yes" };

// compile all
const ataV = new Validator(schema);
ataV.validate(validDoc);

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvFn = ajv.compile(schema);

const zodS = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  active: z.boolean(),
});

const valS = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  email: v.pipe(v.string(), v.email()),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(150)),
  active: v.boolean(),
});

const tbV = Compile(schema);

// correctness
console.log("correctness (valid):");
console.log("  ata:", ataV.validate(validDoc).valid);
console.log("  ajv:", ajvFn(validDoc));
console.log("  zod:", zodS.safeParse(validDoc).success);
console.log("  val:", v.safeParse(valS, validDoc).success);
console.log("  tb: ", tbV.Check(validDoc));
console.log("correctness (invalid):");
console.log("  ata:", ataV.validate(invalidDoc).valid);
console.log("  ajv:", ajvFn(invalidDoc));
console.log("  zod:", zodS.safeParse(invalidDoc).success);
console.log("  val:", v.safeParse(valS, invalidDoc).success);
console.log("  tb: ", tbV.Check(invalidDoc));
console.log();

summary(() => {
  group("validate (valid)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(validDoc)));
    bench("ajv", () => do_not_optimize(ajvFn(validDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(validDoc)));
    bench("zod", () => do_not_optimize(zodS.safeParse(validDoc)));
    bench("valibot", () => do_not_optimize(v.safeParse(valS, validDoc)));
  });

  group("validate (invalid)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(invalidDoc)));
    bench("ajv", () => do_not_optimize(ajvFn(invalidDoc)));
    bench("typebox", () => do_not_optimize(tbV.Check(invalidDoc)));
    bench("zod", () => do_not_optimize(zodS.safeParse(invalidDoc)));
    bench("valibot", () => do_not_optimize(v.safeParse(valS, invalidDoc)));
  });

  group("compilation", () => {
    bench("ata", () => do_not_optimize(new Validator(schema)));
    bench("ajv", () => { const a = new Ajv({ allErrors: true }); addFormats(a); do_not_optimize(a.compile(schema)); });
    bench("typebox", () => do_not_optimize(Compile(schema)));
  });

  group("first validation (compile + validate)", () => {
    bench("ata", () => { const vv = new Validator(schema); do_not_optimize(vv.validate(validDoc)); });
    bench("ajv", () => { const a = new Ajv({ allErrors: true }); addFormats(a); const fn = a.compile(schema); do_not_optimize(fn(validDoc)); });
    bench("typebox", () => { const c = Compile(schema); do_not_optimize(c.Check(validDoc)); });
  });
});

await runBench('bench_all_mitata.mjs');
