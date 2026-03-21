# ata

A blazing-fast C++ JSON Schema validator powered by [simdjson](https://github.com/simdjson/simdjson). Schema compilation 11,000x faster than ajv, JSON validation 2-4x faster. CSP-safe, multi-language, zero JS dependencies.

## Performance

### Schema Compilation

| Validator | ops/sec |
|---|---|
| **ata** | **175,548** |
| ajv | 16 |

> ata compiles schemas **11,000x faster** than ajv.

### JSON String Validation (real-world scenario)

| Payload Size | ata | ajv | Winner |
|---|---|---|---|
| 2 KB | 449,447 | 193,181 | **ata 2.3x faster** |
| 10 KB | 136,301 | 40,644 | **ata 3.4x faster** |
| 20 KB | 73,142 | 20,459 | **ata 3.6x faster** |
| 100 KB | 14,388 | 4,062 | **ata 3.5x faster** |
| 200 KB | 7,590 | 2,021 | **ata 3.8x faster** |

> Tested on Apple Silicon. JSON string validation = `JSON.parse()` + `validate()` for ajv vs single `validateJSON()` call for ata. The gap grows with payload size.

### JSON Schema Test Suite

**97.6%** pass rate (803/823) on official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (Draft 2020-12).

## Features

- **Fast**: SIMD-accelerated JSON parsing via simdjson, pre-compiled schemas, cached regex patterns, branchless UTF-8 counting
- **CSP-Safe**: No `new Function()` or `eval()` — works in strict Content Security Policy environments where ajv cannot
- **V8 Direct Traversal**: Validates JS objects directly in C++ without `JSON.stringify` overhead
- **Comprehensive**: Supports JSON Schema Draft 2020-12 keywords including `$ref`, `if/then/else`, `patternProperties`, `prefixItems`, `format`
- **Multi-Language**: C API (`ata_c.h`) enables bindings for Rust, Python, Go, Ruby, and more
- **Drop-in Replacement**: ajv-compatible API — switch with one line change
- **Node.js Binding**: Native N-API addon
- **Error Details**: Rich error messages with JSON Pointer paths

## Installation

### Node.js

```bash
npm install ata-validator
```

### CMake (C++)

```cmake
include(FetchContent)
FetchContent_Declare(
  ata
  GIT_REPOSITORY https://github.com/mertcanaltin/ata.git
  GIT_TAG main
)
FetchContent_MakeAvailable(ata)

target_link_libraries(your_target PRIVATE ata::ata)
```

## Usage

### Node.js

```javascript
const { Validator, validate } = require('ata-validator');

// Pre-compiled schema (recommended)
const v = new Validator({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name', 'email']
});

// Validate JS objects directly (V8 direct traversal)
const result = v.validate({ name: 'Mert', email: 'mert@example.com', age: 28 });
console.log(result.valid); // true

// Validate JSON strings (simdjson fast path)
const r = v.validateJSON('{"name": "Mert", "email": "mert@example.com"}');
console.log(r.valid); // true

// Error details
const r2 = v.validate({ name: '', age: -1 });
console.log(r2.errors);
// [{ code: 4, path: '', message: 'missing required property: email' }, ...]
```

### Drop-in ajv Replacement

```diff
- const Ajv = require('ajv');
+ const Ajv = require('ata-validator/compat');

const ajv = new Ajv();
const validate = ajv.compile(schema);
const valid = validate(data);
if (!valid) console.log(validate.errors);
```

### C++

```cpp
#include "ata.h"
#include <iostream>

int main() {
  auto schema = ata::compile(R"({
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "integer", "minimum": 0}
    },
    "required": ["name"]
  })");

  auto result = ata::validate(schema, R"({"name": "Mert", "age": 28})");

  if (result) {
    std::cout << "Valid!" << std::endl;
  } else {
    for (const auto& err : result.errors) {
      std::cout << err.path << ": " << err.message << std::endl;
    }
  }
  return 0;
}
```

### C API

```c
#include "ata_c.h"
#include <stdio.h>
#include <string.h>

int main(void) {
  const char* schema = "{\"type\":\"string\",\"minLength\":3}";
  ata_schema s = ata_compile(schema, strlen(schema));

  const char* doc = "\"hello\"";
  ata_result r = ata_validate(s, doc, strlen(doc));

  if (r.valid) {
    printf("Valid!\n");
  } else {
    for (size_t i = 0; i < r.error_count; i++) {
      ata_string msg = ata_get_error_message(i);
      printf("Error: %.*s\n", (int)msg.length, msg.data);
    }
  }

  ata_schema_free(s);
  return 0;
}
```

## Supported Keywords

| Category | Keywords |
|----------|----------|
| Type | `type` (string, number, integer, boolean, null, array, object, union) |
| Numeric | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| String | `minLength`, `maxLength`, `pattern`, `format` |
| Array | `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains` |
| Object | `properties`, `required`, `additionalProperties`, `patternProperties`, `minProperties`, `maxProperties`, `propertyNames`, `dependentRequired`, `dependentSchemas` |
| Enum/Const | `enum`, `const` |
| Composition | `allOf`, `anyOf`, `oneOf`, `not` |
| Conditional | `if`, `then`, `else` |
| References | `$ref`, `$defs`, `definitions`, `$id` |
| Boolean | `true` (accept all), `false` (reject all) |

### Format Validators

`email`, `date`, `date-time`, `time`, `uri`, `uri-reference`, `ipv4`, `ipv6`, `uuid`, `hostname`

## Why ata over ajv?

| | ata | ajv |
|---|---|---|
| Schema compilation | **11,000x faster** | Slow (code generation) |
| JSON string validation | **2-4x faster** | JSON.parse + validate |
| CSP compatible | Yes | No (`new Function()`) |
| Multi-language | C, C++, Rust, Python, Go | JavaScript only |
| Bundle size | ~20KB JS + native | ~150KB minified |
| Node.js core candidate | Yes (like ada-url, simdutf) | No (JS dependency) |

## Building from Source

```bash
# C++ library + tests
cmake -B build
cmake --build build
ctest --test-dir build

# With benchmarks
cmake -B build -DATA_BENCHMARKS=ON
cmake --build build
./build/ata_bench

# Node.js addon
npm install
node test.js

# Run JSON Schema Test Suite
node tests/run_suite.js
```

### Build Options

| Option | Default | Description |
|--------|---------|-------------|
| `ATA_TESTING` | `ON` | Build test suite |
| `ATA_BENCHMARKS` | `OFF` | Build benchmarks |
| `ATA_SANITIZE` | `OFF` | Enable address sanitizer |

## API Reference

### C++ API

#### `ata::compile(schema_json) -> schema_ref`
Compile a JSON Schema string. Returns a reusable `schema_ref` (falsy on error).

#### `ata::validate(schema_ref, json, opts) -> validation_result`
Validate a JSON string against a pre-compiled schema. Pass `{.all_errors = false}` to stop at first error (faster).

#### `ata::validation_result`
```cpp
struct validation_result {
  bool valid;
  std::vector<validation_error> errors;
  explicit operator bool() const noexcept { return valid; }
};
```

### Node.js API

#### `new Validator(schema)`
Create a validator with a pre-compiled schema. `schema` can be an object or JSON string.

#### `validator.validate(data) -> { valid, errors }`
Validate any JS value directly via V8 traversal (no serialization).

#### `validator.validateJSON(jsonString) -> { valid, errors }`
Validate a JSON string via simdjson (fastest path for string input).

#### `validate(schema, data) -> { valid, errors }`
One-shot validation without pre-compilation.

### ajv-compatible API (`compat.js`)

```javascript
const Ata = require('ata-validator/compat');
const ata = new Ata();
const validate = ata.compile(schema);
const valid = validate(data);
if (!valid) console.log(validate.errors);
```

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.
