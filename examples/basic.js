const { Validator } = require("ata-validator");

// Define a schema
const schema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    role: { enum: ["admin", "user", "moderator"] },
  },
  required: ["name", "email", "role"],
  additionalProperties: false,
};

// Compile once, validate many times
const v = new Validator(schema);

// Valid data
const result = v.validate({
  name: "Mert Can Altin",
  email: "mert@example.com",
  age: 28,
  role: "admin",
});
console.log("Valid:", result.valid); // true

// Invalid data
const result2 = v.validate({
  name: "",
  email: "not-an-email",
  age: -5,
  role: "superadmin",
  extra: true,
});
console.log("Valid:", result2.valid); // false
console.log("Errors:");
for (const err of result2.errors) {
  console.log(`  ${err.path || "/"}: ${err.message}`);
}
