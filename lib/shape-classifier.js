'use strict';

// Classifies a JSON Schema into one of three execution tiers:
//   0 - simple object or top-level primitive, fast-path validator
//   1 - nested objects/arrays, no composition, generic interpreter
//   2 - composition, $ref, dynamic, etc. -> existing codegen
//
// Tier 0/1 validators are BOOLEAN only. Error-returning paths stay on codegen.

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

// Meta keywords that are always safe to see at any node (annotations, no validation impact)
const META_KEYS = new Set([
  '$schema', '$id', '$comment',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
]);

const TIER0_OBJECT_ALLOWED = new Set([
  'type', 'properties', 'required', 'additionalProperties',
  ...META_KEYS,
]);

const TIER0_PRIMITIVE_ALLOWED = new Set([
  'type', 'enum', 'const',
  'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'format',
  ...META_KEYS,
]);

const MAX_TIER0_PROPS = 10;
const MAX_TIER0_ENUM = 256;

function isPrimitiveType(t) {
  return typeof t === 'string' && PRIMITIVE_TYPES.has(t);
}

function isPrimitiveEnumValue(v) {
  const t = typeof v;
  return v === null || t === 'string' || t === 'number' || t === 'boolean';
}

function isTier0Primitive(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  if (!isPrimitiveType(schema.type)) return false;
  for (const k of Object.keys(schema)) {
    if (!TIER0_PRIMITIVE_ALLOWED.has(k)) return false;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) return false;
    if (schema.enum.length === 0 || schema.enum.length > MAX_TIER0_ENUM) return false;
    for (const v of schema.enum) {
      if (!isPrimitiveEnumValue(v)) return false;
    }
  }
  if (schema.const !== undefined && !isPrimitiveEnumValue(schema.const)) return false;
  return true;
}

function isTier0Object(schema) {
  if (schema.type !== 'object') return false;
  for (const k of Object.keys(schema)) {
    if (!TIER0_OBJECT_ALLOWED.has(k)) return false;
  }
  const props = schema.properties;
  if (props === undefined) return true; // empty object with no property constraints is legal
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return false;
  const keys = Object.keys(props);
  if (keys.length > MAX_TIER0_PROPS) return false;
  for (const k of keys) {
    if (!isTier0Primitive(props[k])) return false;
  }
  const ap = schema.additionalProperties;
  if (ap !== undefined && ap !== true && ap !== false) return false;
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) return false;
    for (const r of schema.required) if (typeof r !== 'string') return false;
  }
  return true;
}

function classify(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { tier: 2, plan: null };
  }
  if (isTier0Primitive(schema)) return { tier: 0, plan: null };
  if (isTier0Object(schema)) return { tier: 0, plan: null };
  return { tier: 2, plan: null };
}

module.exports = {
  classify,
  MAX_TIER0_PROPS,
  MAX_TIER0_ENUM,
  PRIMITIVE_TYPES,
};
