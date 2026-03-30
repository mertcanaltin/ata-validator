const { Validator } = require('../index.js')

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email' },
  },
  required: ['id', 'name', 'email'],
  patternProperties: { '^x-': { type: 'string' } },
  propertyNames: { maxLength: 20 },
  dependentSchemas: { email: { required: ['name'] } },
  additionalProperties: false
}

const invalidDoc = { id: -1, name: '', email: 'bad', 'x-num': 123 }

const v = new Validator(schema)
v.validate(invalidDoc) // warm up

// Hot loop — only invalid path
for (let i = 0; i < 10_000_000; i++) {
  v.validate(invalidDoc)
}
