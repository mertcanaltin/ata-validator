// Isolated cold start benchmark for profiling with xctrace
// Cold start = new Validator(schema) + first validate()
const { Validator } = require('../index');

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    active: { type: 'boolean' },
  },
  required: ['id', 'name', 'email', 'active'],
};

const doc = { id: 42, name: 'Mert', email: 'mert@example.com', age: 26, active: true };

const N = 100_000;
console.log(`Profiling: cold start, ${N} iterations`);
const start = performance.now();
for (let i = 0; i < N; i++) {
  const v = new Validator(schema);
  v.validate(doc);
}
const ms = performance.now() - start;
const usPerOp = (ms * 1000) / N;
console.log(`${usPerOp.toFixed(2)} us/op | ${(ms).toFixed(0)}ms total`);
