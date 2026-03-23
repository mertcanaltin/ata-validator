const native = require("node-gyp-build")(__dirname);

const SIMDJSON_PADDING = 64;

function parsePointerPath(path) {
  if (!path) return [];
  return path
    .split("/")
    .filter(Boolean)
    .map((seg) => ({
      key: seg.replace(/~1/g, "/").replace(/~0/g, "~"),
    }));
}

// Pre-allocate a padded buffer for zero-copy validation
function createPaddedBuffer(jsonStr) {
  const jsonBuf = Buffer.from(jsonStr);
  const padded = Buffer.allocUnsafe(jsonBuf.length + SIMDJSON_PADDING);
  jsonBuf.copy(padded);
  padded.fill(0, jsonBuf.length); // zero padding
  return { buffer: padded, length: jsonBuf.length };
}

class Validator {
  constructor(schema) {
    const schemaStr =
      typeof schema === "string" ? schema : JSON.stringify(schema);
    this._compiled = new native.CompiledSchema(schemaStr);
    this._fastSlot = native.fastRegister(schemaStr);

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

  validate(data) {
    return this._compiled.validate(data);
  }

  validateJSON(jsonStr) {
    return this._compiled.validateJSON(jsonStr);
  }

  isValidJSON(jsonStr) {
    return this._compiled.isValidJSON(jsonStr);
  }

  // Fast path: Buffer/Uint8Array → bool (raw NAPI, minimal overhead)
  isValid(input) {
    return native.rawFastValidate(this._fastSlot, input);
  }

  // Zero-copy path: pre-padded buffer → bool (no memcpy in simdjson)
  isValidPrepadded(paddedBuffer, jsonLength) {
    return native.rawFastValidate(this._fastSlot, paddedBuffer, jsonLength);
  }

  // Batch validation: one NAPI call for N JSONs → bool[]
  isValidBatch(jsonArray) {
    return native.rawBatchValidate(this._fastSlot, jsonArray);
  }

  // NDJSON batch: single Buffer with newline-delimited JSONs → bool[]
  isValidNDJSON(buffer) {
    return native.rawNDJSONValidate(this._fastSlot, buffer);
  }

  // Parallel NDJSON: multi-core validation — uses all CPU cores
  isValidParallel(buffer) {
    return native.rawParallelValidate(this._fastSlot, buffer);
  }

  // Parallel count: returns number of valid items (fastest — no array allocation)
  countValid(buffer) {
    return native.rawParallelCount(this._fastSlot, buffer);
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
