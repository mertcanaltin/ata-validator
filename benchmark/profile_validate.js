// Pure validation benchmark for profiling — nothing else
const { Validator } = require('../index');

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    active: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 10 },
    address: {
      type: 'object',
      properties: { street: { type: 'string' }, city: { type: 'string' } },
      required: ['street', 'city'],
    },
  },
  required: ['id', 'name', 'email', 'active'],
};

const v = new Validator(schema);
const doc = {
  id: 42, name: 'Mert', email: 'mert@example.com', age: 26, active: true,
  tags: ['nodejs', 'cpp', 'perf'], address: { street: 'Main St', city: 'Istanbul' },
};

// Expose internals for profiling
const jsFn = v._jsFn;
const combined = v.validate;

// Warmup
for (let i = 0; i < 10000; i++) combined(doc);

// Profile this loop
const N = 5_000_000;
const start = performance.now();
for (let i = 0; i < N; i++) combined(doc);
const ms = performance.now() - start;
console.log(Math.round(N / (ms / 1000)).toLocaleString(), 'ops/sec');
