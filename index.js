const native = require("node-gyp-build")(__dirname);

class Validator {
  constructor(schema) {
    const schemaStr =
      typeof schema === "string" ? schema : JSON.stringify(schema);
    this._compiled = new native.CompiledSchema(schemaStr);
  }

  // Validates data directly — no JSON.stringify overhead
  // Accepts JS objects, arrays, strings, numbers, booleans, null
  validate(data) {
    return this._compiled.validate(data);
  }

  // Force JSON string path (simdjson parse + validate)
  validateJSON(jsonStr) {
    return this._compiled.validateJSON(jsonStr);
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

module.exports = { Validator, validate, version };
