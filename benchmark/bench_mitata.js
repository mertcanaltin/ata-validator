const { bench, group, run } = require("mitata");
const { Validator } = require("../index");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

let Blaze, blazeTemplate;
try {
  Blaze = require("@sourcemeta/blaze").Blaze;
  blazeTemplate = require("./blaze_template.json");
} catch {}

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
      name: "User " + i,
      email: "user" + i + "@example.com",
      age: 20 + (i % 50),
      active: i % 3 !== 0,
      role: ["admin", "user", "moderator"][i % 3],
      scores: [85, 92, 78, 95, 88],
      address: {
        street: (100 + i) + " Main St",
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

let blazeEvaluator;
if (Blaze && blazeTemplate) {
  blazeEvaluator = new Blaze(blazeTemplate);
}

for (const count of [10, 100, 1000]) {
  const data = makeData(count);
  const jsonStr = JSON.stringify(data);

  group(count + " users (" + (jsonStr.length / 1024).toFixed(1) + " KB) - JSON string", () => {
    bench("ata", () => ataValidator.validateJSON(jsonStr));
    bench("ajv", () => ajvValidate(JSON.parse(jsonStr)));
    if (blazeEvaluator) bench("blaze", () => blazeEvaluator.validate(JSON.parse(jsonStr)));
  });

  group(count + " users (" + (jsonStr.length / 1024).toFixed(1) + " KB) - JS object", () => {
    bench("ata", () => ataValidator.validate(data));
    bench("ajv", () => ajvValidate(data));
    if (blazeEvaluator) bench("blaze", () => blazeEvaluator.validate(data));
  });
}

run();
