import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { runBench } from "./_scoreboard-helpers.mjs";

const { Validator } = require("../index.js");
const Ajv = require("../benchmark/node_modules/ajv");
const addFormats = require("../benchmark/node_modules/ajv-formats");

const schema = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1 },
          email: { type: "string", format: "email" },
          age: { type: "integer", minimum: 0, maximum: 150 },
          active: { type: "boolean" },
          role: { enum: ["admin", "user", "moderator"] },
          scores: {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 100 },
            minItems: 1,
          },
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              zip: { type: "string" },
            },
            required: ["street", "city", "country"],
          },
        },
        required: ["id", "name", "email", "active", "role"],
      },
    },
    metadata: {
      type: "object",
      properties: {
        total: { type: "integer" },
        page: { type: "integer", minimum: 1 },
        perPage: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["total", "page", "perPage"],
    },
  },
  required: ["users", "metadata"],
};

function makeData(userCount) {
  const users = [];
  for (let i = 0; i < userCount; i++) {
    users.push({
      id: i + 1,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      age: 20 + (i % 50),
      active: i % 3 !== 0,
      role: ["admin", "user", "moderator"][i % 3],
      scores: [85, 92, 78, 95, 88],
      address: {
        street: `${100 + i} Main St`,
        city: "Istanbul",
        country: "Turkey",
        zip: "34000",
      },
    });
  }
  return { users, metadata: { total: userCount, page: 1, perPage: Math.min(userCount, 100) } };
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);
const ataValidator = new Validator(schema);

// pre-build datasets
const datasets = {};
for (const count of [10, 50, 100, 500, 1000]) {
  const data = makeData(count);
  datasets[count] = { data, jsonStr: JSON.stringify(data) };
}

// correctness check
console.log("correctness (10 users):");
const d10 = datasets[10];
console.log("  ata validate:     ", ataValidator.validate(d10.data).valid);
console.log("  ata validateJSON: ", ataValidator.validateJSON(d10.jsonStr).valid);
console.log("  ajv validate:     ", ajvValidate(d10.data));
console.log("  ajv parse+val:    ", ajvValidate(JSON.parse(d10.jsonStr)));
console.log();

summary(() => {
  for (const count of [10, 50, 100, 500, 1000]) {
    const { data, jsonStr } = datasets[count];

    group(`${count} users — JSON string path`, () => {
      bench("ata  validateJSON(str)", () => do_not_optimize(ataValidator.validateJSON(jsonStr)));
      bench("ajv  JSON.parse(str) + validate(obj)", () => do_not_optimize(ajvValidate(JSON.parse(jsonStr))));
    });

    group(`${count} users — JS object path`, () => {
      bench("ata  validate(obj)", () => do_not_optimize(ataValidator.validate(data)));
      bench("ajv  validate(obj)", () => do_not_optimize(ajvValidate(data)));
    });
  }
});

await runBench('bench_large_mitata.mjs');
