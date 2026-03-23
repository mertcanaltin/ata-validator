# ata-validator

Ultra-fast JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Multi-core parallel validation, RE2 regex, codegen bytecode engine. Standard Schema V1 compatible.

**[ata-validator.com](https://ata-validator.com)**

## Performance

### Parallel Batch Validation (multi-core)

| Batch Size | ata | ajv | Winner |
|---|---|---|---|
| 500 items | 6.4M items/sec | 2.2M items/sec | **ata 2.9x faster** |
| 1,000 items | 8.4M items/sec | 2.2M items/sec | **ata 3.9x faster** |
| 5,000 items | 11.3M items/sec | 2.1M items/sec | **ata 5.3x faster** |
| 10,000 items | 12.5M items/sec | 2.1M items/sec | **ata 5.9x faster** |

> ajv is single-threaded (JS). ata uses all CPU cores via a persistent C++ thread pool.

### Schema Compilation

| Validator | ops/sec |
|---|---|
| **ata** | **107,139** |
| ajv | 891 |

> ata compiles schemas **145x faster** than ajv.

### Single Call — JS Object Validation

| Method | ata | ajv | |
|---|---|---|---|
| **isValidObject(obj)** | **41M ops/sec** | **19M ops/sec** | **ata 2.2x faster** |
| isValid(Buffer) | 1.65M ops/sec | 1.77M ops/sec | Nearly equal |
| validateJSON(string) | 966K ops/sec | 1.77M ops/sec | ajv 1.8x |

> `isValidObject()` uses a JS codegen fast path — no NAPI boundary, runs entirely in V8 JIT.

> Single call overhead is dominated by the NAPI boundary. For batch workloads, ata wins convincingly.

### JSON Schema Test Suite

**98.6%** pass rate (939/952) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12).

## Features

- **Multi-core**: Parallel validation across all CPU cores — 12.5M validations/sec
- **simdjson**: SIMD-accelerated JSON parsing at GB/s speeds
- **RE2 regex**: Linear-time guarantees, immune to ReDoS attacks
- **Codegen bytecode**: Schemas compiled to flat bytecode, zero-allocation validation loop
- **On Demand API**: Validate large documents without materializing the DOM (2.3x faster)
- **Standard Schema V1**: Compatible with Fastify, tRPC, TanStack, Drizzle
- **Zero-copy paths**: Buffer and pre-padded input support — no unnecessary copies
- **CSP-safe**: No `new Function()` or `eval()`
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

// Ultra-fast boolean check — 2.2x faster than ajv (JS codegen, no NAPI)
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
