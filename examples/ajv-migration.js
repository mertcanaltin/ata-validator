// Before: using ajv
// const Ajv = require("ajv");

// After: one line change
const Ajv = require("ata-validator/compat");

const ajv = new Ajv();

const schema = {
  type: "object",
  properties: {
    foo: { type: "integer" },
    bar: { type: "string" },
  },
  required: ["foo"],
  additionalProperties: false,
};

const validate = ajv.compile(schema);

// Same API as ajv
console.log(validate({ foo: 1, bar: "abc" })); // true
console.log(validate.errors); // null

console.log(validate({ foo: "wrong", extra: 1 })); // false
console.log(validate.errors);
// [{ instancePath: '...', message: '...' }, ...]
