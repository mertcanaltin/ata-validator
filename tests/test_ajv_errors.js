'use strict'
const { Validator } = require('../index')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`) }
  else { fail++; console.log(`  FAIL  ${msg}`); console.trace() }
}

function validate(schema, data) {
  const v = new Validator(schema)
  const result = v.validate(data)
  return result
}

function firstError(schema, data) {
  const result = validate(schema, data)
  if (result.valid) return null
  return result.errors && result.errors[0]
}

// --- 1. type ---
console.log('\n--- type ---')
{
  const e = firstError({ type: 'string' }, 123)
  assert(e !== null, 'type: error produced')
  assert(e && e.keyword === 'type', `type: keyword is "type" (got ${e && e.keyword})`)
  assert(e && e.instancePath === '', `type: instancePath is "" (got ${e && e.instancePath})`)
  assert(e && e.schemaPath === '#/type', `type: schemaPath is "#/type" (got ${e && e.schemaPath})`)
  assert(e && e.params && e.params.type === 'string', `type: params.type is "string" (got ${e && e.params && e.params.type})`)
  assert(e && e.message === 'must be string', `type: message is "must be string" (got ${e && e.message})`)
}

// --- 2. required ---
console.log('\n--- required ---')
{
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  const e = firstError(schema, {})
  assert(e !== null, 'required: error produced')
  assert(e && e.keyword === 'required', `required: keyword is "required" (got ${e && e.keyword})`)
  assert(e && e.instancePath === '', `required: instancePath is "" (got ${e && e.instancePath})`)
  assert(e && e.schemaPath === '#/required', `required: schemaPath is "#/required" (got ${e && e.schemaPath})`)
  assert(e && e.params && e.params.missingProperty === 'name', `required: params.missingProperty is "name" (got ${e && e.params && e.params.missingProperty})`)
  assert(e && e.message === "must have required property 'name'", `required: message correct (got ${e && e.message})`)
}

// --- 3. minimum ---
console.log('\n--- minimum ---')
{
  const e = firstError({ type: 'number', minimum: 5 }, 3)
  assert(e !== null, 'minimum: error produced')
  assert(e && e.keyword === 'minimum', `minimum: keyword is "minimum" (got ${e && e.keyword})`)
  assert(e && e.params && e.params.comparison === '>=', `minimum: params.comparison is ">=" (got ${e && e.params && e.params.comparison})`)
  assert(e && e.params && e.params.limit === 5, `minimum: params.limit is 5 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must be >= 5', `minimum: message correct (got ${e && e.message})`)
}

// --- 4. maximum ---
console.log('\n--- maximum ---')
{
  const e = firstError({ type: 'number', maximum: 10 }, 15)
  assert(e !== null, 'maximum: error produced')
  assert(e && e.keyword === 'maximum', `maximum: keyword is "maximum" (got ${e && e.keyword})`)
  assert(e && e.params && e.params.comparison === '<=', `maximum: params.comparison is "<=" (got ${e && e.params && e.params.comparison})`)
  assert(e && e.params && e.params.limit === 10, `maximum: params.limit is 10 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must be <= 10', `maximum: message correct (got ${e && e.message})`)
}

// --- 5. exclusiveMinimum ---
console.log('\n--- exclusiveMinimum ---')
{
  const e = firstError({ type: 'number', exclusiveMinimum: 5 }, 5)
  assert(e !== null, 'exclusiveMinimum: error produced')
  assert(e && e.keyword === 'exclusiveMinimum', `exclusiveMinimum: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.comparison === '>', `exclusiveMinimum: params.comparison is ">" (got ${e && e.params && e.params.comparison})`)
  assert(e && e.params && e.params.limit === 5, `exclusiveMinimum: params.limit is 5 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must be > 5', `exclusiveMinimum: message correct (got ${e && e.message})`)
}

// --- 6. exclusiveMaximum ---
console.log('\n--- exclusiveMaximum ---')
{
  const e = firstError({ type: 'number', exclusiveMaximum: 10 }, 10)
  assert(e !== null, 'exclusiveMaximum: error produced')
  assert(e && e.keyword === 'exclusiveMaximum', `exclusiveMaximum: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.comparison === '<', `exclusiveMaximum: params.comparison is "<" (got ${e && e.params && e.params.comparison})`)
  assert(e && e.params && e.params.limit === 10, `exclusiveMaximum: params.limit is 10 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must be < 10', `exclusiveMaximum: message correct (got ${e && e.message})`)
}

// --- 7. multipleOf ---
console.log('\n--- multipleOf ---')
{
  const e = firstError({ type: 'number', multipleOf: 3 }, 7)
  assert(e !== null, 'multipleOf: error produced')
  assert(e && e.keyword === 'multipleOf', `multipleOf: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.multipleOf === 3, `multipleOf: params.multipleOf is 3 (got ${e && e.params && e.params.multipleOf})`)
  assert(e && e.message === 'must be multiple of 3', `multipleOf: message correct (got ${e && e.message})`)
}

// --- 8. minLength ---
console.log('\n--- minLength ---')
{
  const e = firstError({ type: 'string', minLength: 3 }, 'ab')
  assert(e !== null, 'minLength: error produced')
  assert(e && e.keyword === 'minLength', `minLength: keyword correct (got ${e && e.keyword})`)
  assert(e && e.schemaPath === '#/minLength', `minLength: schemaPath is "#/minLength" (got ${e && e.schemaPath})`)
  assert(e && e.params && e.params.limit === 3, `minLength: params.limit is 3 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have fewer than 3 characters', `minLength: message correct (got ${e && e.message})`)
}

// --- 9. maxLength ---
console.log('\n--- maxLength ---')
{
  const e = firstError({ type: 'string', maxLength: 5 }, 'toolong')
  assert(e !== null, 'maxLength: error produced')
  assert(e && e.keyword === 'maxLength', `maxLength: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.limit === 5, `maxLength: params.limit is 5 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have more than 5 characters', `maxLength: message correct (got ${e && e.message})`)
}

// --- 10. pattern ---
console.log('\n--- pattern ---')
{
  const e = firstError({ type: 'string', pattern: '^[a-z]+$' }, 'ABC')
  assert(e !== null, 'pattern: error produced')
  assert(e && e.keyword === 'pattern', `pattern: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.pattern === '^[a-z]+$', `pattern: params.pattern correct (got ${e && e.params && e.params.pattern})`)
  assert(e && e.message === 'must match pattern "^[a-z]+$"', `pattern: message correct (got ${e && e.message})`)
}

// --- 11. format ---
console.log('\n--- format ---')
{
  const e = firstError({ type: 'string', format: 'email' }, 'notanemail')
  assert(e !== null, 'format: error produced')
  assert(e && e.keyword === 'format', `format: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.format === 'email', `format: params.format is "email" (got ${e && e.params && e.params.format})`)
  assert(e && e.message === 'must match format "email"', `format: message correct (got ${e && e.message})`)
}

// --- 12. enum ---
console.log('\n--- enum ---')
{
  const e = firstError({ enum: ['a', 'b', 'c'] }, 'd')
  assert(e !== null, 'enum: error produced')
  assert(e && e.keyword === 'enum', `enum: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && Array.isArray(e.params.allowedValues), `enum: params.allowedValues is array`)
  assert(
    e && e.params && JSON.stringify(e.params.allowedValues) === JSON.stringify(['a', 'b', 'c']),
    `enum: params.allowedValues correct (got ${e && e.params && JSON.stringify(e.params.allowedValues)})`
  )
  assert(e && e.message === 'must be equal to one of the allowed values', `enum: message correct (got ${e && e.message})`)
}

// --- 13. const ---
console.log('\n--- const ---')
{
  const e = firstError({ const: 42 }, 99)
  assert(e !== null, 'const: error produced')
  assert(e && e.keyword === 'const', `const: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.allowedValue === 42, `const: params.allowedValue is 42 (got ${e && e.params && e.params.allowedValue})`)
  assert(e && e.message === 'must be equal to constant', `const: message correct (got ${e && e.message})`)
}

// --- 14. minItems ---
console.log('\n--- minItems ---')
{
  const e = firstError({ type: 'array', minItems: 2 }, [1])
  assert(e !== null, 'minItems: error produced')
  assert(e && e.keyword === 'minItems', `minItems: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.limit === 2, `minItems: params.limit is 2 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have fewer than 2 items', `minItems: message correct (got ${e && e.message})`)
}

// --- 15. maxItems ---
console.log('\n--- maxItems ---')
{
  const e = firstError({ type: 'array', maxItems: 2 }, [1, 2, 3])
  assert(e !== null, 'maxItems: error produced')
  assert(e && e.keyword === 'maxItems', `maxItems: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.limit === 2, `maxItems: params.limit is 2 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have more than 2 items', `maxItems: message correct (got ${e && e.message})`)
}

// --- 16. uniqueItems ---
console.log('\n--- uniqueItems ---')
{
  const e = firstError({ type: 'array', uniqueItems: true }, [1, 2, 1])
  assert(e !== null, 'uniqueItems: error produced')
  assert(e && e.keyword === 'uniqueItems', `uniqueItems: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && typeof e.params.i === 'number', `uniqueItems: params.i is a number (got ${e && e.params && e.params.i})`)
  assert(e && e.params && typeof e.params.j === 'number', `uniqueItems: params.j is a number (got ${e && e.params && e.params.j})`)
  assert(e && e.message && e.message.includes('must NOT have duplicate items'), `uniqueItems: message includes "must NOT have duplicate items" (got ${e && e.message})`)
}

// --- 17. minProperties ---
console.log('\n--- minProperties ---')
{
  const e = firstError({ type: 'object', minProperties: 2 }, { a: 1 })
  assert(e !== null, 'minProperties: error produced')
  assert(e && e.keyword === 'minProperties', `minProperties: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.limit === 2, `minProperties: params.limit is 2 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have fewer than 2 properties', `minProperties: message correct (got ${e && e.message})`)
}

// --- 18. maxProperties ---
console.log('\n--- maxProperties ---')
{
  const e = firstError({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 })
  assert(e !== null, 'maxProperties: error produced')
  assert(e && e.keyword === 'maxProperties', `maxProperties: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.limit === 1, `maxProperties: params.limit is 1 (got ${e && e.params && e.params.limit})`)
  assert(e && e.message === 'must NOT have more than 1 properties', `maxProperties: message correct (got ${e && e.message})`)
}

// --- 19. additionalProperties ---
console.log('\n--- additionalProperties ---')
{
  const schema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false }
  const e = firstError(schema, { a: 1, b: 2 })
  assert(e !== null, 'additionalProperties: error produced')
  assert(e && e.keyword === 'additionalProperties', `additionalProperties: keyword correct (got ${e && e.keyword})`)
  assert(e && e.params && e.params.additionalProperty === 'b', `additionalProperties: params.additionalProperty is "b" (got ${e && e.params && e.params.additionalProperty})`)
  assert(e && e.message === 'must NOT have additional properties', `additionalProperties: message correct (got ${e && e.message})`)
}

// --- 20. nested path ---
console.log('\n--- nested path ---')
{
  const schema = {
    type: 'object',
    properties: {
      address: {
        type: 'object',
        properties: { street: { type: 'string' } },
        required: ['street']
      }
    }
  }
  const result = validate(schema, { address: {} })
  const errors = result.errors || []
  const e = errors.find(err => err.instancePath === '/address' || err.path === '/address')
  assert(!result.valid, 'nested: validation fails')
  assert(e !== null && e !== undefined, 'nested: error with /address path found')
  assert(
    e && (e.instancePath === '/address' || e.path === '/address'),
    `nested: instancePath is "/address" (got ${e && (e.instancePath || e.path)})`
  )
  assert(
    e && (e.schemaPath === '#/properties/address/required' || (e.schemaPath && e.schemaPath.includes('address'))),
    `nested: schemaPath contains address (got ${e && e.schemaPath})`
  )
}

// --- 21. array item required (instancePath must use index, not codegen expression) ---
console.log('\n--- array item required ---')
{
  const schema = {
    type: 'object',
    properties: {
      like: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      }
    }
  }
  const v = new Validator(schema, { allErrors: true })
  const result = v.validate({ like: [{}] })
  const errors = result.errors || []
  const e = errors.find(err => err.keyword === 'required' && err.params && err.params.missingProperty === 'name')
  assert(!result.valid, 'array item required: validation fails')
  assert(e !== null && e !== undefined, 'array item required: error found')
  assert(
    e && e.instancePath === '/like/0',
    `array item required: instancePath is "/like/0" (got ${e && e.instancePath})`
  )
  assert(
    e && e.schemaPath === '#/properties/like/items/required',
    `array item required: schemaPath correct (got ${e && e.schemaPath})`
  )
  assert(
    e && e.message === "must have required property 'name'",
    `array item required: message correct (got ${e && e.message})`
  )
}

{
  const schema = {
    type: 'object',
    properties: {
      like: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      }
    }
  }
  const v = new Validator(schema, { allErrors: true })
  const result = v.validate({ like: [{}, { name: 'ok' }, {}] })
  const errors = result.errors || []
  const reqErrors = errors.filter(err => err.keyword === 'required' && err.params && err.params.missingProperty === 'name')
  assert(reqErrors.length === 2, `array item required multi: 2 errors (got ${reqErrors.length})`)
  assert(
    reqErrors[0] && reqErrors[0].instancePath === '/like/0',
    `array item required multi: first error at /like/0 (got ${reqErrors[0] && reqErrors[0].instancePath})`
  )
  assert(
    reqErrors[1] && reqErrors[1].instancePath === '/like/2',
    `array item required multi: second error at /like/2 (got ${reqErrors[1] && reqErrors[1].instancePath})`
  )
}

// --- 22. dependentRequired ---
console.log('\n--- dependentRequired ---')
{
  const schema = {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    dependentRequired: { a: ['b'] }
  }
  const e = firstError(schema, { a: 1 })
  assert(e !== null, 'dependentRequired: error produced')
  assert(e && e.keyword === 'required', `dependentRequired: keyword is "required" (got ${e && e.keyword})`)
  assert(e && e.params && e.params.missingProperty === 'b', `dependentRequired: params.missingProperty is "b" (got ${e && e.params && e.params.missingProperty})`)
}

// --- 22. propertyNames minLength ---
console.log('\n--- propertyNames minLength ---')
{
  const schema = { type: 'object', propertyNames: { minLength: 3 } }
  const e = firstError(schema, { ab: 1 })
  assert(e !== null, 'propertyNames minLength: error produced')
  assert(e && e.keyword === 'minLength', `propertyNames minLength: keyword is "minLength" (got ${e && e.keyword})`)
}

// --- 23. propertyNames pattern ---
console.log('\n--- propertyNames pattern ---')
{
  const schema = { type: 'object', propertyNames: { pattern: '^[a-z]+$' } }
  const e = firstError(schema, { ABC: 1 })
  assert(e !== null, 'propertyNames pattern: error produced')
  assert(e && e.keyword === 'pattern', `propertyNames pattern: keyword is "pattern" (got ${e && e.keyword})`)
}

console.log(`\n${pass}/${pass + fail} AJV error format tests passed\n`)
process.exit(fail > 0 ? 1 : 0)
