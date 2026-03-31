import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";

const { Validator } = require("../index.js");
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
  address: { street: "123 Main St", city: "Istanbul", zip: "34000" },
};

const validJsonStr = JSON.stringify(validDoc);

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);
const ataValidator = new Validator(schema);

// correctness check
console.log("correctness:");
const ataJsonResult = ataValidator.validateJSON(validJsonStr);
const ajvJsonResult = ajvValidate(JSON.parse(validJsonStr));
console.log("  ata validateJSON:", ataJsonResult.valid);
console.log("  ajv parse+validate:", ajvJsonResult);
console.log("  ata validate(obj):", ataValidator.validate(validDoc).valid);
console.log("  ajv validate(obj):", ajvValidate(validDoc));
console.log();

summary(() => {
  group("JSON string -> validation result", () => {
    bench("ata  validateJSON(str)", () => do_not_optimize(ataValidator.validateJSON(validJsonStr)));
    bench("ajv  JSON.parse(str) + validate(obj)", () => {
      const data = JSON.parse(validJsonStr);
      do_not_optimize(ajvValidate(data));
    });
  });

  group("JS object -> validation result", () => {
    bench("ata  validate(obj)", () => do_not_optimize(ataValidator.validate(validDoc)));
    bench("ajv  validate(obj)", () => do_not_optimize(ajvValidate(validDoc)));
  });
});

await run();
