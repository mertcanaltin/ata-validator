#!/usr/bin/env node
'use strict'

/**
 * ata-validator Fastify integration example.
 *
 * Drop-in replacement for Fastify's default ajv validator.
 * Uses setValidatorCompiler — the standard Fastify extension point.
 *
 * Usage:
 *   node examples/fastify-plugin.js
 *   curl -X POST http://localhost:3000/users \
 *     -H 'content-type: application/json' \
 *     -d '{"id":1,"name":"alice","email":"a@b.com","active":true}'
 */

const Fastify = require('fastify')
const { Validator } = require('../index')

// ata validator compiler for Fastify
function ataValidatorCompiler({ schema }) {
  const v = new Validator(schema)
  return function validate(data) {
    const result = v.validate(data)
    if (result.valid) return { value: data }
    // Map to Fastify's expected error shape
    const error = new Error(result.errors.map(e => e.message).join(', '))
    error.validation = result.errors
    return { error }
  }
}

// Demo app
async function main() {
  const app = Fastify({ logger: true })

  // Replace ajv with ata
  app.setValidatorCompiler(ataValidatorCompiler)

  // Route with schema validation
  app.post('/users', {
    schema: {
      body: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          email: { type: 'string' },
          active: { type: 'boolean' },
        },
        required: ['id', 'name', 'email'],
      },
    },
  }, async (req) => {
    return { ok: true, user: req.body }
  })

  app.post('/products', {
    schema: {
      body: {
        type: 'object',
        properties: {
          sku: { type: 'string', minLength: 3, maxLength: 20 },
          price: { type: 'number', minimum: 0 },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['sku', 'price'],
      },
    },
  }, async (req) => {
    return { ok: true, product: req.body }
  })

  await app.listen({ port: 3000 })
  console.log('\nTest with:')
  console.log('  curl -s -X POST http://localhost:3000/users \\')
  console.log('    -H "content-type: application/json" \\')
  console.log('    -d \'{"id":1,"name":"alice","email":"a@b.com","active":true}\'')
  console.log('')
  console.log('  curl -s -X POST http://localhost:3000/users \\')
  console.log('    -H "content-type: application/json" \\')
  console.log('    -d \'{"id":"bad","name":""}\'')
}

main().catch(console.error)
