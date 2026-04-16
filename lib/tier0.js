'use strict';

// Tier 0 fast path: shared parametric validator for simple schemas.
// All tier-0 Validators call the same tier0Validate() function;
// the per-instance difference is the plan object.
// V8 sees one function with monomorphic hidden classes and JIT-compiles it once.

const TYPE_MASK = {
  string: 1,
  number: 2,
  integer: 4,
  boolean: 8,
};

// Hoist the bitmask constants so checkPrimitive stays monomorphic on the hot path.
const T_STRING = TYPE_MASK.string;
const T_NUMBER = TYPE_MASK.number;
const T_INTEGER = TYPE_MASK.integer;
const T_BOOLEAN = TYPE_MASK.boolean;

// Build a constraint tuple for one primitive-typed property (or top-level primitive).
// All fields are initialized to neutral defaults so every constraint object shares the same
// hidden class — critical for V8 to keep the shared validator monomorphic.
function primConstraint(key, propSchema) {
  const t = propSchema.type;
  const hasEnum = Array.isArray(propSchema.enum);
  const hasConst = propSchema.const !== undefined;
  return {
    key,
    typeMask: TYPE_MASK[t] | 0,
    hasEnum,
    enumSet: hasEnum ? new Set(propSchema.enum) : null,
    hasConst,
    constVal: hasConst ? propSchema.const : undefined,
    formatId: 0, // reserved for future format integration
    minLen: typeof propSchema.minLength === 'number' ? propSchema.minLength : -1,
    maxLen: typeof propSchema.maxLength === 'number' ? propSchema.maxLength : -1,
    min: typeof propSchema.minimum === 'number' ? propSchema.minimum : NaN,
    max: typeof propSchema.maximum === 'number' ? propSchema.maximum : NaN,
    exclMin: typeof propSchema.exclusiveMinimum === 'number' ? propSchema.exclusiveMinimum : NaN,
    exclMax: typeof propSchema.exclusiveMaximum === 'number' ? propSchema.exclusiveMaximum : NaN,
    multipleOf: typeof propSchema.multipleOf === 'number' ? propSchema.multipleOf : NaN,
  };
}

function buildTier0Plan(schema) {
  if (schema.type !== 'object') {
    return {
      isPrimitive: true,
      constraints: [primConstraint('__root__', schema)],
      requiredMask: 0,
      additionalAllowed: true,
      knownKeys: null,
    };
  }
  const props = schema.properties || {};
  const keys = Object.keys(props);
  const required = schema.required ? new Set(schema.required) : null;
  const constraints = new Array(keys.length);
  const knownKeys = new Set();
  let requiredMask = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    constraints[i] = primConstraint(k, props[k]);
    knownKeys.add(k);
    if (required && required.has(k)) requiredMask |= (1 << i);
  }
  return {
    isPrimitive: false,
    constraints,
    requiredMask,
    additionalAllowed: schema.additionalProperties !== false,
    knownKeys,
  };
}

// checkPrimitive is exported for reuse by Tier 1.
function checkPrimitive(c, v) {
  const m = c.typeMask;
  if (m === T_STRING) {
    if (typeof v !== 'string') return false;
    if (c.minLen >= 0 && v.length < c.minLen) return false;
    if (c.maxLen >= 0 && v.length > c.maxLen) return false;
  } else if (m === T_INTEGER) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return false;
    if (!Number.isNaN(c.min) && v < c.min) return false;
    if (!Number.isNaN(c.max) && v > c.max) return false;
    if (!Number.isNaN(c.exclMin) && v <= c.exclMin) return false;
    if (!Number.isNaN(c.exclMax) && v >= c.exclMax) return false;
    if (!Number.isNaN(c.multipleOf) && v % c.multipleOf !== 0) return false;
  } else if (m === T_NUMBER) {
    if (typeof v !== 'number') return false;
    if (!Number.isNaN(c.min) && v < c.min) return false;
    if (!Number.isNaN(c.max) && v > c.max) return false;
    if (!Number.isNaN(c.exclMin) && v <= c.exclMin) return false;
    if (!Number.isNaN(c.exclMax) && v >= c.exclMax) return false;
    if (!Number.isNaN(c.multipleOf) && v % c.multipleOf !== 0) return false;
  } else if (m === T_BOOLEAN) {
    if (typeof v !== 'boolean') return false;
  } else {
    return false;
  }
  if (c.hasEnum && !c.enumSet.has(v)) return false;
  if (c.hasConst && v !== c.constVal) return false;
  return true;
}

function tier0Validate(plan, data) {
  if (plan.isPrimitive) {
    return checkPrimitive(plan.constraints[0], data);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const cs = plan.constraints;
  const n = cs.length;
  const reqMask = plan.requiredMask;
  let seenMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cs[i];
    const v = data[c.key];
    if (v === undefined) {
      if (reqMask & (1 << i)) return false;
      continue;
    }
    seenMask |= (1 << i);
    if (!checkPrimitive(c, v)) return false;
  }
  if ((seenMask & reqMask) !== reqMask) return false;
  if (!plan.additionalAllowed) {
    const known = plan.knownKeys;
    for (const k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      if (!known.has(k)) return false;
    }
  }
  return true;
}

module.exports = {
  buildTier0Plan,
  tier0Validate,
  checkPrimitive,
  TYPE_MASK,
};
