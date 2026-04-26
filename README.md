<p align="center">
  <img src="./assets/ata-validator.svg" alt="ata-validator" width="640" />
</p>

# ata-validator

Ultra-fast JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Multi-core parallel validation, RE2 regex, codegen bytecode engine. Standard Schema V1 compatible.

**[ata-validator.com](https://ata-validator.com)** | **[API Docs](docs/API.md)** | **[Migrate from ajv](docs/migration-from-ajv.md)** | **[Framework integrations](docs/integrations/)** | **[Contributing](CONTRIBUTING.md)**

## Performance

### Simple Schema (7 properties, type + format + range + nested object)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 35ns | 101ns | **ata 2.9x faster** |
| **validate(obj)** invalid | 87ns | 183ns | **ata 2.1x faster** |
| **isValidObject(obj)** | 23ns | 101ns | **ata 4.4x faster** |
| **Schema compilation** | 8ns | 1.26ms | **ata 156,000x faster** |
| **First validation** | 42ns | 1.27ms | **ata 30,000x faster** |

### Complex Schema (patternProperties + dependentSchemas + propertyNames + additionalProperties)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 23ns | 113ns | **ata 4.9x faster** |
| **validate(obj)** invalid | 61ns | 186ns | **ata 3.0x faster** |
| **isValidObject(obj)** | 22ns | 117ns | **ata 5.4x faster** |

### Cross-Schema `$ref` (multi-schema with `$id` registry)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 18ns | 24ns | **ata 1.3x faster** |
| **validate(obj)** invalid | 28ns | 53ns | **ata 1.9x faster** |

> Measured with [mitata](https://github.com/evanwashere/mitata) on Apple M4 Pro (process-isolated). [Benchmark code](benchmark/bench_complex_mitata.mjs)

### unevaluatedProperties / unevaluatedItems

| Scenario | ata | ajv | |
|---|---|---|---|
| **Tier 1** (properties only) valid | 3.2ns | 8.8ns | **ata 2.8x faster** |
| **Tier 1** invalid | 3.6ns | 18.8ns | **ata 5.2x faster** |
| **Tier 2** (allOf) valid | 3.2ns | 10.2ns | **ata 3.2x faster** |
| **Tier 3** (anyOf) valid | 6.5ns | 21.9ns | **ata 3.4x faster** |
| **Tier 3** invalid | 7.0ns | 41.2ns | **ata 5.9x faster** |
| **unevaluatedItems** valid | 1.0ns | 5.2ns | **ata 5.3x faster** |
| **unevaluatedItems** invalid | 0.94ns | 14.1ns | **ata 15.0x faster** |
| **Compilation** | 8.6ns | 2.37ms | **ata 277,000x faster** |

Three-tier hybrid codegen: static schemas compile to zero-overhead key checks, dynamic schemas (anyOf/oneOf) use bitmask tracking with V8-inlined branch functions. [Benchmark code](benchmark/bench_unevaluated_mitata.mjs)

### vs Ecosystem (Zod, Valibot, TypeBox)

| Scenario | ata | ajv | typebox | zod | valibot |
|---|---|---|---|---|---|
| **validate (valid)** | **9ns** | 38ns | 50ns | 334ns | 326ns |
| **validate (invalid)** | **37ns** | 103ns | 4ns | 11.8μs | 842ns |
| **compilation** | **453ns** | 1.24ms | 52μs | n/a | n/a |
| **first validation** | **2.1μs** | 1.11ms | 54μs | n/a | n/a |

> Different categories: ata/ajv/typebox are JSON Schema validators, zod/valibot are schema-builder DSLs. [Benchmark code](benchmark/bench_all_mitata.mjs)

### Large Data - JS Object Validation

| Size | ata | ajv | |
|---|---|---|---|
| 10 users (2KB) | 6.2M ops/sec | 2.5M ops/sec | **ata 2.5x faster** |
| 100 users (20KB) | 658K ops/sec | 243K ops/sec | **ata 2.7x faster** |
| 1,000 users (205KB) | 64K ops/sec | 23.5K ops/sec | **ata 2.7x faster** |

### Real-World Scenarios

| Scenario | ata | ajv | |
|---|---|---|---|
| **Serverless cold start** (50 schemas) | 0.087ms | 3.67ms | **ata 42x faster** |
| **ReDoS protection** (`^(a+)+$`) | 0.3ms | 765ms | **ata immune (RE2)** |
| **Batch NDJSON** (10K items, multi-core) | 13.4M/sec | 5.1M/sec | **ata 2.6x faster** |
| **Fastify startup** (5 routes) | 0.5ms | 6.0ms | **ata 12x faster** |

> Isolated single-schema benchmarks. Results vary by workload and hardware.

### How it works

**Combined single-pass validator**: ata compiles schemas into a single function that validates and collects errors in one pass. Valid data returns `VALID_RESULT` with zero allocation. Invalid data collects errors inline with pre-allocated frozen error objects - no double validation, no try/catch (3.3x V8 deopt). Lazy compilation defers all work to first usage - constructor is near-zero cost.

**JS codegen**: Schemas are compiled to monolithic JS functions (like ajv). Full keyword support including `patternProperties`, `dependentSchemas`, `propertyNames`, `unevaluatedProperties`, `unevaluatedItems`, cross-schema `$ref` with `$id` registry, and Draft 7 auto-detection. Three-tier hybrid approach for unevaluated keywords: compile-time resolution for static schemas, bitmask tracking for dynamic ones. charCodeAt prefix matching replaces regex for simple patterns (4x faster). Merged key iteration loops (patternProperties + propertyNames + additionalProperties in a single `for..in`).

**V8 TurboFan optimizations**: Destructuring batch reads, `undefined` checks instead of `in` operator, context-aware type guard elimination, property hoisting to local variables, tiered uniqueItems (nested loop for small arrays), inline key comparison for small property sets (no Set.has overhead).

**Adaptive simdjson**: For large documents (>8KB) with selective schemas, simdjson On Demand seeks only the needed fields - skipping irrelevant data at GB/s speeds.

### $dynamicRef / $dynamicAnchor / $anchor

| Scenario | ata | ajv | |
|---|---|---|---|
| **$dynamicRef tree** valid | 23ns | 55ns | **ata 2.4x faster** |
| **$dynamicRef tree** invalid | 68ns | 80ns | **ata 1.2x faster** |
| **$dynamicRef override** valid | 2.6ns | 187ns | **ata 71x faster** |
| **$dynamicRef override** invalid | 49ns | 186ns | **ata 3.8x faster** |
| **$anchor array** valid | 2.4ns | 3.1ns | **ata 1.3x faster** |

Self-recursive named functions for $dynamicRef, compile-time cross-schema resolution, zero-wrapper hybrid path. [Benchmark code](benchmark/bench_dynamicref_vs_ajv.mjs)

### JSON Schema Test Suite

**98.5%** pass rate (1172/1190) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12), excluding remote refs and vocabulary (intentionally unsupported). **95.3%** on [@exodus/schemasafe](https://github.com/ExodusMovement/schemasafe) test suite.

## When to use ata

- **High-throughput `validate(obj)`** - 3.1x faster than ajv, 38x faster than zod
- **Complex schemas** - `patternProperties`, `dependentSchemas`, `propertyNames`, `unevaluatedProperties` all inline JS codegen
- **Multi-schema projects** - cross-schema `$ref` with `$id` registry, `addSchema()` API
- **Draft 7 migration** - auto-detects `$schema`, normalizes Draft 7 keywords transparently
- **Serverless / cold starts** - 6,904x faster compilation, 5,148x faster first validation
- **Security-sensitive apps** - RE2 regex, immune to ReDoS attacks
- **Batch/streaming validation** - NDJSON log processing, data pipelines (2.6x faster)
- **Standard Schema V1** - native support for Fastify v5, tRPC, TanStack
- **C/C++ embedding** - native library, no JS runtime needed

## When to use ajv

- **Existing ajv ecosystem** - plugins, custom keywords, large community
- **Full unevaluatedProperties/Items** - ata covers most cases but some edge cases remain

## Features

- **Hybrid validator**: 4.1x faster than ajv, up to 70x faster on $dynamicRef - zero-wrapper hybrid path for valid data (no allocation), combined codegen for error collection. Schema compilation cache for repeated schemas
- **$dynamicRef / $dynamicAnchor / $anchor**: Full Draft 2020-12 dynamic reference support. Self-recursive named functions, compile-time cross-schema resolution (42/42 spec tests)
- **Cross-schema `$ref`**: `schemas` option and `addSchema()` API. Compile-time resolution with `$id` registry, zero runtime overhead
- **Draft 7 support**: Auto-detects `$schema` field, normalizes `dependencies`/`additionalItems`/`definitions` transparently
- **Multi-core**: Parallel validation across all CPU cores - 13.4M validations/sec
- **simdjson**: SIMD-accelerated JSON parsing at GB/s speeds, adaptive On Demand for large docs
- **RE2 regex**: Linear-time guarantees, immune to ReDoS attacks (2391x faster on pathological input)
- **V8-optimized codegen**: Destructuring batch reads, type guard elimination, property hoisting
- **Standard Schema V1**: Compatible with Fastify, tRPC, TanStack, Drizzle
- **Zero-copy paths**: Buffer and pre-padded input support - no unnecessary copies
- **Defaults + coercion**: `default` values, `coerceTypes`, `removeAdditional` support
- **C/C++ library**: Native API for non-Node.js environments
- **98.5% spec compliant**: Draft 2020-12

## Installation

```bash
npm install ata-validator
```

## Usage

### Node.js

```javascript
const { Validator } = require('ata-validator');

const v = new Validator({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 },
    role: { type: 'string', default: 'user' }
  },
  required: ['name', 'email']
});

// Fast boolean check - JS codegen, 15.3M ops/sec
v.isValidObject({ name: 'Mert', email: 'mert@example.com', age: 26 }); // true

// Full validation with error details + defaults applied
const result = v.validate({ name: 'Mert', email: 'mert@example.com' });
// result.valid === true, data.role === 'user' (default applied)

// JSON string validation (simdjson fast path)
v.validateJSON('{"name": "Mert", "email": "mert@example.com"}');
v.isValidJSON('{"name": "Mert", "email": "mert@example.com"}'); // true

// Buffer input (zero-copy, raw NAPI)
v.isValid(Buffer.from('{"name": "Mert", "email": "mert@example.com"}'));

// Parallel batch - multi-core, NDJSON, 13.4M items/sec
const ndjson = Buffer.from(lines.join('\n'));
v.isValidParallel(ndjson);  // bool[]
v.countValid(ndjson);        // number
```

### Cross-Schema `$ref`

```javascript
const addressSchema = {
  $id: 'https://example.com/address',
  type: 'object',
  properties: { street: { type: 'string' }, city: { type: 'string' } },
  required: ['street', 'city']
};

const v = new Validator({
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { $ref: 'https://example.com/address' }
  }
}, { schemas: [addressSchema] });

// Or use addSchema()
const v2 = new Validator(mainSchema);
v2.addSchema(addressSchema);
```

### Options

```javascript
const v = new Validator(schema, {
  coerceTypes: true,       // "42" → 42 for integer fields
  removeAdditional: true,  // strip properties not in schema
  schemas: [otherSchema],  // cross-schema $ref registry
  abortEarly: true,        // skip detailed error collection on failure (~4x faster on invalid data)
});
```

`abortEarly` returns a shared `{ valid: false, errors: [{ message: 'validation failed' }] }` on failure instead of running the detailed error collector. Useful when the caller only needs a pass/fail decision (Fastify route guards, high-throughput gatekeepers, request rejection at the edge).

### Build-time compile (`ata compile`)

The `ata` CLI turns a JSON Schema file into a self-contained JavaScript module. No runtime dependency on `ata-validator`, so only the generated validator ships to the browser. Typical output is ~1 KB gzipped compared to ~27 KB for the full runtime.

```bash
npx ata compile schemas/user.json -o src/generated/user.validator.mjs
```

The CLI emits two files: the validator itself and a paired `.d.mts` (or `.d.cts`) with the inferred TypeScript type plus an `isValid` type predicate.

```ts
import { isValid, validate, type User } from './user.validator.mjs'

const incoming: unknown = JSON.parse(req.body)

if (isValid(incoming)) {
  // TypeScript narrows to User here
  incoming.id      // number
  incoming.role    // 'admin' | 'user' | 'guest' | undefined
}

const r = validate(incoming)
// { valid: true, errors: [] } | { valid: false, errors: ValidationError[] }
```

CLI options:

| Flag | Default | Description |
|---|---|---|
| `-o, --output <file>` | `<schema>.validator.mjs` | Output path |
| `-f, --format <fmt>` | `esm` | `esm` or `cjs` |
| `--name <TypeName>` | from filename | Root type name in the `.d.ts` |
| `--abort-early` | off | Generate the stub-error variant (~0.5 KB gzipped) |
| `--no-types` | off | Skip the `.d.mts` / `.d.cts` output |

Typical bundle sizes (10-field user schema, gzipped):

| Variant | Size | Notes |
|---|---|---|
| `ata-validator` runtime | ~27 KB | Full compiler + all keywords |
| `ata compile` (standard) | **~1.1 KB** | Validator + detailed error collector |
| `ata compile --abort-early` | **~0.5 KB** | Validator + stub errors only |

Programmatic API if you prefer to script it:

```javascript
const fs = require('fs');
const { Validator } = require('ata-validator');

const v = new Validator(schema);
fs.writeFileSync('./user.validator.mjs', v.toStandaloneModule({ format: 'esm' }));
```

**Fastify startup (10 routes cold): ajv 12.6ms → ata 0.5ms (24x faster boot, no build step required)**

### Standard Schema V1

```javascript
const v = new Validator(schema);

// Works with Fastify, tRPC, TanStack, etc.
const result = v['~standard'].validate(data);
// { value: data } on success
// { issues: [{ message, path }] } on failure
```

### Fastify Plugin

```bash
npm install fastify-ata
```

```javascript
const fastify = require('fastify')();
fastify.register(require('fastify-ata'), {
  coerceTypes: true,
  removeAdditional: true,
});

// All existing JSON Schema route definitions work as-is
```

### C++

```cpp
#include "ata.h"

auto schema = ata::compile(R"({
  "type": "object",
  "properties": { "name": {"type": "string"} },
  "required": ["name"]
})");

auto result = ata::validate(schema, R"({"name": "Mert"})");
// result.valid == true
```

## Framework integrations

Copy-paste recipes for the common frameworks. Most need 10-20 lines of glue. See [docs/integrations](docs/integrations/) for the full set.

| Framework | Pattern | Recipe |
|---|---|---|
| Fastify | dedicated plugin | [`fastify-ata`](https://github.com/ata-core/fastify-ata) |
| Vite (build-time compile) | dedicated plugin | [`ata-vite`](https://github.com/ata-core/ata-vite) |
| Hono | async middleware | [docs/integrations/hono.md](docs/integrations/hono.md) |
| Elysia | direct handler check | [docs/integrations/elysia.md](docs/integrations/elysia.md) |
| tRPC | Standard Schema V1 input | [docs/integrations/trpc.md](docs/integrations/trpc.md) |
| TanStack Form | Standard Schema V1 validator | [docs/integrations/tanstack-form.md](docs/integrations/tanstack-form.md) |
| Express | sync middleware | [docs/integrations/express.md](docs/integrations/express.md) |
| Koa | async ctx middleware | [docs/integrations/koa.md](docs/integrations/koa.md) |
| NestJS | validation pipe | [docs/integrations/nestjs.md](docs/integrations/nestjs.md) |
| SvelteKit | form action, API route | [docs/integrations/sveltekit.md](docs/integrations/sveltekit.md) |
| Astro | API route, server action | [docs/integrations/astro.md](docs/integrations/astro.md) |

## Supported Keywords

| Category | Keywords |
|----------|----------|
| Type | `type` |
| Numeric | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| String | `minLength`, `maxLength`, `pattern`, `format` |
| Array | `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `unevaluatedItems` |
| Object | `properties`, `required`, `additionalProperties`, `patternProperties`, `minProperties`, `maxProperties`, `propertyNames`, `dependentRequired`, `dependentSchemas`, `unevaluatedProperties` |
| Enum/Const | `enum`, `const` |
| Composition | `allOf`, `anyOf`, `oneOf`, `not` |
| Conditional | `if`, `then`, `else` |
| References | `$ref`, `$defs`, `definitions`, `$id` |
| Boolean | `true`, `false` |

### Format Validators (hand-written, no regex)

`email`, `date`, `date-time`, `time`, `uri`, `uri-reference`, `ipv4`, `ipv6`, `uuid`, `hostname`

## Building from Source

### Development prerequisites

Native builds require C/C++ toolchain support and the following libraries:

- `re2`
- `abseil`
- `mimalloc`

Install them before running `npm install` / `npm run build`:

```bash
# macOS (Homebrew)
brew install re2 abseil mimalloc
```

```bash
# Ubuntu/Debian (apt)
sudo apt-get update
sudo apt-get install -y libre2-dev libabsl-dev libmimalloc-dev
```

```bash
# C++ library + tests
cmake -B build
cmake --build build
./build/ata_tests

# Node.js addon
npm install
npm run build
npm test

# JSON Schema Test Suite
npm run test:suite
```

## License

MIT

## Authors

[Mert Can Altin](https://github.com/mertcanaltin)
[Daniel Lemire](https://github.com/lemire)
