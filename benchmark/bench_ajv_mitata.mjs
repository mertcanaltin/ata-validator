import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const Ajv = require("../benchmark/node_modules/ajv");
const addFormats = require("../benchmark/node_modules/ajv-formats");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
    tags: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      maxItems: 10,
    },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zip: { type: "string", pattern: "^[0-9]{5}$" },
      },
      required: ["street", "city"],
    },
  },
  required: ["id", "name", "email", "active"],
};

const validDoc = {
  id: 42,
  name: "Mert Can Altin",
  email: "mert@example.com",
  age: 28,
  active: true,
  tags: ["nodejs", "cpp", "performance"],
  address: {
    street: "123 Main St",
    city: "Istanbul",
    zip: "34000",
  },
};

const invalidDoc = {
  id: -1,
  name: "",
  email: "not-an-email",
  age: 200,
  active: "yes",
  tags: ["a", "a"],
  address: {
    zip: "abc",
  },
};

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const simpleValidate = ajv.compile({ type: "string" });

// correctness check
console.log("correctness:");
console.log("  valid doc:  ", validate(validDoc));
console.log("  invalid doc:", validate(invalidDoc));
console.log("  simple str: ", simpleValidate("hello"));
console.log();

summary(() => {
  group("ajv compile", () => {
    bench("compile schema", () => {
      const a = new Ajv({ allErrors: true });
      addFormats(a);
      do_not_optimize(a.compile(schema));
    });
  });

  group("ajv validate (pre-compiled)", () => {
    bench("validate valid document", () => do_not_optimize(validate(validDoc)));
    bench("validate invalid document", () => do_not_optimize(validate(invalidDoc)));
  });

  group("ajv simple type check", () => {
    bench("type:string validate", () => do_not_optimize(simpleValidate("hello")));
  });
});

await run();
