const { Validator } = require('../index')

// Tier 1: properties + unevaluatedProperties:false
const v1 = new Validator({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string' },
  },
  required: ['id', 'name', 'email'],
  unevaluatedProperties: false,
})

// Tier 2: allOf + unevaluatedProperties:false
const v2 = new Validator({
  type: 'object',
  properties: { id: { type: 'integer' } },
  allOf: [
    { properties: { name: { type: 'string' } } },
    { properties: { email: { type: 'string' } } },
  ],
  required: ['id', 'name', 'email'],
  unevaluatedProperties: false,
})

// unevaluatedItems: prefixItems + false
const v3 = new Validator({
  type: 'array',
  prefixItems: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
  unevaluatedItems: false,
})

const data1 = { id: 1, name: 'Mert', email: 'm@e.com' }
const data2 = { id: 1, name: 'Mert', email: 'm@e.com' }
const data3 = ['hello', 42, true]

// Warmup
for (let i = 0; i < 10000; i++) {
  v1.isValidObject(data1)
  v2.isValidObject(data2)
  v3.isValidObject(data3)
}

// Hot loop
const N = 5_000_000
for (let i = 0; i < N; i++) {
  v1.isValidObject(data1)
  v2.isValidObject(data2)
  v3.isValidObject(data3)
}
