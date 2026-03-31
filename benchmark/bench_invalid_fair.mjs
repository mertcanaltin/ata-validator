import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const { Compile } = await import("typebox/compile");

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

const invalidDoc = { id: -1, name: "", email: "bad", age: 200, active: "yes" };
const validDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };

const ataV = new Validator(schema);
const tbV = Compile(schema);

// correctness check
console.log("correctness:");
console.log("  ata isValidObject(invalid): ", ataV.isValidObject(invalidDoc));
console.log("  typebox Check(invalid):     ", tbV.Check(invalidDoc));
console.log("  ata isValidObject(valid):   ", ataV.isValidObject(validDoc));
console.log("  typebox Check(valid):       ", tbV.Check(validDoc));
console.log();

summary(() => {
  group("invalid document (boolean result)", () => {
    bench("ata isValidObject", () => do_not_optimize(ataV.isValidObject(invalidDoc)));
    bench("typebox Check", () => do_not_optimize(tbV.Check(invalidDoc)));
  });

  group("valid document (boolean result)", () => {
    bench("ata isValidObject", () => do_not_optimize(ataV.isValidObject(validDoc)));
    bench("typebox Check", () => do_not_optimize(tbV.Check(validDoc)));
  });

  group("invalid document (with error details)", () => {
    bench("ata validate", () => do_not_optimize(ataV.validate(invalidDoc)));
  });
});

await run();
