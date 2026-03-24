# ata-validator

Ultra-fast JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Multi-core parallel validation, RE2 regex, codegen bytecode engine. Standard Schema V1 compatible.

**[ata-validator.com](https://ata-validator.com)**

## Performance

### Where ata wins

| Scenario | ata | ajv | |
|---|---|---|---|
| **Schema compilation** | 119,735 ops/sec | 837 ops/sec | **ata 143x faster** |
| **isValidObject(obj)** (JS codegen) | 24.5M ops/sec | 9.4M ops/sec | **ata 2.6x faster** |
| **Parallel batch** (10K NDJSON items) | 12.5M items/sec | 2.1M items/sec | **ata 5.9x faster** |

### Where ajv wins

| Scenario | ata | ajv | |
|---|---|---|---|
| **validate(obj)** (full errors) | 271K ops/sec | 8.7M ops/sec | **ajv 32x faster** |
| **validateJSON(str)** (valid) | 978K ops/sec | 1.8M ops/sec | **ajv 1.9x faster** |
| **validateJSON(str)** (invalid) | 188K ops/sec | 2.3M ops/sec | **ajv 12x faster** |

### Why the gap?

**`validate(obj)`**: ata's NAPI path must serialize JS objects to JSON (via V8), cross the native boundary, then parse with simdjson. ajv runs entirely in V8 JIT with zero serialization. This is the most common Node.js use case (express `req.body`, function returns, etc.) and ajv is significantly faster here.

**`isValidObject(obj)`**: ata's JS codegen path compiles schemas to pure JS functions (like ajv does), so both run in V8 JIT with no NAPI overhead. ata wins because the generated code is tighter. However, this path only supports simple schemas — complex schemas (`$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `patternProperties`, `enum`, `const`) fall back to the NAPI path.

**`validateJSON(str)`**: When data is already a JSON string (network, disk, IPC), ata avoids `JSON.parse()` and uses simdjson directly. But the NAPI boundary overhead still puts it behind ajv's `JSON.parse() + validate()` pipeline for single calls.

**Parallel batch**: For NDJSON workloads (log processing, data pipelines), ata distributes work across all CPU cores. This is where the C++ engine shines — JS is single-threaded.

**Schema compilation**: ata compiles schemas 143x faster than ajv. This matters for dynamic schemas, serverless cold starts, and schema-per-request patterns.

### JSON Schema Test Suite

**98.6%** pass rate (939/952) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12).

## When to use ata

- **Batch/streaming validation** — NDJSON log processing, data pipelines, ETL
- **Parallel workloads** — multi-core validation across CPU cores
- **Schema-heavy startup** — many schemas compiled at boot (143x faster compile)
- **Simple schemas with `isValidObject()`** — 2.6x faster than ajv in V8 JIT
- **C/C++ embedding** — native library, no JS runtime needed

## When to use ajv

- **JS object validation** — the common `validate(req.body)` pattern
- **Complex schemas** — `$ref`, `allOf`, `anyOf`, `oneOf`, `if/then/else`, `enum`, `const`
- **Error reporting** — ajv's error path is well-optimized; ata's is not yet

## Features

- **Multi-core**: Parallel validation across all CPU cores — 12.5M validations/sec
- **simdjson**: SIMD-accelerated JSON parsing at GB/s speeds
- **RE2 regex**: Linear-time guarantees, immune to ReDoS attacks
- **Codegen bytecode**: Schemas compiled to flat bytecode, zero-allocation validation loop
- **On Demand API**: Validate large documents without materializing the DOM
- **Standard Schema V1**: Compatible with Fastify, tRPC, TanStack, Drizzle
- **Zero-copy paths**: Buffer and pre-padded input support — no unnecessary copies
- **C/C++ library**: Native API for non-Node.js environments
- **98.6% spec compliant**: Draft 2020-12

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
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name', 'email']
});

// Fast boolean check — JS codegen, no NAPI (2.6x faster than ajv)
v.isValidObject({ name: 'Mert', email: 'mert@example.com', age: 26 }); // true

// Full validation with error details
const result = v.validate({ name: 'Mert', email: 'mert@example.com', age: 26 });
console.log(result.valid); // true
console.log(result.errors); // []

// JSON string validation (simdjson fast path)
v.validateJSON('{"name": "Mert", "email": "mert@example.com"}');
v.isValidJSON('{"name": "Mert", "email": "mert@example.com"}'); // true

// Buffer input (zero-copy, raw NAPI)
v.isValid(Buffer.from('{"name": "Mert", "email": "mert@example.com"}'));

// Parallel batch — multi-core, NDJSON (5.9x faster than ajv)
const ndjson = Buffer.from(lines.join('\n'));
v.isValidParallel(ndjson);  // bool[]
v.countValid(ndjson);        // number
```

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
fastify.register(require('fastify-ata'));

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

## Author

[Mert Can Altin](https://github.com/mertcanaltin)
