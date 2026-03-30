# ata-validator

Ultra-fast JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Multi-core parallel validation, RE2 regex, codegen bytecode engine. Standard Schema V1 compatible.

**[ata-validator.com](https://ata-validator.com)** | **[API Docs](docs/API.md)** | **[Contributing](CONTRIBUTING.md)**

## Performance

### Simple Schema (5 properties, type + format + range checks)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 58ns | 101ns | **ata 1.7x faster** |
| **validate(obj)** invalid | 78ns | 109ns | **ata 1.4x faster** |
| **isValidObject(obj)** | 28ns | 101ns | **ata 3.6x faster** |
| **Schema compilation** | 677ns | 1.28ms | **ata 1,888x faster** |
| **First validation** | 1.70μs | 1.18ms | **ata 693x faster** |

### Complex Schema (patternProperties + dependentSchemas + propertyNames + additionalProperties)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 26ns | 113ns | **ata 4.4x faster** |
| **validate(obj)** invalid | 53ns | 195ns | **ata 3.7x faster** |
| **isValidObject(obj)** | 20ns | 117ns | **ata 5.8x faster** |

### Cross-Schema `$ref` (multi-schema with `$id` registry)

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 17ns | 25ns | **ata 1.5x faster** |
| **validate(obj)** invalid | 34ns | 54ns | **ata 1.6x faster** |

> Measured with [mitata](https://github.com/evanwashere/mitata) on Apple M4 Pro (process-isolated). [Benchmark code](benchmark/bench_complex_mitata.mjs)

### vs Ecosystem (Zod, Valibot, TypeBox)

| Scenario | ata | ajv | typebox | zod | valibot |
|---|---|---|---|---|---|
| **validate (valid)** | **13ns** | 37ns | 48ns | 328ns | 316ns |
| **validate (invalid)** | **35ns** | 104ns | 4ns | 11.7μs | 838ns |
| **compilation** | **533ns** | 1.14ms | 52μs | — | — |
| **first validation** | **1.3μs** | 1.07ms | 53μs | — | — |

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
| **Serverless cold start** (50 schemas) | 0.1ms | 23ms | **ata 242x faster** |
| **ReDoS protection** (`^(a+)+$`) | 0.3ms | 765ms | **ata immune (RE2)** |
| **Batch NDJSON** (10K items, multi-core) | 13.4M/sec | 5.1M/sec | **ata 2.6x faster** |
| **Fastify startup** (5 routes) | 0.5ms | 6.0ms | **ata 12x faster** |

> Isolated single-schema benchmarks. Results vary by workload and hardware.

### How it works

**Combined single-pass validator**: ata compiles schemas into a single function that validates and collects errors in one pass. Valid data returns `VALID_RESULT` with zero allocation. Invalid data collects errors inline with pre-allocated frozen error objects - no double validation, no try/catch (3.3x V8 deopt). Lazy compilation defers all work to first usage - constructor is near-zero cost.

**JS codegen**: Schemas are compiled to monolithic JS functions (like ajv). Full keyword support including `patternProperties`, `dependentSchemas`, `propertyNames`, cross-schema `$ref` with `$id` registry, and Draft 7 auto-detection. charCodeAt prefix matching replaces regex for simple patterns (4x faster). Merged key iteration loops (patternProperties + propertyNames + additionalProperties in a single `for..in`).

**V8 TurboFan optimizations**: Destructuring batch reads, `undefined` checks instead of `in` operator, context-aware type guard elimination, property hoisting to local variables, tiered uniqueItems (nested loop for small arrays), inline key comparison for small property sets (no Set.has overhead).

**Adaptive simdjson**: For large documents (>8KB) with selective schemas, simdjson On Demand seeks only the needed fields - skipping irrelevant data at GB/s speeds.

### JSON Schema Test Suite

**98.4%** pass rate (937/952) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12).

## When to use ata

- **High-throughput `validate(obj)`** - 4.4x faster than ajv on complex schemas, 26x faster than zod
- **Complex schemas** - `patternProperties`, `dependentSchemas`, `propertyNames` all inline JS codegen (5.8x faster than ajv)
- **Multi-schema projects** - cross-schema `$ref` with `$id` registry, `addSchema()` API
- **Draft 7 migration** - auto-detects `$schema`, normalizes Draft 7 keywords transparently
- **Serverless / cold starts** - 1,888x faster compilation, 693x faster first validation
- **Security-sensitive apps** - RE2 regex, immune to ReDoS attacks
- **Batch/streaming validation** - NDJSON log processing, data pipelines (2.6x faster)
- **Standard Schema V1** - native support for Fastify v5, tRPC, TanStack
- **C/C++ embedding** - native library, no JS runtime needed

## When to use ajv

- **100% spec compliance needed** - ajv covers more edge cases (ata: 98.4%)
- **`$dynamicRef` / `unevaluatedProperties`** - not yet supported in ata

## Features

- **Single-pass validator**: 4.4x faster than ajv valid, 3.7x faster invalid - combined codegen with pre-allocated errors. No double pass, no try/catch. Schema compilation cache for repeated schemas
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
- **98.4% spec compliant**: Draft 2020-12

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
});
```

### Standalone Pre-compilation

Pre-compile schemas to JS files for near-zero startup. No native addon needed at runtime.

```javascript
const fs = require('fs');

// Build phase (once)
const v = new Validator(schema);
fs.writeFileSync('./compiled.js', v.toStandalone());

// Read phase (every startup) - 0.6μs per schema, pure JS
const v2 = Validator.fromStandalone(require('./compiled.js'), schema);

// Bundle multiple schemas - deduplicated, single file
fs.writeFileSync('./bundle.js', Validator.bundleCompact(schemas));
const validators = Validator.loadBundle(require('./bundle.js'), schemas);
```

**Fastify startup (5 routes): ajv 6.0ms → ata 0.5ms (12x faster, no build step needed)**

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

## Supported Keywords

| Category | Keywords |
|----------|----------|
| Type | `type` |
| Numeric | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| String | `minLength`, `maxLength`, `pattern`, `format` |
| Array | `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains` |
| Object | `properties`, `required`, `additionalProperties`, `patternProperties`, `minProperties`, `maxProperties`, `propertyNames`, `dependentRequired`, `dependentSchemas` |
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
