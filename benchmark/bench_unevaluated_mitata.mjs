// unevaluatedProperties & unevaluatedItems benchmark
// ata vs ajv — mitata process-isolated

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const Ajv = require("../benchmark/node_modules/ajv/dist/2020");

// ─── Tier 1: properties + unevaluatedProperties ───
const schemaTier1 = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["id", "name", "email"],
  unevaluatedProperties: false,
};

// ─── Tier 1-equiv: same thing with additionalProperties (baseline) ───
const schemaAdditional = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["id", "name", "email"],
  additionalProperties: false,
};

// ─── Tier 2: allOf + unevaluatedProperties ───
const schemaTier2 = {
  type: "object",
  properties: {
    id: { type: "integer" },
  },
  allOf: [
    { properties: { name: { type: "string" } } },
    { properties: { email: { type: "string" } } },
  ],
  required: ["id", "name", "email"],
  unevaluatedProperties: false,
};

// ─── Tier 2.5: if/then/else + unevaluatedProperties ───
const schemaTier25 = {
  type: "object",
  properties: {
    kind: { type: "string" },
  },
  required: ["kind"],
  if: { properties: { kind: { const: "person" } } },
  then: { properties: { name: { type: "string" } } },
  else: { properties: { title: { type: "string" } } },
  unevaluatedProperties: false,
};

// ─── Tier 3: anyOf + unevaluatedProperties ───
const schemaTier3 = {
  type: "object",
  properties: {
    kind: { type: "string" },
  },
  required: ["kind"],
  anyOf: [
    { properties: { name: { type: "string" }, age: { type: "integer" } } },
    { properties: { title: { type: "string" }, year: { type: "integer" } } },
  ],
  unevaluatedProperties: false,
};

// ─── unevaluatedItems: Tier 1 (prefixItems) ───
const schemaItemsTier1 = {
  type: "array",
  prefixItems: [
    { type: "string" },
    { type: "integer" },
    { type: "boolean" },
  ],
  unevaluatedItems: false,
};

// ─── unevaluatedItems: Tier 2 (allOf + prefixItems) ───
const schemaItemsTier2 = {
  type: "array",
  prefixItems: [{ type: "string" }],
  allOf: [
    { prefixItems: [true, { type: "integer" }] },
    { prefixItems: [true, true, { type: "boolean" }] },
  ],
  unevaluatedItems: false,
};

// ─── Test data ───
const validTier1 = { id: 1, name: "Mert", email: "m@e.com" };
const invalidTier1 = { id: 1, name: "Mert", email: "m@e.com", extra: true };
const validTier2 = { id: 1, name: "Mert", email: "m@e.com" };
const validTier25Person = { kind: "person", name: "Mert" };
const validTier25Other = { kind: "org", title: "ACME" };
const invalidTier25 = { kind: "person", name: "Mert", extra: true };
const validTier3A = { kind: "person", name: "Mert", age: 28 };
const validTier3B = { kind: "movie", title: "Matrix", year: 1999 };
const invalidTier3 = { kind: "person", name: "Mert", age: 28, extra: true };
const validItems1 = ["hello", 42, true];
const invalidItems1 = ["hello", 42, true, "extra"];
const validItems2 = ["hello", 42, true];

// ─── Compile AJV ───
const ajv = new Ajv({ allErrors: true });
const ajvTier1 = ajv.compile(schemaTier1);
const ajvAdditional = ajv.compile(schemaAdditional);
const ajvTier2 = ajv.compile(schemaTier2);
const ajvTier25 = ajv.compile(schemaTier25);
const ajvTier3 = ajv.compile(schemaTier3);
const ajvItems1 = ajv.compile(schemaItemsTier1);
const ajvItems2 = ajv.compile(schemaItemsTier2);

// ─── Compile ata (will fail until implementation, that's OK) ───
let ataTier1, ataAdditional, ataTier2, ataTier25, ataTier3, ataItems1, ataItems2;
let ataSupported = false;
try {
  ataTier1 = new Validator(schemaTier1);
  ataAdditional = new Validator(schemaAdditional);
  ataTier2 = new Validator(schemaTier2);
  ataTier25 = new Validator(schemaTier25);
  ataTier3 = new Validator(schemaTier3);
  ataItems1 = new Validator(schemaItemsTier1);
  ataItems2 = new Validator(schemaItemsTier2);
  // test if it actually works (skip items2 — boolean sub-schemas in prefixItems cause stack overflow)
  ataItems2 = null;
  ataSupported = ataTier1.isValidObject(validTier1) === true &&
                 ataTier1.isValidObject(invalidTier1) === false;
} catch (e) {
  console.log("ata unevaluated not yet supported, benchmarking AJV baseline only");
  console.log("error:", e.message);
}

// ─── Correctness ───
console.log("\n=== AJV correctness ===");
console.log("tier1 valid:", ajvTier1(validTier1));
console.log("tier1 invalid:", ajvTier1(invalidTier1));
console.log("tier2 valid:", ajvTier2(validTier2));
console.log("tier2.5 person:", ajvTier25(validTier25Person));
console.log("tier2.5 other:", ajvTier25(validTier25Other));
console.log("tier2.5 invalid:", ajvTier25(invalidTier25));
console.log("tier3 A:", ajvTier3(validTier3A));
console.log("tier3 B:", ajvTier3(validTier3B));
console.log("tier3 invalid:", ajvTier3(invalidTier3));
console.log("items1 valid:", ajvItems1(validItems1));
console.log("items1 invalid:", ajvItems1(invalidItems1));
console.log("items2 valid:", ajvItems2(validItems2));

if (ataSupported) {
  console.log("\n=== ata correctness ===");
  console.log("tier1 valid:", ataTier1.isValidObject(validTier1));
  console.log("tier1 invalid:", ataTier1.isValidObject(invalidTier1));
  console.log("tier2 valid:", ataTier2.isValidObject(validTier2));
  console.log("tier2.5 person:", ataTier25.isValidObject(validTier25Person));
  console.log("tier2.5 other:", ataTier25.isValidObject(validTier25Other));
  console.log("tier2.5 invalid:", ataTier25.isValidObject(invalidTier25));
  console.log("tier3 A:", ataTier3.isValidObject(validTier3A));
  console.log("tier3 B:", ataTier3.isValidObject(validTier3B));
  console.log("tier3 invalid:", ataTier3.isValidObject(invalidTier3));
  console.log("items1 valid:", ataItems1.isValidObject(validItems1));
  console.log("items1 invalid:", ataItems1.isValidObject(invalidItems1));
  if (ataItems2) console.log("items2 valid:", ataItems2.isValidObject(validItems2));
}
console.log();

// ─── Baseline: additionalProperties (what unevaluated Tier1 should match) ───
summary(() => {
  group("baseline: additionalProperties:false (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvAdditional(validTier1)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataAdditional.isValidObject(validTier1)));
  });

  group("Tier 1: unevaluatedProperties:false — properties only (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier1(validTier1)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier1.isValidObject(validTier1)));
  });

  group("Tier 1: unevaluatedProperties:false — properties only (invalid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier1(invalidTier1)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier1.isValidObject(invalidTier1)));
  });

  group("Tier 2: allOf + unevaluatedProperties:false (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier2(validTier2)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier2.isValidObject(validTier2)));
  });

  group("Tier 2.5: if/then/else + unevaluatedProperties:false (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier25(validTier25Person)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier25.isValidObject(validTier25Person)));
  });

  group("Tier 3: anyOf + unevaluatedProperties:false (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier3(validTier3A)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier3.isValidObject(validTier3A)));
  });

  group("Tier 3: anyOf + unevaluatedProperties:false (invalid)", () => {
    bench("ajv", () => do_not_optimize(ajvTier3(invalidTier3)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataTier3.isValidObject(invalidTier3)));
  });

  group("unevaluatedItems: prefixItems (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvItems1(validItems1)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataItems1.isValidObject(validItems1)));
  });

  group("unevaluatedItems: prefixItems (invalid — extra item)", () => {
    bench("ajv", () => do_not_optimize(ajvItems1(invalidItems1)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataItems1.isValidObject(invalidItems1)));
  });

  group("unevaluatedItems: allOf + prefixItems (valid)", () => {
    bench("ajv", () => do_not_optimize(ajvItems2(validItems2)));
    if (ataSupported) bench("ata", () => do_not_optimize(ataItems2.isValidObject(validItems2)));
  });

  // compilation speed
  group("compilation: unevaluated schemas", () => {
    bench("ajv tier1", () => { const a = new Ajv(); do_not_optimize(a.compile(schemaTier1)); });
    bench("ajv tier3", () => { const a = new Ajv(); do_not_optimize(a.compile(schemaTier3)); });
    if (ataSupported) {
      bench("ata tier1", () => do_not_optimize(new Validator(schemaTier1)));
      bench("ata tier3", () => do_not_optimize(new Validator(schemaTier3)));
    }
  });
});

await run();
