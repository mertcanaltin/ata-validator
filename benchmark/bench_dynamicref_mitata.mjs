import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { runBench } from "./_scoreboard-helpers.mjs";

const { Validator } = require("../index.js");

// 1. Normal schema (no dynamicRef) - baseline
const normalSchema = {
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

// 2. Schema with $dynamicRef (recursive tree)
const dynamicRefSchema = {
  type: "object",
  $dynamicAnchor: "node",
  properties: {
    data: true,
    children: {
      type: "array",
      items: { $dynamicRef: "#node" },
    },
  },
};

// 3. Schema with $anchor + $ref (no dynamic scope)
const anchorSchema = {
  type: "array",
  items: { $ref: "#item" },
  $defs: {
    foo: {
      $anchor: "item",
      type: "string",
    },
  },
};

const normalV = new Validator(normalSchema);
const dynamicV = new Validator(dynamicRefSchema);
const anchorV = new Validator(anchorSchema);

const normalDoc = { id: 42, name: "Mert", email: "mert@example.com", age: 26, active: true };
const treeDoc = { data: 1, children: [{ data: 2, children: [] }, { data: 3, children: [{ data: 4, children: [] }] }] };
const anchorDoc = ["foo", "bar", "baz"];

// correctness
console.log("correctness:");
console.log("  normal (valid):", normalV.validate(normalDoc).valid);
console.log("  dynamicRef (valid):", dynamicV.validate(treeDoc).valid);
console.log("  anchor (valid):", anchorV.validate(anchorDoc).valid);
console.log("  dynamicRef (invalid):", dynamicV.validate({ data: 1, children: [{ data: "x", children: [42] }] }).valid);
console.log("  anchor (invalid):", anchorV.validate(["foo", 42]).valid);
console.log();

summary(() => {
  group("validate (valid doc)", () => {
    bench("normal schema", () => do_not_optimize(normalV.validate(normalDoc)));
    bench("$dynamicRef tree", () => do_not_optimize(dynamicV.validate(treeDoc)));
    bench("$anchor array", () => do_not_optimize(anchorV.validate(anchorDoc)));
  });

  group("compilation", () => {
    bench("normal schema", () => do_not_optimize(new Validator(normalSchema)));
    bench("$dynamicRef tree", () => do_not_optimize(new Validator(dynamicRefSchema)));
    bench("$anchor array", () => do_not_optimize(new Validator(anchorSchema)));
  });
});

await runBench('bench_dynamicref_mitata.mjs');
