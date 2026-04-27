'use strict'

// Targeted regression tests for the schema-driven byte scanner introduced
// in src/ata.cpp. These exercise edge cases the JSON Schema test suite and
// fuzz_differential.js do not cover (long keys, root type_mask mismatch,
// boundary-length keys).

const { Validator } = require('../index')

let pass = 0
let fail = 0

function check(label, got, expected) {
  if (got === expected) {
    console.log('  PASS', label)
    pass++
  } else {
    console.log('  FAIL', label, '\n    expected', expected, 'got', got)
    fail++
  }
}

function asBuffer(obj, padTo = 32) {
  let s = JSON.stringify(obj)
  while (s.length < padTo) s += ' '
  return Buffer.from(s)
}

console.log('Scanner regression tests')

// --- Bug 1: speculation false-match on long-key entries ------------------
// When both schema entry and JSON key are >8 bytes ASCII, the inline key
// cache is empty (key_first8 = 0) for both. Speculative dispatch must not
// treat hk[next_idx] == 0 == key_first8 as a valid match — it has to fall
// through to the long-key fallback.
{
  const schema = {
    type: 'object',
    properties: {
      thisisalongkey1: { type: 'integer' },
      thisisalongkey2: { type: 'string' },
    },
    required: ['thisisalongkey1', 'thisisalongkey2'],
  }
  const v = new Validator(schema)

  check(
    'long keys, declaration order, valid types',
    v.isValid(asBuffer({ thisisalongkey1: 1, thisisalongkey2: 'foo' })),
    true,
  )
  check(
    'long keys, REVERSE order, valid types',
    v.isValid(asBuffer({ thisisalongkey2: 'foo', thisisalongkey1: 1 })),
    true,
  )
  check(
    'long keys, reverse order, swapped types (must fail)',
    v.isValid(asBuffer({ thisisalongkey2: 1, thisisalongkey1: 'foo' })),
    false,
  )
}

// --- Bug 2: root type_mask not validated ---------------------------------
// A schema can have `properties` (which sets plan.object) and a non-object
// `type`. The scanner must not accept a {-shaped payload as valid in that
// case — it has to fall through to the on-demand path so type_mask is
// honored.
{
  const schema = {
    type: 'string',
    properties: { x: { type: 'integer' } },
  }
  const v = new Validator(schema)
  check(
    'type:string + properties, object payload (must fail)',
    v.isValid(asBuffer({ x: 1 })),
    false,
  )
}
{
  const schema = {
    type: 'array',
    properties: { x: { type: 'integer' } },
  }
  const v = new Validator(schema)
  check(
    'type:array + properties, object payload (must fail)',
    v.isValid(asBuffer({ x: 1 })),
    false,
  )
}

// --- Boundary: 8-char keys -----------------------------------------------
// 8 bytes is the inline-cache boundary. Make sure the scanner agrees with
// the on-demand path for keys at exactly that length.
{
  const schema = {
    type: 'object',
    properties: {
      eightchr: { type: 'integer' },
      another8: { type: 'string' },
    },
    required: ['eightchr', 'another8'],
  }
  const v = new Validator(schema)
  check(
    '8-char keys, declaration order',
    v.isValid(asBuffer({ eightchr: 1, another8: 'foo' })),
    true,
  )
  check(
    '8-char keys, reverse order',
    v.isValid(asBuffer({ another8: 'foo', eightchr: 1 })),
    true,
  )
  check(
    '8-char keys, type mismatch',
    v.isValid(asBuffer({ eightchr: 'not an int', another8: 'foo' })),
    false,
  )
}

// --- Mixed short + long key entries --------------------------------------
{
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'integer' },
      thisisalongone: { type: 'string' },
      bb: { type: 'boolean' },
    },
    required: ['a', 'thisisalongone', 'bb'],
  }
  const v = new Validator(schema)
  check(
    'mixed short+long keys, declaration order',
    v.isValid(asBuffer({ a: 1, thisisalongone: 'x', bb: true })),
    true,
  )
  check(
    'mixed short+long keys, reverse order',
    v.isValid(asBuffer({ bb: true, thisisalongone: 'x', a: 1 })),
    true,
  )
  check(
    'mixed short+long keys, missing required long key',
    v.isValid(asBuffer({ a: 1, bb: true })),
    false,
  )
}

console.log()
console.log(`${pass}/${pass + fail} tests passed`)
process.exit(fail === 0 ? 0 : 1)
