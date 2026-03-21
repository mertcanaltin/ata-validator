# Tanıtım Draft'ları

## Twitter/X Thread

**Tweet 1 (Ana tweet):**

I built ata — a JSON Schema validator that compiles schemas 11,000x faster than ajv and validates JSON 2-4x faster.

It's written in C++ with simdjson under the hood.

npm install ata-validator

Thread:

---

**Tweet 2:**

Why?

ajv compiles schemas at 16 ops/sec.
ata compiles at 175,548 ops/sec.

That's 11,000x faster.

For serverless, every cold start pays this cost. For API gateways with thousands of schemas, this matters.

---

**Tweet 3:**

For JSON string validation (the real-world scenario — APIs, webhooks, files):

2 KB payload → ata 2.3x faster
10 KB → 3.4x faster
100 KB → 3.5x faster
200 KB → 3.8x faster

The gap grows with payload size. simdjson's SIMD parsing shines on larger data.

---

**Tweet 4:**

ajv generates JavaScript functions with new Function(). This breaks in CSP environments.

ata doesn't use eval or new Function(). It works everywhere — banks, government, strict CSP policies.

---

**Tweet 5:**

Migration is one line:

- const Ajv = require("ajv");
+ const Ajv = require("ata-validator/compat");

Same API. Same validate(). Same errors format.

---

**Tweet 6:**

It also has a C API, so you can use it from:
- Rust (FFI)
- Python (ctypes)
- Go (cgo)
- Ruby (FFI)

ajv is JavaScript-only. ata goes everywhere.

---

**Tweet 7:**

97.1% pass rate on the official JSON Schema Test Suite (Draft 2020-12).

24 out of 29 test files at 100%.

Run the benchmarks yourself:
git clone https://github.com/mertcanaltin/ata
npm install && npm run bench

---

## Reddit Post (r/node, r/javascript)

**Title:** I built a JSON Schema validator that's 11,000x faster than ajv at schema compilation and 2-4x faster at validation

**Body:**

Hey everyone,

I've been working on **ata** — a native JSON Schema validator for Node.js, powered by simdjson (the SIMD-accelerated JSON parser).

**Key numbers:**

| | ata | ajv |
|---|---|---|
| Schema compilation | 175,548 ops/sec | 16 ops/sec |
| 10 KB JSON validation | 136,301 ops/sec | 40,644 ops/sec |
| 100 KB JSON validation | 14,388 ops/sec | 4,062 ops/sec |

**Why not ajv?**

- ajv uses `new Function()` for code generation — breaks CSP
- ajv is JavaScript-only — ata has a C API for multi-language use
- ajv's schema compilation is slow — hurts serverless cold starts

**Quick start:**

```bash
npm install ata-validator
```

```javascript
const { Validator } = require('ata-validator');

const v = new Validator({
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' }
  },
  required: ['name', 'email']
});

v.validate({ name: 'Mert', email: 'mert@example.com' });
// { valid: true, errors: [] }
```

**ajv drop-in replacement:**

```diff
- const Ajv = require("ajv");
+ const Ajv = require("ata-validator/compat");
```

97.1% pass rate on the official JSON Schema Test Suite (Draft 2020-12).

GitHub: https://github.com/mertcanaltin/ata

Feedback welcome!

---

## Hacker News

**Title:** Ata: JSON Schema validator 11,000x faster than ajv at compilation, powered by simdjson

**URL:** https://github.com/mertcanaltin/ata

---

## GitHub Repo "About" Section

**Description:** Ultra-fast JSON Schema validator powered by simdjson. 11,000x faster schema compilation, 2-4x faster validation than ajv. CSP-safe, multi-language C API.

**Topics:** json-schema, validator, simdjson, napi, nodejs, cpp, ajv-alternative, json, validation, performance
