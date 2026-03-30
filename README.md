# ata-validator

Ultra-fast JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Multi-core parallel validation, RE2 regex, codegen bytecode engine. Standard Schema V1 compatible.

**[ata-validator.com](https://ata-validator.com)** | **[API Docs](docs/API.md)** | **[Contributing](CONTRIBUTING.md)**

## Performance

### Single-Document Validation

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** valid | 16.6M ops/sec | 9.8M ops/sec | **ata 1.7x faster** |
| **validate(obj)** invalid | 10.0M ops/sec | 5.6M ops/sec | **ata 1.8x faster** |
| **isValidObject(obj)** | 36.0M ops/sec | 9.4M ops/sec | **ata 3.8x faster** |
| **Schema compilation** | 1.6M ops/sec | 781 ops/sec | **ata 2,067x faster** |
| **First validation** | 614K ops/sec | 775 ops/sec | **ata 793x faster** |

> Measured with [mitata](https://github.com/evanwashere/mitata) (process-isolated). Results vary by workload and hardware.

### vs typebox 1.x (with format: 'email')

| Scenario | ata | typebox | |
|---|---|---|---|
| **isValidObject(obj)** valid | 90.9M ops/sec | 18.2M ops/sec | **ata 5.0x faster** |
| **isValidObject(obj)** invalid | 435M ops/sec | 169M ops/sec | **ata 2.6x faster** |
| **Schema compilation** | 2.0M ops/sec | 18.5K ops/sec | **ata 110x faster** |
| **First validation** | 1.55M ops/sec | 18.2K ops/sec | **ata 85x faster** |

> typebox 1.x is JSON Schema compliant with RFC format support. [Benchmark code](benchmark/bench_vs_typebox_esm.mjs)

### vs ecosystem (Zod, Valibot, TypeBox)

| Scenario | ata | ajv | typebox | zod | valibot |
|---|---|---|---|---|---|
| **Simple schema** | **12ns** | 37ns | 47ns | 430ns | 304ns |
| **Complex schema** (nested + array + pattern) | **26ns** | 51ns | 72ns | 471ns | 683ns |

> Different categories: ata/typebox are JSON Schema validators, zod/valibot are schema-builder DSLs. [Benchmark code](benchmark/bench_vs_ecosystem.mjs)

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

**Combined single-pass validator**: ata compiles schemas into a single function that validates and collects errors in one pass. Valid data returns `VALID_RESULT` with zero allocation. Invalid data collects errors inline - no double validation, no try/catch (3.3x V8 deopt). Lazy compilation defers all work to first usage - constructor is near-zero cost.

**JS codegen**: Schemas are compiled to monolithic JS functions (like ajv). Supported keywords: `type`, `required`, `properties`, `items`, `enum`, `const`, `allOf`, `anyOf`, `oneOf`, `not`, `if/then/else`, `uniqueItems`, `contains`, `prefixItems`, `additionalProperties`, `dependentRequired`, `$ref` (local), `minimum/maximum`, `minLength/maxLength`, `pattern`, `format`.

**V8 TurboFan optimizations**: Destructuring batch reads, `undefined` checks instead of `in` operator, context-aware type guard elimination, property hoisting to local variables, tiered uniqueItems (nested loop for small arrays).

**Adaptive simdjson**: For large documents (>8KB) with selective schemas, simdjson On Demand seeks only the needed fields - skipping irrelevant data at GB/s speeds.

### JSON Schema Test Suite

**98.4%** pass rate (937/952) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12).

## When to use ata

- **High-throughput `validate(obj)`** - 16.6M ops/sec valid, 10.0M ops/sec invalid
- **Serverless / cold starts** - 2,067x faster compilation, 793x faster first validation
- **Security-sensitive apps** - RE2 regex, immune to ReDoS attacks
- **Batch/streaming validation** - NDJSON log processing, data pipelines (2.6x faster)
- **Standard Schema V1** - native support for Fastify v5, tRPC, TanStack
- **C/C++ embedding** - native library, no JS runtime needed

## When to use ajv

- **Schemas with `patternProperties`, `dependentSchemas`** - these bypass JS codegen and hit the slower NAPI path
- **100% spec compliance needed** - ajv covers more edge cases (ata: 98.4%)

## Features

- **Hybrid validator**: 16.6M ops/sec valid, 10.0M ops/sec invalid - codegen + single-pass error collection. No try/catch, no double pass. Schema compilation cache for repeated schemas
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

### Options

```javascript
const v = new Validator(schema, {
  coerceTypes: true,       // "42" → 42 for integer fields
  removeAdditional: true,  // strip properties not in schema
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
