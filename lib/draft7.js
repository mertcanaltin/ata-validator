'use strict'

const DRAFT7_SCHEMAS = new Set([
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
])

function isDraft7(schema) {
  return !!(schema && schema.$schema && DRAFT7_SCHEMAS.has(schema.$schema))
}

function normalizeDraft7(schema) {
  if (!isDraft7(schema)) return schema
  _normalize(schema)
  return schema
}

function _normalize(schema) {
  if (typeof schema !== 'object' || schema === null) return

  // definitions → $defs
  if (schema.definitions && !schema.$defs) {
    schema.$defs = schema.definitions
    delete schema.definitions
  }

  // dependencies → dependentSchemas + dependentRequired
  if (schema.dependencies) {
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (Array.isArray(value)) {
        if (!schema.dependentRequired) schema.dependentRequired = {}
        schema.dependentRequired[key] = value
      } else {
        if (!schema.dependentSchemas) schema.dependentSchemas = {}
        schema.dependentSchemas[key] = value
      }
    }
    delete schema.dependencies
  }

  // items (array form) → prefixItems + items/additionalItems swap
  if (Array.isArray(schema.items)) {
    schema.prefixItems = schema.items
    if (schema.additionalItems !== undefined) {
      schema.items = schema.additionalItems
      delete schema.additionalItems
    } else {
      delete schema.items
    }
  }

  // Recurse into object-valued sub-schemas
  const objSubs = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
  for (const key of objSubs) {
    if (schema[key] && typeof schema[key] === 'object') {
      for (const v of Object.values(schema[key])) {
        if (typeof v === 'object' && v !== null) _normalize(v)
      }
    }
  }

  // Recurse into array-valued sub-schemas
  const arrSubs = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
  for (const key of arrSubs) {
    if (Array.isArray(schema[key])) {
      for (const s of schema[key]) {
        if (typeof s === 'object' && s !== null) _normalize(s)
      }
    }
  }

  // Recurse into single sub-schemas
  const singleSubs = ['items', 'contains', 'not', 'if', 'then', 'else',
                       'additionalProperties', 'propertyNames']
  for (const key of singleSubs) {
    if (typeof schema[key] === 'object' && schema[key] !== null) {
      _normalize(schema[key])
    }
  }
}

module.exports = { isDraft7, normalizeDraft7 }
