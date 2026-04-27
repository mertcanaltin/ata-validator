// ata (validate) vs fast-json-stringify (serialize)
//
// Different operations, same architectural pattern: schema-driven precompile.
// Three dimensions worth comparing:
//   1. Schema instantiation cost (the lazy/eager compile setup)
//   2. Cold start (instantiate + first call)
//   3. Steady-state throughput on the same schema
//
// Steady-state isn't apples-to-apples by design (validate vs stringify).
// Reading: the headline numbers are the compile-time and cold-start ones,
// because that's what Matteo flagged as the durable differentiator.

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
const fjs = require("fast-json-stringify");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    email: { type: "string" },
    age: { type: "integer" },
    active: { type: "boolean" },
  },
  required: ["id", "name", "email", "active"],
};

const sample = { id: 42, name: "Mert Can", email: "m@x.com", age: 30, active: true };
const sampleBuf = Buffer.from(JSON.stringify(sample));

// Warm both libraries once so the V8 compile tier is settled before timing.
{
  const v = new Validator(schema);
  for (let i = 0; i < 50_000; i++) v.isValid(sampleBuf);
  const s = fjs(schema);
  for (let i = 0; i < 50_000; i++) s(sample);
}

group("instantiation only", () => {
  bench("ata: new Validator(schema)", () => {
    do_not_optimize(new Validator(schema));
  });
  bench("fast-json-stringify: fjs(schema)", () => {
    do_not_optimize(fjs(schema));
  });
});

group("cold start: instantiate + first call", () => {
  bench("ata: new Validator + isValid(buf)", () => {
    const v = new Validator(schema);
    do_not_optimize(v.isValid(sampleBuf));
  });
  bench("fast-json-stringify: fjs + stringify(obj)", () => {
    const s = fjs(schema);
    do_not_optimize(s(sample));
  });
});

group("steady state (different operations, kept for reference)", () => {
  const v = new Validator(schema);
  v.isValid(sampleBuf);  // trigger lazy compile
  bench("ata: isValid(buffer) on warm validator", () => {
    do_not_optimize(v.isValid(sampleBuf));
  });
  const s = fjs(schema);
  bench("fast-json-stringify: stringify(obj) on warm stringifier", () => {
    do_not_optimize(s(sample));
  });
});

await run({ summary });
