const { Validator } = require("./index");

class Ata {
  constructor(opts = {}) {
    this._opts = opts;
    this._schemas = new Map();
  }

  compile(schema) {
    const v = new Validator(schema);
    const validate = (data) => {
      const result = v.validate(data);
      validate.errors = result.valid
        ? null
        : result.errors.map((e) => ({
            instancePath: e.path ? "/" + e.path.replace(/\//g, "/") : "",
            schemaPath: "",
            keyword: "",
            params: {},
            message: e.message,
          }));
      return result.valid;
    };
    validate.errors = null;
    validate.schema = schema;
    return validate;
  }

  validate(schema, data) {
    const validate = this.compile(schema);
    return validate(data);
  }

  addSchema(schema, key) {
    if (key) {
      this._schemas.set(key, schema);
    } else if (schema.$id) {
      this._schemas.set(schema.$id, schema);
    }
    return this;
  }

  getSchema(key) {
    const schema = this._schemas.get(key);
    if (schema) return this.compile(schema);
    return undefined;
  }
}

module.exports = Ata;
module.exports.default = Ata;
