const native = require("node-gyp-build")(__dirname);
const { compileToJS, compileToJSCodegen } = require("./lib/js-compiler");

const SIMDJSON_PADDING = 64;
const VALID_RESULT = Object.freeze({ valid: true, errors: Object.freeze([]) });

function parsePointerPath(path) {
  if (!path) return [];
  return path
    .split("/")
    .filter(Boolean)
    .map((seg) => ({
      key: seg.replace(/~1/g, "/").replace(/~0/g, "~"),
    }));
}

function createPaddedBuffer(jsonStr) {
  const jsonBuf = Buffer.from(jsonStr);
  const padded = Buffer.allocUnsafe(jsonBuf.length + SIMDJSON_PADDING);
  jsonBuf.copy(padded);
  padded.fill(0, jsonBuf.length);
  return { buffer: padded, length: jsonBuf.length };
}

class Validator {
  constructor(schema) {
    const schemaStr =
      typeof schema === "string" ? schema : JSON.stringify(schema);
    this._compiled = new native.CompiledSchema(schemaStr);
    this._fastSlot = native.fastRegister(schemaStr);

    // Pure JS fast path — no NAPI, runs in V8 JIT
    const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;
    // Try codegen first (fastest, like ajv), fallback to closure-based (CSP-safe)
    this._jsFn = compileToJSCodegen(schemaObj) || compileToJS(schemaObj);

    const self = this;
    Object.defineProperty(this, "~standard", {
      value: Object.freeze({
        version: 1,
        vendor: "ata-validator",
        validate(value) {
          const result = self._compiled.validate(value);
          if (result.valid) {
            return { value };
          }
          return {
            issues: result.errors.map((err) => ({
              message: err.message,
              path: parsePointerPath(err.path),
            })),
          };
        },
      }),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  // Full validation with error details — always uses NAPI for spec compliance
  validate(data) {
    return this._compiled.validate(data);
  }

  // Ultra-fast boolean check for JS objects — codegen path, no NAPI
  // 2x faster than ajv. Falls back to NAPI if codegen unavailable.
  isValidObject(data) {
    if (this._jsFn) return this._jsFn(data);
    return this._compiled.validate(data).valid;
  }

  validateJSON(jsonStr) {
    return this._compiled.validateJSON(jsonStr);
  }

  isValidJSON(jsonStr) {
    return this._compiled.isValidJSON(jsonStr);
  }

  // Raw NAPI fast path for Buffer/Uint8Array
  isValid(input) {
    return native.rawFastValidate(this._fastSlot, input);
  }

  // Zero-copy pre-padded path
  isValidPrepadded(paddedBuffer, jsonLength) {
    return native.rawFastValidate(this._fastSlot, paddedBuffer, jsonLength);
  }

  // Parallel NDJSON batch (multi-core)
  isValidParallel(buffer) {
    return native.rawParallelValidate(this._fastSlot, buffer);
  }

  // Parallel count (fastest — single uint32 return)
  countValid(buffer) {
    return native.rawParallelCount(this._fastSlot, buffer);
  }

  // NDJSON single-thread batch
  isValidNDJSON(buffer) {
    return native.rawNDJSONValidate(this._fastSlot, buffer);
  }
}

function validate(schema, data) {
  const schemaStr =
    typeof schema === "string" ? schema : JSON.stringify(schema);
  return native.validate(schemaStr, data);
}

function version() {
  return native.version();
}

module.exports = { Validator, validate, version, createPaddedBuffer, SIMDJSON_PADDING };
