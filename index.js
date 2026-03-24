const native = require("node-gyp-build")(__dirname);
const { compileToJS, compileToJSCodegen } = require("./lib/js-compiler");

const SIMDJSON_PADDING = 64;
const VALID_RESULT = Object.freeze({ valid: true, errors: Object.freeze([]) });

// Above this size, simdjson On Demand (selective field access) beats JSON.parse
// (which must materialize the full JS object tree). Buffer.from + NAPI ~2x faster.
const SIMDJSON_THRESHOLD = 8192;

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
    const compiled = new native.CompiledSchema(schemaStr);
    this._compiled = compiled;
    this._fastSlot = native.fastRegister(schemaStr);

    // Pure JS fast path — no NAPI, runs in V8 JIT
    // Set ATA_FORCE_NAPI=1 to disable JS codegen (for correctness testing)
    const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;
    const jsFn = process.env.ATA_FORCE_NAPI
      ? null
      : (compileToJSCodegen(schemaObj) || compileToJS(schemaObj));
    this._jsFn = jsFn;

    // Closure-capture: avoid `this` property lookup on every call.
    // V8 keeps closure vars in registers — no hidden class traversal.
    const fastSlot = this._fastSlot;

    // Detect if schema is "selective" — doesn't recurse into arrays/deep objects.
    // Selective schemas benefit from simdjson On Demand (seeks only needed fields).
    // Non-selective schemas (items, allOf with nested) touch everything — JSON.parse + jsFn wins.
    const hasArrayTraversal = schemaObj && (schemaObj.items || schemaObj.prefixItems ||
      schemaObj.contains || (schemaObj.properties && Object.values(schemaObj.properties).some(
        p => p && (p.items || p.prefixItems || p.contains))));
    const useSimdjsonForLarge = !hasArrayTraversal;

    if (jsFn) {
      this.validate = (data) => jsFn(data) ? VALID_RESULT : compiled.validate(data);
      this.isValidObject = jsFn;
      this.validateJSON = useSimdjsonForLarge
        ? (jsonStr) => {
            // Selective schema: large docs use simdjson (skips irrelevant data)
            if (jsonStr.length >= SIMDJSON_THRESHOLD) {
              const buf = Buffer.from(jsonStr);
              if (native.rawFastValidate(fastSlot, buf)) return VALID_RESULT;
              return compiled.validateJSON(jsonStr);
            }
            try {
              const obj = JSON.parse(jsonStr);
              if (jsFn(obj)) return VALID_RESULT;
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
            return compiled.validateJSON(jsonStr);
          }
        : (jsonStr) => {
            // Non-selective schema: JSON.parse + jsFn always wins
            try {
              const obj = JSON.parse(jsonStr);
              if (jsFn(obj)) return VALID_RESULT;
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
            return compiled.validateJSON(jsonStr);
          };
      this.isValidJSON = useSimdjsonForLarge
        ? (jsonStr) => {
            if (jsonStr.length >= SIMDJSON_THRESHOLD) {
              return native.rawFastValidate(fastSlot, Buffer.from(jsonStr));
            }
            try { return jsFn(JSON.parse(jsonStr)); }
            catch (e) { if (!(e instanceof SyntaxError)) throw e; return false; }
          }
        : (jsonStr) => {
            try { return jsFn(JSON.parse(jsonStr)); }
            catch (e) { if (!(e instanceof SyntaxError)) throw e; return false; }
          };
    }

    const self = this;
    Object.defineProperty(this, "~standard", {
      value: Object.freeze({
        version: 1,
        vendor: "ata-validator",
        validate(value) {
          const result = self.validate(value);
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

  // Fallback methods — only used when JS codegen is unavailable
  validate(data) {
    return this._compiled.validate(data);
  }

  isValidObject(data) {
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
