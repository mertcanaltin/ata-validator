// Complex schema benchmark: patternProperties + dependentSchemas + propertyNames
// Tests the newly-added codegen keywords against ajv

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { runBench } from "./_scoreboard-helpers.mjs";

const { Validator } = require("../index.js");
const Ajv2020 = require("../benchmark/node_modules/ajv/dist/2020");
const addFormats = require("../benchmark/node_modules/ajv-formats");

// Complex schema using all newly-added keywords
const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
  },
  required: ["id", "name", "email"],
  patternProperties: {
    "^x-": { type: "string" },
  },
  propertyNames: { maxLength: 20 },
  dependentSchemas: {
    email: { required: ["name"] },
  },
  additionalProperties: false,
};

// Cross-schema $ref test
const addressSchema = {
  $id: "https://example.com/address",
  type: "object",
  properties: {
    street: { type: "string" },
    city: { type: "string", minLength: 1 },
    zip: { type: "string", pattern: "^\\d{5}$" },
  },
  required: ["street", "city"],
};

const refSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    address: { $ref: "https://example.com/address" },
  },
  required: ["name", "address"],
};

const validDoc = { id: 1, name: "Mert", email: "mert@test.com", tags: ["dev"], "x-custom": "val" };
const invalidDoc = { id: -1, name: "", email: "bad", "x-num": 123 };

const validRefDoc = { name: "Mert", address: { street: "Main St", city: "NYC", zip: "10001" } };
const invalidRefDoc = { name: "", address: { street: "X" } };

// compile ata
const ataV = new Validator(schema);
ataV.validate(validDoc);

const ataRefV = new Validator(refSchema, { schemas: [addressSchema] });
ataRefV.validate(validRefDoc);

// compile ajv
const ajv = new Ajv2020.default({ allErrors: true });
addFormats(ajv);
const ajvFn = ajv.compile(schema);

const ajv2 = new Ajv2020.default({ allErrors: true });
addFormats(ajv2);
ajv2.addSchema(addressSchema);
const ajvRefFn = ajv2.compile(refSchema);

// correctness check
console.log("correctness (complex schema):");
console.log("  ata valid:", ataV.validate(validDoc).valid, "  ajv valid:", ajvFn(validDoc));
console.log("  ata invalid:", ataV.validate(invalidDoc).valid, "  ajv invalid:", ajvFn(invalidDoc));
console.log("correctness (cross-ref):");
console.log("  ata valid:", ataRefV.validate(validRefDoc).valid, "  ajv valid:", ajvRefFn(validRefDoc));
console.log("  ata invalid:", ataRefV.validate(invalidRefDoc).valid, "  ajv invalid:", ajvRefFn(invalidRefDoc));
console.log();

summary(() => {
  group("complex schema: validate (valid)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(validDoc)));
    bench("ajv", () => do_not_optimize(ajvFn(validDoc)));
  });

  group("complex schema: validate (invalid)", () => {
    bench("ata", () => do_not_optimize(ataV.validate(invalidDoc)));
    bench("ajv", () => do_not_optimize(ajvFn(invalidDoc)));
  });

  group("complex schema: isValidObject (valid)", () => {
    bench("ata", () => do_not_optimize(ataV.isValidObject(validDoc)));
    bench("ajv", () => do_not_optimize(ajvFn(validDoc)));
  });

  group("cross-ref: validate (valid)", () => {
    bench("ata", () => do_not_optimize(ataRefV.validate(validRefDoc)));
    bench("ajv", () => do_not_optimize(ajvRefFn(validRefDoc)));
  });

  group("cross-ref: validate (invalid)", () => {
    bench("ata", () => do_not_optimize(ataRefV.validate(invalidRefDoc)));
    bench("ajv", () => do_not_optimize(ajvRefFn(invalidRefDoc)));
  });

  group("complex schema: compilation", () => {
    bench("ata", () => {
      const v = new Validator(schema);
      do_not_optimize(v);
    });
    bench("ajv", () => {
      const a = new Ajv2020.default({ allErrors: true });
      const fn = a.compile(schema);
      do_not_optimize(fn);
    });
  });
});

await runBench('bench_complex_mitata.mjs');
