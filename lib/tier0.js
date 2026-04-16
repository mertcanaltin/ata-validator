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

const T_STRING = TYPE_MASK.string;
const T_NUMBER = TYPE_MASK.number;
const T_INTEGER = TYPE_MASK.integer;
const T_BOOLEAN = TYPE_MASK.boolean;

// Numeric constraint flags, packed into constraint.numFlags.
// Using bit flags means the validator does a cheap bitwise-and instead of
// five Number.isNaN() calls per numeric property when only one bound is set.
const F_MIN = 1;
const F_MAX = 2;
const F_EXCL_MIN = 4;
const F_EXCL_MAX = 8;
const F_MULT = 16;

// Build a constraint tuple for one primitive-typed property.
// All fields have the same layout so every constraint shares one hidden class.
function primConstraint(key, propSchema) {
  const t = propSchema.type;
  const hasEnum = Array.isArray(propSchema.enum);
  const hasConst = propSchema.const !== undefined;
  let numFlags = 0;
  if (typeof propSchema.minimum === 'number') numFlags |= F_MIN;
  if (typeof propSchema.maximum === 'number') numFlags |= F_MAX;
  if (typeof propSchema.exclusiveMinimum === 'number') numFlags |= F_EXCL_MIN;
  if (typeof propSchema.exclusiveMaximum === 'number') numFlags |= F_EXCL_MAX;
  if (typeof propSchema.multipleOf === 'number') numFlags |= F_MULT;
  return {
    key,
    typeMask: TYPE_MASK[t] | 0,
    numFlags,
    hasEnum,
    hasConst,
    enumSet: hasEnum ? new Set(propSchema.enum) : null,
    constVal: hasConst ? propSchema.const : undefined,
    minLen: typeof propSchema.minLength === 'number' ? propSchema.minLength : -1,
    maxLen: typeof propSchema.maxLength === 'number' ? propSchema.maxLength : -1,
    min: typeof propSchema.minimum === 'number' ? propSchema.minimum : 0,
    max: typeof propSchema.maximum === 'number' ? propSchema.maximum : 0,
    exclMin: typeof propSchema.exclusiveMinimum === 'number' ? propSchema.exclusiveMinimum : 0,
    exclMax: typeof propSchema.exclusiveMaximum === 'number' ? propSchema.exclusiveMaximum : 0,
    multipleOf: typeof propSchema.multipleOf === 'number' ? propSchema.multipleOf : 0,
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

// checkPrimitive stays exported for Tier 1 reuse.
function checkPrimitive(c, v) {
  const m = c.typeMask;
  if (m === T_STRING) {
    if (typeof v !== 'string') return false;
    const minLen = c.minLen;
    const maxLen = c.maxLen;
    if (minLen >= 0 && v.length < minLen) return false;
    if (maxLen >= 0 && v.length > maxLen) return false;
  } else if (m === T_INTEGER) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return false;
    const f = c.numFlags;
    if (f !== 0) {
      if ((f & F_MIN) && v < c.min) return false;
      if ((f & F_MAX) && v > c.max) return false;
      if ((f & F_EXCL_MIN) && v <= c.exclMin) return false;
      if ((f & F_EXCL_MAX) && v >= c.exclMax) return false;
      if ((f & F_MULT) && v % c.multipleOf !== 0) return false;
    }
  } else if (m === T_NUMBER) {
    if (typeof v !== 'number') return false;
    const f = c.numFlags;
    if (f !== 0) {
      if ((f & F_MIN) && v < c.min) return false;
      if ((f & F_MAX) && v > c.max) return false;
      if ((f & F_EXCL_MIN) && v <= c.exclMin) return false;
      if ((f & F_EXCL_MAX) && v >= c.exclMax) return false;
      if ((f & F_MULT) && v % c.multipleOf !== 0) return false;
    }
  } else if (m === T_BOOLEAN) {
    if (typeof v !== 'boolean') return false;
  } else {
    return false;
  }
  if (c.hasEnum && !c.enumSet.has(v)) return false;
  if (c.hasConst && v !== c.constVal) return false;
  return true;
}

// Inlined object validator. Separating the primitive path removes a dead
// branch from the hot object path.
function tier0ValidateObject(plan, data) {
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
    // Inlined type + constraint check
    const m = c.typeMask;
    if (m === T_STRING) {
      if (typeof v !== 'string') return false;
      const minLen = c.minLen;
      const maxLen = c.maxLen;
      if (minLen >= 0 && v.length < minLen) return false;
      if (maxLen >= 0 && v.length > maxLen) return false;
    } else if (m === T_INTEGER) {
      if (typeof v !== 'number' || !Number.isInteger(v)) return false;
      const f = c.numFlags;
      if (f !== 0) {
        if ((f & F_MIN) && v < c.min) return false;
        if ((f & F_MAX) && v > c.max) return false;
        if ((f & F_EXCL_MIN) && v <= c.exclMin) return false;
        if ((f & F_EXCL_MAX) && v >= c.exclMax) return false;
        if ((f & F_MULT) && v % c.multipleOf !== 0) return false;
      }
    } else if (m === T_NUMBER) {
      if (typeof v !== 'number') return false;
      const f = c.numFlags;
      if (f !== 0) {
        if ((f & F_MIN) && v < c.min) return false;
        if ((f & F_MAX) && v > c.max) return false;
        if ((f & F_EXCL_MIN) && v <= c.exclMin) return false;
        if ((f & F_EXCL_MAX) && v >= c.exclMax) return false;
        if ((f & F_MULT) && v % c.multipleOf !== 0) return false;
      }
    } else if (m === T_BOOLEAN) {
      if (typeof v !== 'boolean') return false;
    } else {
      return false;
    }
    if (c.hasEnum && !c.enumSet.has(v)) return false;
    if (c.hasConst && v !== c.constVal) return false;
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

function tier0Validate(plan, data) {
  if (plan.isPrimitive) return checkPrimitive(plan.constraints[0], data);
  return tier0ValidateObject(plan, data);
}

module.exports = {
  buildTier0Plan,
  tier0Validate,
  tier0ValidateObject,
  checkPrimitive,
  TYPE_MASK,
};
