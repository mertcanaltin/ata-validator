const { bench, group, run, summary, do_not_optimize } = require("mitata");
const { Validator } = require("../index");
const Ajv = require("./node_modules/ajv");
const addFormats = require("./node_modules/ajv-formats");

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
  age: 26,
  active: true,
  tags: ["nodejs", "cpp", "performance"],
  address: { street: "123 Main St", city: "Istanbul", zip: "34000" },
};

const invalidDoc = {
  id: -1,
  name: "",
  email: "not-an-email",
  age: 200,
  active: "yes",
  tags: ["a", "a"],
  address: { zip: "abc" },
};

const jsonStr = JSON.stringify(validDoc);

// pre-compile
const ataValidator = new Validator(schema);
ataValidator.validate(validDoc); // trigger lazy compile

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(schema);

summary(() => {
  group("validate(obj) - valid", () => {
    bench("ata", () => do_not_optimize(ataValidator.validate(validDoc)));
    bench("ajv", () => do_not_optimize(ajvValidate(validDoc)));
  });

  group("validate(obj) - invalid", () => {
    bench("ata", () => do_not_optimize(ataValidator.validate(invalidDoc)));
    bench("ajv", () => do_not_optimize(ajvValidate(invalidDoc)));
  });

  group("isValidObject(obj) - valid", () => {
    bench("ata", () =>
      do_not_optimize(ataValidator.isValidObject(validDoc)),
    );
    bench("ajv", () => do_not_optimize(ajvValidate(validDoc)));
  });

  group("validateJSON(str) - valid", () => {
    bench("ata", () => do_not_optimize(ataValidator.validateJSON(jsonStr)));
    bench("ajv", () => do_not_optimize(ajvValidate(JSON.parse(jsonStr))));
  });

  group("schema compilation", () => {
    bench("ata", () => do_not_optimize(new Validator(schema)));
    bench("ajv", () => {
      const a = new Ajv({ allErrors: true });
      addFormats(a);
      do_not_optimize(a.compile(schema));
    });
  });

  group("first validation (compile + validate)", () => {
    bench("ata", () => {
      const v = new Validator(schema);
      do_not_optimize(v.validate(validDoc));
    });
    bench("ajv", () => {
      const a = new Ajv({ allErrors: true });
      addFormats(a);
      const fn = a.compile(schema);
      do_not_optimize(fn(validDoc));
    });
  });
});

run();
