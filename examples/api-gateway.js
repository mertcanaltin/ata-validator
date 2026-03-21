const { Validator } = require("ata-validator");

// Simulate an API gateway validating incoming JSON requests
const userSchema = new Validator({
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    tags: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
    },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        country: { type: "string", minLength: 2 },
      },
      required: ["city", "country"],
    },
  },
  required: ["id", "name", "email"],
});

// In real world: request body comes as JSON string
const jsonBody =
  '{"id":1,"name":"Mert","email":"mert@example.com","tags":["nodejs","cpp"]}';

// validateJSON() uses simdjson — fastest path for JSON strings
const result = userSchema.validateJSON(jsonBody);

if (result.valid) {
  console.log("Request accepted");
} else {
  console.log("Request rejected:");
  for (const err of result.errors) {
    console.log(`  ${err.message}`);
  }
}
