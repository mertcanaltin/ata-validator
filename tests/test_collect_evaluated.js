const { collectEvaluated } = require('../lib/js-compiler')

let pass = 0, fail = 0
function assert(desc, actual, expected) {
  const aStr = JSON.stringify(actual)
  const eStr = JSON.stringify(expected)
  if (aStr === eStr) { pass++; return }
  fail++
  console.log(`FAIL: ${desc}`)
  console.log(`  expected: ${eStr}`)
  console.log(`  actual:   ${aStr}`)
}

// Tier 1: properties only
let r = collectEvaluated({
  properties: { foo: { type: 'string' }, bar: { type: 'number' } },
  unevaluatedProperties: false
})
assert('properties only — props', r.props.sort(), ['bar', 'foo'])
assert('properties only — dynamic', r.dynamic, false)

// Tier 1: allOf with properties
r = collectEvaluated({
  properties: { a: {} },
  allOf: [{ properties: { b: {} } }, { properties: { c: {} } }],
  unevaluatedProperties: false
})
assert('allOf merge — props', r.props.sort(), ['a', 'b', 'c'])
assert('allOf merge — dynamic', r.dynamic, false)

// Tier 1: $ref inlined
r = collectEvaluated({
  $defs: { x: { properties: { refProp: {} } } },
  allOf: [{ $ref: '#/$defs/x' }],
  properties: { local: {} },
  unevaluatedProperties: false
})
assert('$ref merge — has refProp', r.props.includes('refProp'), true)
assert('$ref merge — has local', r.props.includes('local'), true)

// Tier 2: additionalProperties true → all evaluated
r = collectEvaluated({
  properties: { foo: {} },
  additionalProperties: true,
  unevaluatedProperties: false
})
assert('additionalProperties true — allProps', r.allProps, true)

// Tier 3: anyOf → dynamic
r = collectEvaluated({
  anyOf: [{ properties: { x: {} } }, { properties: { y: {} } }],
  unevaluatedProperties: false
})
assert('anyOf — dynamic', r.dynamic, true)
assert('anyOf — still collects props', r.props.sort(), ['x', 'y'])

// Tier 3: patternProperties → dynamic
r = collectEvaluated({
  patternProperties: { '^s_': { type: 'string' } },
  unevaluatedProperties: false
})
assert('patternProperties — dynamic', r.dynamic, true)

// if/then/else → dynamic
r = collectEvaluated({
  if: { properties: { foo: {} } },
  then: { properties: { bar: {} } },
  else: { properties: { baz: {} } },
  unevaluatedProperties: false
})
assert('if/then/else — dynamic', r.dynamic, true)
assert('if/then/else — collects all branch props', r.props.sort(), ['bar', 'baz', 'foo'])

// not → contributes nothing
r = collectEvaluated({
  properties: { a: {} },
  not: { properties: { b: {} } },
  unevaluatedProperties: false
})
assert('not — does not contribute', r.props, ['a'])
assert('not — not dynamic', r.dynamic, false)

// standalone if (no then/else) → contributes nothing
r = collectEvaluated({
  if: { properties: { foo: {} } },
  unevaluatedProperties: false
})
assert('standalone if — no contribution', r.props, [])
assert('standalone if — not dynamic', r.dynamic, false)

// items/prefixItems tracking
r = collectEvaluated({
  prefixItems: [{ type: 'string' }, { type: 'number' }],
  unevaluatedItems: false
})
assert('prefixItems — items count', r.items, 2)
assert('prefixItems — not dynamic', r.dynamic, false)

// items: schema → all items evaluated
r = collectEvaluated({
  items: { type: 'string' },
  unevaluatedItems: false
})
assert('items schema — allItems', r.allItems, true)

// allOf merges max prefixItems
r = collectEvaluated({
  prefixItems: [{ type: 'string' }],
  allOf: [{ prefixItems: [true, { type: 'number' }, { type: 'boolean' }] }],
  unevaluatedItems: false
})
assert('allOf prefixItems — max items', r.items, 3)

// dependentSchemas → dynamic
r = collectEvaluated({
  properties: { foo: {} },
  dependentSchemas: { foo: { properties: { bar: {} } } },
  unevaluatedProperties: false
})
assert('dependentSchemas — dynamic', r.dynamic, true)
assert('dependentSchemas — collects props', r.props.sort(), ['bar', 'foo'])

// nested unevaluatedProperties: true → allProps
r = collectEvaluated({
  properties: { foo: {} },
  allOf: [{ unevaluatedProperties: true }],
  unevaluatedProperties: false
})
assert('nested unevaluatedProperties:true — allProps', r.allProps, true)

console.log(`\ncollectEvaluated: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
