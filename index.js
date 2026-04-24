// Native addon: optional. Core validate() uses JS codegen and works without it.
// Buffer APIs (isValid, countValid, isValidParallel) require native.
let native;
try { native = require("pkg-prebuilds")(__dirname, require("./binding-options")); } catch {}
const {
  compileToJS,
  compileToJSCodegen,
  compileToJSCodegenWithErrors,
  compileToJSCombined,
} = require("./lib/js-compiler");
const { normalizeDraft7 } = require("./lib/draft7");
const { classify } = require("./lib/shape-classifier");
const { buildTier0Plan, tier0Validate } = require("./lib/tier0");

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

// Generate a fast preprocess function via codegen instead of closure arrays
function buildPreprocessCodegen(schema, options) {
  if (typeof schema !== 'object' || schema === null || !schema.properties) return null;
  const lines = [];
  const props = schema.properties;
  const keys = Object.keys(props);

  // removeAdditional: inline key check
  if (options.removeAdditional && schema.additionalProperties === false) {
    const checks = keys.map(k => `_k!==${JSON.stringify(k)}`).join('&&');
    lines.push(`for(var _k in d)if(${checks})delete d[_k]`);
  }

  // coerceTypes: inline per property
  if (options.coerceTypes) {
    for (const [key, prop] of Object.entries(props)) {
      if (!prop || typeof prop !== 'object' || !prop.type) continue;
      const t = Array.isArray(prop.type) ? null : prop.type;
      if (!t) continue;
      const k = JSON.stringify(key);
      if (t === 'integer') {
        lines.push(`if(typeof d[${k}]==='string'){var _n=Number(d[${k}]);if(d[${k}]!==''&&Number.isInteger(_n))d[${k}]=_n}`);
        lines.push(`if(typeof d[${k}]==='boolean')d[${k}]=d[${k}]?1:0`);
      } else if (t === 'number') {
        lines.push(`if(typeof d[${k}]==='string'){var _n=Number(d[${k}]);if(d[${k}]!==''&&!isNaN(_n))d[${k}]=_n}`);
        lines.push(`if(typeof d[${k}]==='boolean')d[${k}]=d[${k}]?1:0`);
      } else if (t === 'string') {
        lines.push(`if(typeof d[${k}]==='number'||typeof d[${k}]==='boolean')d[${k}]=String(d[${k}])`);
      } else if (t === 'boolean') {
        lines.push(`if(d[${k}]==='true'||d[${k}]==='1')d[${k}]=true`);
        lines.push(`if(d[${k}]==='false'||d[${k}]==='0')d[${k}]=false`);
      }
    }
  }

  // defaults: inline per property
  for (const [key, prop] of Object.entries(props)) {
    if (prop && typeof prop === 'object' && prop.default !== undefined) {
      const k = JSON.stringify(key);
      const def = JSON.stringify(prop.default);
      lines.push(`if(!(${k} in d))d[${k}]=${def}`);
    }
  }

  if (lines.length === 0) return null;
  try {
    return new Function('d', lines.join('\n'));
  } catch {
    return null;
  }
}

// Schema compilation cache: same schema string -> reuse compiled functions
const _compileCache = new Map();

// Object identity cache: same schema object reference -> reuse entire compiled state
// Skips JSON.stringify, cache lookup, and all setup. Near-zero cost for repeated schemas.
const _identityCache = new WeakMap();

const SIMDJSON_PADDING = 64;
const VALID_RESULT = Object.freeze({ valid: true, errors: Object.freeze([]) });
const ABORT_EARLY_RESULT = Object.freeze({ valid: false, errors: Object.freeze([Object.freeze({ message: 'validation failed' })]) });

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
  if (typeof Buffer === 'undefined') throw new Error('createPaddedBuffer requires Node.js Buffer');
  const jsonBuf = Buffer.from(jsonStr);
  const padded = Buffer.allocUnsafe(jsonBuf.length + SIMDJSON_PADDING);
  jsonBuf.copy(padded);
  padded.fill(0, jsonBuf.length);
  return { buffer: padded, length: jsonBuf.length };
}

function buildSchemaMap(schemas) {
  if (!schemas) return null
  const map = new Map()
  if (Array.isArray(schemas)) {
    for (const s of schemas) {
      normalizeDraft7(s)
      const id = s.$id
      if (!id) throw new Error('Schema in schemas option must have $id')
      map.set(id, s)
    }
  } else {
    for (const [key, s] of Object.entries(schemas)) {
      normalizeDraft7(s)
      map.set(s.$id || key, s)
    }
  }
  return map
}

// Resolve a relative URI ref against a base URI
function resolveRelativeRef(ref, baseId) {
  if (!baseId || ref.includes('://') || ref.startsWith('#')) return ref
  const lastSlash = baseId.lastIndexOf('/')
  if (lastSlash < 0) return ref
  return baseId.substring(0, lastSlash + 1) + ref
}

class Validator {
  constructor(schema, opts) {
    const options = opts || {};
    const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;

    // Ultra-fast path: same schema object reference -> return cached instance
    // JS constructor returning an object makes `new` return that object
    // Cost: one WeakMap lookup. No property copy, no setup, nothing.
    if (!opts && typeof schema === "object" && schema !== null) {
      const hit = _identityCache.get(schema);
      if (hit) return hit;
    }

    // Draft 7 normalization — convert keywords to 2020-12 equivalents in-place
    normalizeDraft7(schemaObj);

    this._schemaStr = null; // lazy: computed on first use
    this._schemaObj = schemaObj;
    this._options = options;
    this._initialized = false;
    this._nativeReady = false;
    this._compiled = null;
    this._fastSlot = -1;
    this._jsFn = null;
    this._preprocess = null;
    this._applyDefaults = null;

    // Schema map for cross-schema $ref resolution
    this._schemaMap = buildSchemaMap(options.schemas) || new Map();

    // Lazy stubs: trigger compilation on first call, then re-dispatch
    this.validate = (data) => {
      this._ensureCompiled();
      return this.validate(data);
    };
    this.isValidObject = (data) => {
      this._ensureCodegen();
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
    this.validateAndParse = (jsonStr) => {
      if (!native) throw new Error('Native addon required for validateAndParse()');
      this._ensureCompiled();
      return this.validateAndParse(jsonStr);
    };
    this.isValid = (buf) => {
      if (!native) throw new Error('Native addon required for isValid() — use validate() or isValidObject() instead');
      this._ensureCompiled();
      return this.isValid(buf);
    };
    this.countValid = (ndjsonBuf) => {
      if (!native) throw new Error('Native addon required for countValid()');
      this._ensureCompiled();
      return this.countValid(ndjsonBuf);
    };
    this.batchIsValid = (buffers) => {
      if (!native) throw new Error('Native addon required for batchIsValid()');
      this._ensureCompiled();
      return this.batchIsValid(buffers);
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
              path: parsePointerPath(err.instancePath),
            })),
          };
        },
      }),
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Tier 0 fast path: override isValidObject with a direct bound validator.
    // All other methods (validate, validateJSON, etc.) stay on the lazy stubs above.
    // Tier 0/1 are boolean-only; error paths continue through codegen.
    // After the 2nd call we upgrade to codegen (~4x faster warm path). One-shot
    // validators (fresh-schema cold-start users) never trigger the upgrade.
    const _tier = classify(schemaObj);
    if (_tier.tier === 0) {
      const _plan = buildTier0Plan(schemaObj);
      let _n = 0;
      this.isValidObject = (data) => {
        const r = tier0Validate(_plan, data);
        if (++_n === 2) {
          try { this._ensureCodegen(); } catch {}
        }
        return r;
      };
    }

    // Populate identity cache so repeated `new Validator(sameSchema)` short-circuits.
    if (!opts && typeof schema === "object" && schema !== null) {
      _identityCache.set(schema, this);
    }
  }

  _ensureCompiled() {
    if (this._initialized) return;
    this._initialized = true;

    const schemaObj = this._schemaObj;
    const options = this._options;

    // Lazy stringify — only computed here, not in constructor
    if (!this._schemaStr) this._schemaStr = JSON.stringify(schemaObj);

    // Check cache first -- reuse compiled functions for same schema
    const sm = this._schemaMap.size > 0 ? this._schemaMap : null;
    const mapKey = this._schemaMap.size > 0
      ? this._schemaStr + '\0' + [...this._schemaMap.keys()].sort().join('\0')
      : this._schemaStr;
    const cached = _compileCache.get(mapKey);
    let jsFn, jsCombinedFn, jsErrFn, _isCodegen = false;
    var _forceNapi = typeof process !== 'undefined' && process.env && process.env.ATA_FORCE_NAPI;
    if (cached && !_forceNapi) {
      jsFn = cached.jsFn;
      jsCombinedFn = cached.combined;
      jsErrFn = cached.errFn;
      _isCodegen = !!cached.isCodegen;
    } else if (!_forceNapi) {
      const _cgFn = compileToJSCodegen(schemaObj, sm);
      jsFn = _cgFn || compileToJS(schemaObj, null, sm);
      jsCombinedFn = compileToJSCombined(schemaObj, VALID_RESULT, sm);
      jsErrFn = compileToJSCodegenWithErrors(schemaObj, sm);
      _isCodegen = !!_cgFn;
      _compileCache.set(mapKey, { jsFn, combined: jsCombinedFn, errFn: jsErrFn, isCodegen: _isCodegen });
    } else {
      jsFn = null; jsCombinedFn = null; jsErrFn = null;
    }
    this._jsFn = jsFn;

    // Data mutators -- try codegen first (12x faster), fallback to closure arrays
    let preprocess = buildPreprocessCodegen(schemaObj, options);
    if (!preprocess) {
      const applyDefaults = buildDefaultsApplier(schemaObj);
      const applyCoerce = options.coerceTypes ? buildCoercer(schemaObj) : null;
      const applyRemove = options.removeAdditional
        ? buildRemover(schemaObj)
        : null;
      const mutators = [applyRemove, applyCoerce, applyDefaults].filter(Boolean);
      preprocess =
        mutators.length === 0
          ? null
          : mutators.length === 1
            ? mutators[0]
            : (data) => {
                for (let i = 0; i < mutators.length; i++) mutators[i](data);
              };
    }
    this._applyDefaults = preprocess;
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

    if (jsFn) {
      let safeErrFn = null;
      if (jsErrFn) {
        try {
          jsErrFn({}, true);
          safeErrFn = (d) => jsErrFn(d, true);
        } catch {}
      }
      // errFn: use JS codegen if safe, else lazy-native fallback
      // For unevaluated schemas without errFn, use jsFn as boolean-only fallback
      const hasUnevaluated = schemaObj && (schemaObj.unevaluatedProperties !== undefined || schemaObj.unevaluatedItems !== undefined || this._schemaStr.includes('unevaluatedProperties') || this._schemaStr.includes('unevaluatedItems'))
      const hasDynRef = this._schemaStr.includes('"$dynamicRef"') || this._schemaStr.includes('"$dynamicAnchor"')
      const errFn =
        safeErrFn ||
        (hasUnevaluated
          ? (d) => ({ valid: jsFn(d), errors: jsFn(d) ? [] : [{ code: 'unevaluated', path: '', message: 'unevaluated property or item' }] })
          : hasDynRef
            ? (d) => {
                this._ensureNative();
                return this._compiled.validateJSON(JSON.stringify(d));
              }
            : (d) => {
                this._ensureNative();
                return this._compiled.validate(d);
              });

      // Best path: combined validator (single pass, validates + collects errors)
      // Valid data: returns VALID_RESULT, no allocation
      // Invalid data: collects errors in one pass (no double validation)
      // Fallback: hybridFn or jsFn + errFn for schemas combined can't handle
      // Test combined at compile time -- some schemas produce broken combined code
      // Test combined at compile time -- some schemas (e.g. if/then/else)
      // produce broken combined code that crashes on certain inputs.
      // We probe with diverse data; if any throws, fall back to hybrid.
      let safeCombinedFn = null;
      if (jsCombinedFn) {
        try {
          const probe = {};
          // Populate probe with one key per known property to trigger nested paths
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

      if (options.abortEarly && jsFn && !hasDynRef) {
        // Abort-early fast path: skip detailed error collection on failure.
        // Returns a shared frozen result, no per-call allocation, no errFn work.
        const _fn = jsFn;
        this.validate = preprocess
          ? (data) => { preprocess(data); return _fn(data) ? VALID_RESULT : ABORT_EARLY_RESULT; }
          : (data) => (_fn(data) ? VALID_RESULT : ABORT_EARLY_RESULT);
      } else if (hasDynRef && _isCodegen && jsFn) {
        // $dynamicRef with JS codegen: direct path, no wrapper layers
        const _fn = jsFn, _efn = safeErrFn || errFn, _R = VALID_RESULT;
        this.validate = preprocess
          ? (data) => { preprocess(data); return _fn(data) ? _R : _efn(data); }
          : (data) => _fn(data) ? _R : _efn(data);
      } else if (hasDynRef) {
        // $dynamicRef without codegen: delegate to native C++ (interpretive path unreliable)
        this.validate = preprocess
          ? (data) => { preprocess(data); return errFn(data); }
          : errFn;
      } else if (jsFn && jsFn._hybridFactory) {
        // Zero-wrapper: hybridFactory bakes VALID_RESULT + errFn into a single function
        // No arrow function wrapper, no ternary, one function call
        const hybridFn = jsFn._hybridFactory(VALID_RESULT, safeCombinedFn || errFn);
        this.validate = preprocess
          ? (data) => { preprocess(data); return hybridFn(data); }
          : hybridFn;
      } else if (safeCombinedFn) {
        this.validate = preprocess
          ? (data) => { preprocess(data); return safeCombinedFn(data); }
          : safeCombinedFn;
      } else {
        const hybridFn = jsFn && jsFn._hybridFactory
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
      this.isValidObject = jsFn;
      const hybridFn = jsFn._hybridFactory
        ? jsFn._hybridFactory(VALID_RESULT, errFn)
        : null;
      const jsonValidateFn = safeCombinedFn
        || hybridFn
        || ((obj) => (jsFn(obj) ? VALID_RESULT : errFn(obj)));
      this.validateJSON = useSimdjsonForLarge && native
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
              if (!native) return { valid: false, errors: [{ keyword: 'syntax', instancePath: '', schemaPath: '#', params: {}, message: e.message }] };
            }
            this._ensureNative();
            return this._compiled.validateJSON(jsonStr);
          };
      this.isValidJSON = useSimdjsonForLarge && native
        ? (jsonStr) => {
            if (jsonStr.length >= SIMDJSON_THRESHOLD) {
              this._ensureNative();
              return native.rawFastValidate(
                this._fastSlot,
                Buffer.from(jsonStr),
              );
            }
            try {
              return jsFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
              return false;
            }
          }
        : (jsonStr) => {
            try {
              return jsFn(JSON.parse(jsonStr));
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
              return false;
            }
          };
      // validateAndParse: requires native addon for simdjson parsing
      if (native) {
        const self = this;
        this.validateAndParse = (jsonStr) => {
          self._ensureNative();
          self.validateAndParse = (s) => self._compiled.validateAndParse(s);
          return self.validateAndParse(jsonStr);
        };
      } else {
        this.validateAndParse = () => { throw new Error('Native addon required for validateAndParse()'); };
      }
      // Buffer APIs: lazy native init — only compile native schema on first buffer call.
      // This keeps cold start fast (JS codegen only) for users who only use validate().
      if (native) {
        const self = this;
        this.isValid = (buf) => {
          self._ensureNative();
          const slot = self._fastSlot;
          self.isValid = (b) => { if (typeof b === 'string') b = Buffer.from(b); return native.rawFastValidate(slot, b); };
          return self.isValid(buf);
        };
        this.countValid = (ndjsonBuf) => {
          self._ensureNative();
          const slot = self._fastSlot;
          self.countValid = (b) => { if (typeof b === 'string') b = Buffer.from(b); const r = native.rawNDJSONValidate(slot, b); let c = 0; for (let i = 0; i < r.length; i++) if (r[i]) c++; return c; };
          return self.countValid(ndjsonBuf);
        };
        this.batchIsValid = (buffers) => {
          self._ensureNative();
          const slot = self._fastSlot;
          self.batchIsValid = (bufs) => { let v = 0; for (const b of bufs) if (native.rawFastValidate(slot, b)) v++; return v; };
          return self.batchIsValid(buffers);
        };
      }
    } else if (native) {
      // Native-only path: no JS codegen, use native for everything
      this._ensureNative();
      const _hasDynamic = this._schemaStr.includes('"$dynamicRef"') || this._schemaStr.includes('"$dynamicAnchor"') || this._schemaStr.includes('"$anchor"')
      // For schemas with dynamic refs/anchors, use validateJSON (C++ path with full support)
      // instead of validate (NAPI direct V8 path without anchor maps)
      const _validate = _hasDynamic
        ? (data) => this._compiled.validateJSON(JSON.stringify(data))
        : (data) => this._compiled.validate(data);
      this.validate = preprocess
        ? (data) => {
            preprocess(data);
            return _validate(data);
          }
        : _validate;
      this.isValidObject = (data) => _validate(data).valid;
      this.validateJSON = (jsonStr) => this._compiled.validateJSON(jsonStr);
      this.isValidJSON = (jsonStr) => this._compiled.isValidJSON(jsonStr);
      this.validateAndParse = (jsonStr) => this._compiled.validateAndParse(jsonStr);
      {
        const slot = this._fastSlot;
        this.isValid = (buf) => {
          if (typeof buf === 'string') buf = Buffer.from(buf);
          return native.rawFastValidate(slot, buf);
        };
      }
      {
        const slot = this._fastSlot;
        this.countValid = (ndjsonBuf) => {
          if (typeof ndjsonBuf === 'string') ndjsonBuf = Buffer.from(ndjsonBuf);
          const results = native.rawNDJSONValidate(slot, ndjsonBuf);
          let count = 0;
          for (let i = 0; i < results.length; i++) if (results[i]) count++;
          return count;
        };
      }
      {
        const slot = this._fastSlot;
        this.batchIsValid = (buffers) => {
          let valid = 0;
          for (const buf of buffers) {
            if (native.rawFastValidate(slot, buf)) valid++;
          }
          return valid;
        };
      }
    }

    // Save to identity cache for ultra-fast reuse with same schema object
    if (this._schemaObj && typeof this._schemaObj === 'object') {
      _identityCache.set(this._schemaObj, this);
    }
  }

  _ensureNative() {
    if (this._nativeReady) return;
    this._nativeReady = true;
    if (!native) return;
    let nativeSchemaStr = this._schemaStr;
    if (this._schemaMap.size > 0) {
      const merged = JSON.parse(this._schemaStr);
      if (!merged.$defs) merged.$defs = {};
      for (const [id, s] of this._schemaMap) {
        merged.$defs['__ext_' + id.replace(/[^a-zA-Z0-9]/g, '_')] = s;
      }
      nativeSchemaStr = JSON.stringify(merged);
    }
    this._compiled = new native.CompiledSchema(nativeSchemaStr);
    this._fastSlot = native.fastRegister(nativeSchemaStr);
  }

  addSchema(schema) {
    if (this._initialized) {
      throw new Error('Cannot add schema after compilation — call addSchema() before validate()')
    }
    if (!schema || !schema.$id) {
      throw new Error('Schema must have $id')
    }
    // Apply Draft 7 normalization if needed
    normalizeDraft7(schema)
    this._schemaMap.set(schema.$id, schema)
  }

  _ensureCodegen() {
    if (this._jsFn) return;
    if (typeof process !== 'undefined' && process.env && process.env.ATA_FORCE_NAPI) return;
    if (!this._schemaStr) this._schemaStr = JSON.stringify(this._schemaObj);
    const sm = this._schemaMap.size > 0 ? this._schemaMap : null;
    const mapKey = this._schemaMap.size > 0
      ? this._schemaStr + '\0' + [...this._schemaMap.keys()].sort().join('\0')
      : this._schemaStr;
    const cached = _compileCache.get(mapKey);
    if (cached && cached.jsFn) {
      this._jsFn = cached.jsFn;
      this.isValidObject = cached.jsFn;
      return;
    }
    const jsFn = compileToJSCodegen(this._schemaObj, sm) || compileToJS(this._schemaObj, null, sm);
    this._jsFn = jsFn;
    if (jsFn) {
      this.isValidObject = jsFn;
      // seed cache with codegen, combined/errFn filled later by _ensureCompiled
      if (!cached) _compileCache.set(mapKey, { jsFn, combined: null, errFn: null });
      else cached.jsFn = jsFn;
    }
  }

  // --- Standalone pre-compilation ---
  // Generate a JS module string that can be written to a file.
  // On next startup, load with Validator.fromStandalone() -- zero compile time.
  toStandalone() {
    this._ensureCompiled();
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

    v.validateAndParse = native
      ? (jsonStr) => {
          v._ensureNative();
          v.validateAndParse = (s) => v._compiled.validateAndParse(s);
          return v.validateAndParse(jsonStr);
        }
      : () => { throw new Error('Native addon required for validateAndParse()'); };

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
              path: parsePointerPath(e.instancePath),
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
    if (!native) throw new Error('Native addon required for isValid() — install build tools or use validate() instead');
    this._ensureNative();
    return native.rawFastValidate(this._fastSlot, input);
  }

  // Zero-copy pre-padded path
  isValidPrepadded(paddedBuffer, jsonLength) {
    if (!native) throw new Error('Native addon required for isValidPrepadded()');
    this._ensureNative();
    return native.rawFastValidate(this._fastSlot, paddedBuffer, jsonLength);
  }

  // Parallel NDJSON batch (multi-core)
  isValidParallel(buffer) {
    if (!native) throw new Error('Native addon required for isValidParallel()');
    this._ensureNative();
    return native.rawParallelValidate(this._fastSlot, buffer);
  }

  // Parallel count (fastest -- single uint32 return)
  countValid(buffer) {
    if (!native) throw new Error('Native addon required for countValid()');
    this._ensureNative();
    return native.rawParallelCount(this._fastSlot, buffer);
  }

  // NDJSON single-thread batch
  isValidNDJSON(buffer) {
    if (!native) throw new Error('Native addon required for isValidNDJSON()');
    this._ensureNative();
    return native.rawNDJSONValidate(this._fastSlot, buffer);
  }
}

function validate(schema, data) {
  if (native) {
    const schemaStr =
      typeof schema === "string" ? schema : JSON.stringify(schema);
    return native.validate(schemaStr, data);
  }
  // JS fallback: compile and validate
  const v = new Validator(typeof schema === "string" ? JSON.parse(schema) : schema);
  return v.validate(data);
}

function version() {
  if (native) return native.version();
  try { return require("./package.json").version; } catch { return "unknown"; }
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

const parseJSON = native ? native.parseJSON : JSON.parse;

// Ultra-fast compile: returns validate function directly, no Validator wrapper
// WeakMap cached — second call with same schema object is ~3ns
const _compileFnCache = new WeakMap();
function compile(schema, opts) {
  if (!opts && typeof schema === 'object' && schema !== null) {
    const hit = _compileFnCache.get(schema);
    if (hit) return hit;
  }
  const v = new Validator(schema, opts);
  v._ensureCompiled();
  const fn = v.validate;
  if (!opts && typeof schema === 'object' && schema !== null) {
    _compileFnCache.set(schema, fn);
  }
  return fn;
}

module.exports = {
  Validator,
  compile,
  validate,
  version,
  createPaddedBuffer,
  SIMDJSON_PADDING,
  parseJSON,
};
