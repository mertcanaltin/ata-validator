// Focused benchmark for xctrace profiling — only On-Demand isValid path
const { Validator } = require("../index");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
  },
  required: ["id", "name", "email", "active"],
};

const v = new Validator(schema);
const buf = Buffer.from(
  JSON.stringify({
    id: 42,
    name: "Mert Can Altin",
    email: "mert@example.com",
    age: 26,
    active: true,
  }),
);

// Warm up — ensure TurboFan optimizes
for (let i = 0; i < 50000; i++) v.isValid(buf);

// Hot loop — this is what xctrace will profile
const N = 10_000_000;
const start = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  v.isValid(buf);
}
const elapsed = Number(process.hrtime.bigint() - start);
console.log(`${N} iterations in ${(elapsed / 1e6).toFixed(1)}ms`);
console.log(`Per call: ${(elapsed / N).toFixed(1)}ns`);
