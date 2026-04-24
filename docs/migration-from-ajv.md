# Migrating from ajv to ata-validator

This guide covers the common patterns when moving an existing `ajv` codebase to `ata-validator`. Both libraries validate against the same JSON Schema specification, so the migration is mostly a matter of swapping imports and adjusting the return shapes.

The goal here is a low-friction switch. Pick the sections that apply to your codebase and ignore the rest.

## Who this is for

- You have a Node.js project using `ajv` (or `@fastify/ajv-compiler`) for request / response / message validation.
- Your schemas are JSON Schema Draft 2020-12 or Draft 7.
- You want either (a) a runtime-competitive drop-in, (b) a smaller browser bundle, or (c) TypeScript types generated from your schemas.

If your codebase relies on ajv-specific features like custom keywords, custom formats beyond the built-in set, or the plugin ecosystem (`ajv-errors`, `ajv-i18n`, `ajv-keywords`), check the [Differences](#differences) section before committing.

## Install

```bash
npm install ata-validator
```

The native addon is optional. Pure JS codegen works without it. For simdjson-backed buffer APIs (`isValid(buffer)`, `countValid(ndjson)`), a platform prebuild or a local `cmake-js` build is needed. Most platforms ship with prebuilds.

## The core switch

### Before (ajv)

```js
const Ajv = require('ajv')
const ajv = new Ajv()

const validate = ajv.compile({
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 }
  },
  required: ['id', 'name']
})

if (validate(data)) {
  // data is valid
} else {
  console.log(validate.errors)
}
```

### After (ata)

```js
const { Validator } = require('ata-validator')

const v = new Validator({
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 }
  },
  required: ['id', 'name']
})

const result = v.validate(data)
if (result.valid) {
  // data is valid
} else {
  console.log(result.errors)
}
```

Key differences:

- `ajv.compile(schema)` returns a function; `new Validator(schema)` returns an instance.
- ata's `v.validate(data)` returns `{ valid, errors }` directly. No `validate.errors` side-channel.
- For a raw boolean check (no error allocation on failure), use `v.isValidObject(data)`.

## Drop-in shim

If you need the ajv-style API verbatim (for a gradual migration or a third-party library that expects it), use the compat subpath:

```js
// Was:
const Ajv = require('ajv')

// Now:
const Ajv = require('ata-validator/compat')

// Everything else stays the same:
const ajv = new Ajv()
const validate = ajv.compile(schema)
if (validate(data)) { ... } else { console.log(validate.errors) }
```

`ata-validator/compat` implements the ajv surface area used in most production code (compile, addSchema, getSchema, validate). Error shapes match ajv's format (`keyword`, `instancePath`, `schemaPath`, `params`, `message`).

## Common patterns

### Single schema, many validations

**ajv:**
```js
const validate = ajv.compile(schema)
for (const item of batch) {
  if (!validate(item)) throw new Error('invalid')
}
```

**ata:**
```js
const v = new Validator(schema)
for (const item of batch) {
  if (!v.isValidObject(item)) throw new Error('invalid')
}
```

`isValidObject` is the boolean-only hot path. On the second call tier 0 schemas automatically upgrade to the codegen path.

### Accumulating all errors vs fail-fast

ajv defaults to fail-fast. `new Ajv({ allErrors: true })` collects every error.

ata defaults to collecting every error. `new Validator(schema, { abortEarly: true })` skips detailed error collection on failure and returns a shared stub result. On a 10-property schema the invalid path drops from about 15 ns/op to 3.7 ns/op.

```js
const v = new Validator(schema, { abortEarly: true })
const r = v.validate(badInput)
// r === { valid: false, errors: [{ message: 'validation failed' }] }
```

### Type coercion and default values

ajv: `new Ajv({ coerceTypes: true, useDefaults: true, removeAdditional: true })`

ata:

```js
const v = new Validator(schema, {
  coerceTypes: true,
  removeAdditional: true,
})
```

Default values declared via `default` in a schema are applied automatically by `validate(data)` when they are absent.

### Multiple schemas and `$ref`

**ajv:**
```js
const ajv = new Ajv()
ajv.addSchema(addressSchema, 'address')
ajv.addSchema({ ...userSchema, $ref: 'address' })
```

**ata:**
```js
const v = new Validator(userSchema, {
  schemas: [addressSchema],  // addressSchema must have $id
})
// or later
v.addSchema(addressSchema)
```

Cross-schema `$ref` resolves at compile time using the `$id` registry. No runtime lookup cost.

### Draft 7

Draft 7 schemas are auto-detected via `$schema` and normalized to Draft 2020-12 equivalents (`definitions` -> `$defs`, array-form `items` -> `prefixItems`, etc). No manual conversion needed.

### JSON string input

**ajv:** `validate(JSON.parse(jsonStr))`

**ata:** either the same, or:

```js
v.validateJSON(jsonStr)    // returns { valid, errors }
v.isValidJSON(jsonStr)     // returns boolean
```

`validateJSON` uses simdjson above 8 KB and V8's `JSON.parse` below.

### Buffer input (native addon)

Something ajv cannot do: validate a raw `Buffer` without materializing a JS object tree.

```js
v.isValid(bodyBuffer)        // simdjson SIMD validation, returns boolean
v.validateAndParse(buffer)   // parse + validate in one pass, returns { valid, value, errors }
v.countValid(ndjsonBuffer)   // parallel multi-core, NDJSON
```

Useful for proxies, webhook gatekeepers, NDJSON ingest pipelines.

## Error format

ata errors follow the ajv schema, so error handling code usually needs no changes.

```js
{
  keyword: 'required',
  instancePath: '/user',
  schemaPath: '#/properties/user/required',
  params: { missingProperty: 'email' },
  message: "must have required property 'email'"
}
```

Messages match ajv's wording for the common keywords. If your tests snapshot messages, run them against ata to catch any string-level differences.

## Fastify

Replace the default ajv-based validator with `fastify-ata`:

```bash
npm install fastify-ata
```

```js
const fastify = require('fastify')()

fastify.register(require('fastify-ata'), {
  coerceTypes: true,
  removeAdditional: true,
  abortEarly: true,   // optional, for high-throughput public endpoints
})

// Every existing schema-driven route works unchanged.
```

On serverless cold start (10 routes, first request after boot), the plugin registers in about 0.5 ms versus ~12 ms for the default ajv pipeline.

## Standard Schema V1

ata implements Standard Schema V1 natively, so it plugs into Fastify v5's Standard Schema support, tRPC, TanStack Form, and Drizzle without an adapter.

```js
const v = new Validator(schema)

const result = v['~standard'].validate(value)
// { value } on success, { issues: [...] } on failure
```

## Build-time compile (new, no ajv equivalent)

If the schema is known at build time (OpenAPI spec, JSON Schema Store, static forms), ata can pre-compile it into a self-contained module so the runtime bundle does not need the full ata-validator codebase.

```bash
npx ata compile schemas/user.json -o src/user.validator.mjs --name User
```

Output:

- `src/user.validator.mjs` - about 1 KB gzipped
- `src/user.validator.d.mts` - TypeScript declarations, `isValid` is a type predicate

Usage:

```ts
import { isValid, type User } from './user.validator.mjs'

if (isValid(data)) {
  // data is narrowed to User here
}
```

The generated file has zero runtime dependency on `ata-validator`. For browser / edge deployments (Cloudflare Workers, Vercel Edge) this drops validator-related bundle weight from roughly 27 KB gzipped down to 1 KB.

## Performance expectations

These numbers are from M4 Pro / Node 25. Run-to-run variance is about +/- 5%.

| Scenario | ajv | ata | Honest delta |
|---|---|---|---|
| Warm path, simple schema (S1) | ~9 ns | ~9 ns | tied |
| Warm path, 10 fields (S2) | ~18 ns | ~19 ns | tied |
| Invalid with `abortEarly` | ~15 ns | ~4 ns | 4x faster |
| Serverless cold start (10 Fastify routes) | 12 ms | 0.5 ms | 24x faster |
| Fastify HTTP throughput | ~70k req/s | ~70k req/s | tied |
| JSON Schema Test Suite | ~98% | 98.5% | parity |

Pure warm-path validation is essentially tied with ajv. The measurable wins for most projects are on cold start, bundle size, and the invalid path. Do not migrate expecting a throughput boost on a classic long-running server; the HTTP stack dominates.

## Differences

Things that work slightly differently or are not yet supported:

- **Custom keywords**: ata does not have a custom-keyword plugin API. If your ajv code registers custom keywords, keep those validations in application code for now.
- **Custom formats**: the built-in format set is `email`, `date`, `date-time`, `time`, `uri`, `uri-reference`, `ipv4`, `ipv6`, `uuid`, `hostname`. Custom formats via `ajv-formats` are not supported.
- **`$data` references**: not supported.
- **`uniqueItems` with objects**: supported, uses `JSON.stringify` for content comparison.
- **`unevaluatedProperties` / `unevaluatedItems`**: supported for the common cases (properties-only, allOf, anyOf with bitmask tracking). A few spec edge cases are flagged in the test suite output.

If you rely on any of the unsupported items, file an issue at [github.com/ata-core/ata-validator](https://github.com/ata-core/ata-validator/issues) with a minimal schema.

## FAQ

**Do I need the native addon?**
No. The pure JS codegen path handles `validate`, `isValidObject`, `validateJSON` without any native code. The simdjson path (`isValid(buffer)`, `countValid`) requires the native addon. Every major platform has a prebuild on npm.

**Can I run both validators side by side during migration?**
Yes. `ata-validator/compat` is an ajv-shaped subpath that coexists with the real `ajv` package if you need parallel verification.

**What about Bun / Deno / Workers?**
Pure JS path works on Bun and Deno today. Cloudflare Workers and other edge runtimes are best served by the `ata compile` build-time output, which has no native dependency.

**Why is warm-path performance tied with ajv?**
Both libraries emit JavaScript code that V8's JIT optimizes aggressively. The number of machine instructions for validating a 10-field object is close to the physical floor. ata focuses its wins on scenarios where that floor is not the dominant cost: cold start, bundle size, invalid-path throughput, and buffer input.

**Should I commit the `ata compile` output to git?**
Either way works. If schemas change rarely, commit the generated files and skip the CLI in CI. If schemas change often, run `ata compile` as part of `npm run build` and gitignore the output.
