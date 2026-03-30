// Pure ata validation — no ajv, no framework, just the hot path
const { Validator } = require('../index.js')

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    active: { type: 'boolean' },
  },
  required: ['id', 'name', 'email', 'age', 'active'],
  patternProperties: { '^x-': { type: 'string' } },
  propertyNames: { maxLength: 20 },
  dependentSchemas: { email: { required: ['name'] } },
  additionalProperties: false,
}

const doc = { id: 42, name: 'Mert', email: 'mert@example.com', age: 26, active: true, 'x-custom': 'val' }

const v = new Validator(schema)

// Warm up — trigger JIT
for (let i = 0; i < 100000; i++) v.validate(doc)

// Hot loop — this is what xctrace will profile
for (let i = 0; i < 20_000_000; i++) {
  v.validate(doc)
}
