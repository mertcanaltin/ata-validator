const native = require("node-gyp-build")(__dirname);
const {
  compileToJS,
  compileToJSCodegen,
  compileToJSCodegenWithErrors,
  compileToJSCombined,
} = require("./lib/js-compiler");

// Extract default values from a schema tree. Returns a function that applies
// defaults to an object in-place (mutates), or null if no defaults exist.
function buildDefaultsApplier(schema) {
  if (typeof schema !== "object" || schema === null) return null;
  const actions = [];
  collectDefaults(schema, actions);
  if (actions.length === 0) return null;
  return (data) => {
    for (let i = 0; i < actions.length; i++) actions[i](data);
  };
}

function collectDefaults(schema, actions, path) {
  if (typeof schema !== "object" || schema === null) return;
  const props = schema.properties;
  if (!props) return;
  for (const [key, prop] of Object.entries(props)) {
    if (prop && typeof prop === "object" && prop.default !== undefined) {
      const defaultVal = prop.default;
      if (!path) {
        actions.push((data) => {
          if (typeof data === "object" && data !== null && !(key in data)) {
            data[key] =
              typeof defaultVal === "object" && defaultVal !== null
                ? JSON.parse(JSON.stringify(defaultVal))
                : defaultVal;
          }
        });
      } else {
        const parentPath = path;
        actions.push((data) => {
          let target = data;
          for (let j = 0; j < parentPath.length; j++) {
            if (typeof target !== "object" || target === null) return;
            target = target[parentPath[j]];
          }
          if (
            typeof target === "object" &&
            target !== null &&
            !(key in target)
          ) {
            target[key] =
              typeof defaultVal === "object" && defaultVal !== null
                ? JSON.parse(JSON.stringify(defaultVal))
                : defaultVal;
          }
        });
      }
    }
    // Recurse into nested object schemas
    if (prop && typeof prop === "object" && prop.properties) {
      collectDefaults(prop, actions, (path || []).concat(key));
    }
  }
}

// Build a function that coerces property values to match schema types in-place.
// Handles string→number, string→integer, string→boolean, number→string, boolean→string.
function buildCoercer(schema) {
  if (typeof schema !== "object" || schema === null) return null;
  const actions = [];
  collectCoercions(schema, actions);
  if (actions.length === 0) return null;
  return (data) => {
    for (let i = 0; i < actions.length; i++) actions[i](data);
  };
}

function collectCoercions(schema, actions, path) {
  if (typeof schema !== "object" || schema === null) return;
  const props = schema.properties;
  if (!props) return;
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== "object" || !prop.type) continue;
    const targetType = Array.isArray(prop.type) ? null : prop.type;
    if (!targetType) continue;

    const coerce = buildSingleCoercion(targetType);
    if (!coerce) continue;

    if (!path) {
      actions.push((data) => {
        if (typeof data === "object" && data !== null && key in data) {
          const coerced = coerce(data[key]);
          if (coerced !== undefined) data[key] = coerced;
        }
      });
    } else {
      const parentPath = path;
      actions.push((data) => {
        let target = data;
        for (let j = 0; j < parentPath.length; j++) {
          if (typeof target !== "object" || target === null) return;
          target = target[parentPath[j]];
        }
        if (typeof target === "object" && target !== null && key in target) {
          const coerced = coerce(target[key]);
          if (coerced !== undefined) target[key] = coerced;
        }
      });
    }

    // Recurse into nested object properties
    if (prop.properties) {
      collectCoercions(prop, actions, (path || []).concat(key));
    }
  }
}

function buildSingleCoercion(targetType) {
  switch (targetType) {
    case "number":
      return (v) => {
        if (typeof v === "string") {
          const n = Number(v);
          if (v !== "" && !isNaN(n)) return n;
        }
        if (typeof v === "boolean") return v ? 1 : 0;
      };
    case "integer":
      return (v) => {
        if (typeof v === "string") {
          const n = Number(v);
          if (v !== "" && Number.isInteger(n)) return n;
        }
        if (typeof v === "boolean") return v ? 1 : 0;
      };
    case "string":
      return (v) => {
        if (typeof v === "number" || typeof v === "boolean") return String(v);
      };
    case "boolean":
      return (v) => {
        if (v === "true" || v === "1") return true;
        if (v === "false" || v === "0") return false;
      };
    default:
      return null;
  }
}

// Build a function that removes properties not defined in schema.properties.
// Walks nested objects recursively.
function buildRemover(schema) {
  if (typeof schema !== "object" || schema === null) return null;
  const actions = [];
  collectRemovals(schema, actions);
  if (actions.length === 0) return null;
  return (data) => {
    for (let i = 0; i < actions.length; i++) actions[i](data);
  };
}

function collectRemovals(schema, actions, path) {
  if (typeof schema !== "object" || schema === null || !schema.properties)
    return;

  // If this level has additionalProperties: false, add a removal action
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    if (!path) {
      actions.push((data) => {
        if (typeof data !== "object" || data === null || Array.isArray(data))
          return;
        const keys = Object.keys(data);
        for (let i = 0; i < keys.length; i++) {
          if (!allowed.has(keys[i])) delete data[keys[i]];
        }
      });
    } else {
      const parentPath = path;
      actions.push((data) => {
        let target = data;
        for (let j = 0; j < parentPath.length; j++) {
          if (typeof target !== "object" || target === null) return;
          target = target[parentPath[j]];
        }
        if (
          typeof target !== "object" ||
          target === null ||
          Array.isArray(target)
        )
          return;
        const keys = Object.keys(target);
        for (let i = 0; i < keys.length; i++) {
          if (!allowed.has(keys[i])) delete target[keys[i]];
        }
      });
    }
  }

  // Always recurse into nested properties (they may have their own additionalProperties: false)
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop && typeof prop === "object" && prop.properties) {
      collectRemovals(prop, actions, (path || []).concat(key));
    }
  }
}

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
  constructor(schema, opts) {
    const options = opts || {};
    const schemaStr =
      typeof schema === "string" ? schema : JSON.stringify(schema);
    const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;

    this._schemaStr = schemaStr;
    this._schemaObj = schemaObj;
    this._options = options;
    this._initialized = false;
    this._nativeReady = false;
    this._compiled = null;
    this._fastSlot = -1;
    this._jsFn = null;
    this._preprocess = null;
    this._applyDefaults = null;

    // Lazy stubs: trigger compilation on first call, then re-dispatch
    this.validate = (data) => {
      this._ensureCompiled();
      return this.validate(data);
    };
    this.isValidObject = (data) => {
      this._ensureCompiled();
      return this.isValidObject(data);
    };
    this.validateJSON = (jsonStr) => {
      this._ensureCompiled();
      return this.validateJSON(jsonStr);
    };
    this.isValidJSON = (jsonStr) => {
      this._ensureCompiled();
      return this.isValidJSON(jsonStr);
    };

    // ~standard uses self.validate() -- works with lazy because it goes through
    // the instance property which gets swapped after compilation
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

  _ensureCompiled() {
    if (this._initialized) return;
    this._initialized = true;

    const schemaObj = this._schemaObj;
    const options = this._options;

    // Try combined first -- if it works, we skip codegen + error codegen
    // Combined does validate + error collection in one pass
    const jsCombinedFn = process.env.ATA_FORCE_NAPI
      ? null
      : compileToJSCombined(schemaObj, VALID_RESULT);

    // Codegen (jsFn) is only needed for isValidObject and toStandalone.
    // If combined works, defer codegen to _ensureCodegen() -- saves ~0.5ms
    let jsFn = null;
    let codegenDeferred = false;
    if (jsCombinedFn) {
      codegenDeferred = true;
    } else if (!process.env.ATA_FORCE_NAPI) {
      jsFn = compileToJSCodegen(schemaObj) || compileToJS(schemaObj);
    }
    this._jsFn = jsFn;

    // Data mutators -- applied in-place before validation
    const applyDefaults = buildDefaultsApplier(schemaObj);
    const applyCoerce = options.coerceTypes ? buildCoercer(schemaObj) : null;
    const applyRemove = options.removeAdditional
      ? buildRemover(schemaObj)
      : null;
    this._applyDefaults = applyDefaults;

    // Combine all mutators into a single pre-validation step
    const mutators = [applyRemove, applyCoerce, applyDefaults].filter(Boolean);
    const preprocess =
      mutators.length === 0
        ? null
        : mutators.length === 1
          ? mutators[0]
          : (data) => {
              for (let i = 0; i < mutators.length; i++) mutators[i](data);
            };
    this._preprocess = preprocess;

    // Detect if schema is "selective" -- doesn't recurse into arrays/deep objects.
    const hasArrayTraversal =
      schemaObj &&
      (schemaObj.items ||
        schemaObj.prefixItems ||
        schemaObj.contains ||
        (schemaObj.properties &&
          Object.values(schemaObj.properties).some(
            (p) => p && (p.items || p.prefixItems || p.contains),
          )));
    const useSimdjsonForLarge = !hasArrayTraversal;

    // Try combined -- single pass, validates + collects errors
    let safeCombinedFn = null;
    if (jsCombinedFn) {
      try {
        const probe = {};
        if (schemaObj && schemaObj.properties) {
          for (const k of Object.keys(schemaObj.properties)) probe[k] = "";
        }
        if (schemaObj && schemaObj.if && schemaObj.if.properties) {
          for (const k of Object.keys(schemaObj.if.properties)) probe[k] = "";
        }
        jsCombinedFn(probe);
        jsCombinedFn({});
        jsCombinedFn(null);
        jsCombinedFn(0);
        safeCombinedFn = jsCombinedFn;
      } catch {}
    }

    // If combined failed and codegen was deferred, compile it now
    if (!safeCombinedFn && codegenDeferred && !process.env.ATA_FORCE_NAPI) {
      jsFn = compileToJSCodegen(schemaObj) || compileToJS(schemaObj);
      this._jsFn = jsFn;
    }

    if (safeCombinedFn || jsFn) {
      if (safeCombinedFn) {
        this.validate = preprocess
          ? (data) => {
              preprocess(data);
              return safeCombinedFn(data);
            }
          : safeCombinedFn;
      } else {
        // Combined failed -- fall back to hybrid with error codegen
        const jsErrFn = compileToJSCodegenWithErrors(schemaObj);
        let safeErrFn = null;
        if (jsErrFn) {
          try {
            jsErrFn({}, true);
            safeErrFn = (d) => jsErrFn(d, true);
          } catch {}
        }
        const errFn =
          safeErrFn ||
          ((d) => {
            this._ensureNative();
            return this._compiled.validate(d);
          });

        const hybridFn = jsFn._hybridFactory
          ? jsFn._hybridFactory(VALID_RESULT, errFn)
          : null;
        this.validate = hybridFn
          ? preprocess
            ? (data) => {
                preprocess(data);
                return hybridFn(data);
              }
            : hybridFn
          : preprocess
            ? (data) => {
                preprocess(data);
                return jsFn(data) ? VALID_RESULT : errFn(data);
              }
            : (data) => (jsFn(data) ? VALID_RESULT : errFn(data));
      }
      // isValidObject: use jsFn if available, else derive from combined
      this.isValidObject = jsFn
        ? jsFn
        : (data) => {
            this._ensureCodegen();
            return this.isValidObject(data);
          };
      const jsonValidateFn = safeCombinedFn || this.validate;
      this.validateJSON = useSimdjsonForLarge
        ? (jsonStr) => {
            if (jsonStr.length >= SIMDJSON_THRESHOLD) {
              this._ensureNative();
              const buf = Buffer.from(jsonStr);
              if (native.rawFastValidate(this._fastSlot, buf))
                return VALID_RESULT;
              return this._compiled.validateJSON(jsonStr);
            }
            try {
              return jsonValidateFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
            this._ensureNative();
            return this._compiled.validateJSON(jsonStr);
          }
        : (jsonStr) => {
            try {
              return jsonValidateFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
            this._ensureNative();
            return this._compiled.validateJSON(jsonStr);
          };
      const boolFn = jsFn || ((d) => safeCombinedFn ? safeCombinedFn(d).valid : false);
      this.isValidJSON = useSimdjsonForLarge
        ? (jsonStr) => {
            if (jsonStr.length >= SIMDJSON_THRESHOLD) {
              this._ensureNative();
              return native.rawFastValidate(
                this._fastSlot,
                Buffer.from(jsonStr),
              );
            }
            try {
              return boolFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
              return false;
            }
          }
        : (jsonStr) => {
            try {
              return boolFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
              return false;
            }
          };
    } else {
      // ATA_FORCE_NAPI path: no JS codegen, use native for everything
      this._ensureNative();
      this.validate = preprocess
        ? (data) => {
            preprocess(data);
            return this._compiled.validate(data);
          }
        : (data) => this._compiled.validate(data);
      this.isValidObject = (data) => this._compiled.validate(data).valid;
      this.validateJSON = (jsonStr) => this._compiled.validateJSON(jsonStr);
      this.isValidJSON = (jsonStr) => this._compiled.isValidJSON(jsonStr);
    }
  }

  _ensureNative() {
    if (this._nativeReady) return;
    this._nativeReady = true;
    this._compiled = new native.CompiledSchema(this._schemaStr);
    this._fastSlot = native.fastRegister(this._schemaStr);
  }

  _ensureCodegen() {
    if (this._jsFn) return;
    const schemaObj = this._schemaObj;
    const jsFn = compileToJSCodegen(schemaObj) || compileToJS(schemaObj);
    this._jsFn = jsFn;
    if (jsFn) this.isValidObject = jsFn;
  }

  // --- Standalone pre-compilation ---
  // Generate a JS module string that can be written to a file.
  // On next startup, load with Validator.fromStandalone() -- zero compile time.
  toStandalone() {
    this._ensureCompiled();
    this._ensureCodegen();
    const jsFn = this._jsFn;
    if (!jsFn || !jsFn._source) return null;
    const src = jsFn._source;
    const hybridSrc = jsFn._hybridSource || "";

    // Also capture error function source for zero-compile standalone load
    const jsErrFn = compileToJSCodegenWithErrors(
      typeof this._schemaObj === "object" ? this._schemaObj : {},
    );
    const errSrc = jsErrFn && jsErrFn._errSource ? jsErrFn._errSource : "";

    return `// Auto-generated by ata-validator — do not edit
'use strict';
const boolFn = function(d) {
  ${src}
};
const hybridFactory = function(R, E) {
  return function(d) {
    ${hybridSrc}
  };
};
${errSrc ? `const errFn = function(d, _all) {\n  ${errSrc}\n};` : "const errFn = null;"}
module.exports = { boolFn, hybridFactory, errFn };
`;
  }

  // Load a pre-compiled standalone module. Zero schema compilation.
  // No NAPI, no native compile — pure JS. Startup in microseconds.
  // Usage: const v = Validator.fromStandalone(require('./compiled.js'), schema, opts)
  static fromStandalone(mod, schema, opts) {
    const options = opts || {};
    const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;

    // Create a lightweight instance — skip NAPI compile entirely
    const v = Object.create(Validator.prototype);
    v._jsFn = mod.boolFn;
    v._compiled = null;
    v._fastSlot = -1;

    // Mutators
    const applyDefaults = buildDefaultsApplier(schemaObj);
    const applyCoerce = options.coerceTypes ? buildCoercer(schemaObj) : null;
    const applyRemove = options.removeAdditional
      ? buildRemover(schemaObj)
      : null;
    const mutators = [applyRemove, applyCoerce, applyDefaults].filter(Boolean);
    const preprocess =
      mutators.length === 0
        ? null
        : mutators.length === 1
          ? mutators[0]
          : (data) => {
              for (let i = 0; i < mutators.length; i++) mutators[i](data);
            };
    v._preprocess = preprocess;

    // Error function — use pre-compiled from standalone if available, else compile
    let errFn = (d) => ({
      valid: false,
      errors: [
        { code: "validation_failed", path: "", message: "validation failed" },
      ],
    });
    if (mod.errFn) {
      errFn = (d) => mod.errFn(d, true);
    } else {
      const jsErrFn = compileToJSCodegenWithErrors(schemaObj);
      if (jsErrFn) {
        try {
          jsErrFn({}, true);
          errFn = (d) => jsErrFn(d, true);
        } catch {}
      }
    }

    // Hybrid or speculative
    const hybridFn = mod.hybridFactory
      ? mod.hybridFactory(VALID_RESULT, errFn)
      : null;

    v.validate = hybridFn
      ? preprocess
        ? (data) => {
            preprocess(data);
            return hybridFn(data);
          }
        : hybridFn
      : preprocess
        ? (data) => {
            preprocess(data);
            return mod.boolFn(data) ? VALID_RESULT : errFn(data);
          }
        : (data) => (mod.boolFn(data) ? VALID_RESULT : errFn(data));
    v.isValidObject = mod.boolFn;
    v.isValidJSON = (jsonStr) => {
      try {
        return mod.boolFn(JSON.parse(jsonStr));
      } catch {
        return false;
      }
    };
    v.validateJSON = (jsonStr) => {
      try {
        const obj = JSON.parse(jsonStr);
        return hybridFn
          ? hybridFn(obj)
          : mod.boolFn(obj)
            ? VALID_RESULT
            : errFn(obj);
      } catch {
        return {
          valid: false,
          errors: [{ code: "invalid_json", path: "", message: "invalid JSON" }],
        };
      }
    };

    // Standard Schema V1
    Object.defineProperty(v, "~standard", {
      value: Object.freeze({
        version: 1,
        vendor: "ata-validator",
        validate(value) {
          const result = v.validate(value);
          if (result.valid) return { value };
          return {
            issues: result.errors.map((e) => ({
              message: e.message,
              path: parsePointerPath(e.path),
            })),
          };
        },
      }),
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return v;
  }

  // Raw NAPI fast path for Buffer/Uint8Array
  isValid(input) {
    this._ensureNative();
    return native.rawFastValidate(this._fastSlot, input);
  }

  // Zero-copy pre-padded path
  isValidPrepadded(paddedBuffer, jsonLength) {
    this._ensureNative();
    return native.rawFastValidate(this._fastSlot, paddedBuffer, jsonLength);
  }

  // Parallel NDJSON batch (multi-core)
  isValidParallel(buffer) {
    this._ensureNative();
    return native.rawParallelValidate(this._fastSlot, buffer);
  }

  // Parallel count (fastest -- single uint32 return)
  countValid(buffer) {
    this._ensureNative();
    return native.rawParallelCount(this._fastSlot, buffer);
  }

  // NDJSON single-thread batch
  isValidNDJSON(buffer) {
    this._ensureNative();
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

// Bundle multiple validators into a single JS file for fast startup.
// Usage:
//   const bundle = Validator.bundle([schema1, schema2, ...]);
//   fs.writeFileSync('validators.js', bundle);
//   // On startup:
//   const validators = Validator.loadBundle(require('./validators.js'), [schema1, schema2, ...]);
Validator.bundle = function (schemas, opts) {
  const parts = schemas.map((schema) => {
    const v = new Validator(schema, opts);
    const standalone = v.toStandalone();
    if (!standalone) return "null";
    return (
      "(function(){" +
      standalone
        .replace("'use strict';", "")
        .replace("module.exports = ", "return ") +
      "})()"
    );
  });
  return "'use strict';\nmodule.exports = [\n" + parts.join(",\n") + "\n];\n";
};

// Zero-dependency self-contained bundle — no require('ata-validator') needed at runtime.
Validator.bundleStandalone = function (schemas, opts) {
  const R = "Object.freeze({valid:true,errors:Object.freeze([])})";
  const fns = schemas.map((schema) => {
    const v = new Validator(schema, opts);
    v._ensureCompiled();
    v._ensureCodegen();
    const jsFn = v._jsFn;
    if (!jsFn || !jsFn._hybridSource) return "null";
    const jsErrFn = compileToJSCodegenWithErrors(
      typeof schema === "string" ? JSON.parse(schema) : schema,
    );
    const errBody =
      jsErrFn && jsErrFn._errSource
        ? jsErrFn._errSource
        : "return{valid:false,errors:[{code:'error',path:'',message:'validation failed'}]}";
    return `(function(R){var E=function(d){var _all=true;${errBody}};return function(d){${jsFn._hybridSource}}})(R)`;
  });
  return `'use strict';\nvar R=${R};\nmodule.exports=[${fns.join(",")}];\n`;
};

// Compact bundle: deduplicated code. Shared template functions + per-schema params.
// Much smaller file → faster V8 parse → faster startup.
Validator.bundleCompact = function (schemas, opts) {
  // Analyze schemas and group by structure
  const entries = schemas.map((schema) => {
    const v = new Validator(schema, opts);
    v._ensureCompiled();
    v._ensureCodegen();
    const jsFn = v._jsFn;
    if (!jsFn || !jsFn._hybridSource) return null;
    const jsErrFn = compileToJSCodegenWithErrors(
      typeof schema === "string" ? JSON.parse(schema) : schema,
    );
    return {
      hybrid: jsFn._hybridSource,
      err: jsErrFn && jsErrFn._errSource ? jsErrFn._errSource : null,
    };
  });

  // Deduplicate function bodies — many schemas produce identical or near-identical code
  const bodyMap = new Map(); // body → index
  const bodies = [];
  const errMap = new Map();
  const errBodies = [];

  const indices = entries.map((e) => {
    if (!e) return [-1, -1];
    let hi = bodyMap.get(e.hybrid);
    if (hi === undefined) {
      hi = bodies.length;
      bodies.push(e.hybrid);
      bodyMap.set(e.hybrid, hi);
    }
    let ei = -1;
    if (e.err) {
      ei = errMap.get(e.err);
      if (ei === undefined) {
        ei = errBodies.length;
        errBodies.push(e.err);
        errMap.set(e.err, ei);
      }
    }
    return [hi, ei];
  });

  // Generate compact bundle
  let out = "'use strict';\n";
  out += "var R=Object.freeze({valid:true,errors:Object.freeze([])});\n";

  // Shared hybrid factories
  out += "var H=[\n";
  out += bodies
    .map((b) => `function(R,E){return function(d){${b}}}`)
    .join(",\n");
  out += "\n];\n";

  // Shared error functions
  out += "var EF=[\n";
  out += errBodies.map((b) => `function(d){var _all=true;${b}}`).join(",\n");
  out += "\n];\n";

  // Build validators from shared templates
  out += "module.exports=[";
  out += indices
    .map(([hi, ei]) => {
      if (hi < 0) return "null";
      if (ei >= 0) return `H[${hi}](R,EF[${ei}])`;
      return `H[${hi}](R,function(){return{valid:false,errors:[]}})`;
    })
    .join(",");
  out += "];\n";

  return out;
};

Validator.loadBundle = function (mods, schemas, opts) {
  return schemas.map((schema, i) => {
    if (mods[i]) return Validator.fromStandalone(mods[i], schema, opts);
    return new Validator(schema, opts);
  });
};

module.exports = {
  Validator,
  validate,
  version,
  createPaddedBuffer,
  SIMDJSON_PADDING,
};
