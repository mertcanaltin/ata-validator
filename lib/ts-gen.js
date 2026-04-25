'use strict';

// Schema -> TypeScript type declaration.
// Emits an interface or type alias for each top-level schema, plus
// `isValid` (type predicate) and `validate` signatures.
//
// Scope: the common shapes in real-world APIs.
//   - type: string | number | integer | boolean | null | array | object
//   - properties + required (required field narrows to required, optional to optional)
//   - enum (narrows to literal union)
//   - const (narrows to literal)
//   - items (array element type)
//   - oneOf / anyOf (union)
//   - $ref to local $defs (resolved by name)
// Falls back to `unknown` for shapes we cannot represent.

function renderValueType(schema, defs, depth = 0) {
  if (depth > 32) return 'unknown';
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema !== 'object' || schema === null) return 'unknown';

  // $ref to local $defs
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (m && defs && defs[m[1]]) return toTypeName(m[1]);
    return 'unknown';
  }

  // const narrows to literal
  if (schema.const !== undefined) return renderLiteral(schema.const);

  // enum narrows to literal union
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(renderLiteral).join(' | ') || 'never';
  }

  // oneOf / anyOf → union
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((s) => renderValueType(s, defs, depth + 1)).join(' | ') || 'unknown';
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((s) => renderValueType(s, defs, depth + 1)).join(' | ') || 'unknown';
  }

  // type
  const t = schema.type;
  if (Array.isArray(t)) {
    return t.map((tt) => renderValueType({ ...schema, type: tt }, defs, depth + 1)).join(' | ');
  }

  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'null') return 'null';

  if (t === 'array') {
    const items = schema.items;
    if (items === undefined || items === true) return 'unknown[]';
    const inner = renderValueType(items, defs, depth + 1);
    return inner.includes(' | ') ? `Array<${inner}>` : `${inner}[]`;
  }

  if (t === 'object' || (!t && schema.properties)) {
    return renderObject(schema, defs, depth + 1);
  }

  return 'unknown';
}

function renderObject(schema, defs, depth) {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    if (schema.additionalProperties === false) return 'Record<string, never>';
    const ap = schema.additionalProperties;
    if (ap && typeof ap === 'object') {
      return `Record<string, ${renderValueType(ap, defs, depth + 1)}>`;
    }
    return 'Record<string, unknown>';
  }
  const lines = keys.map((k) => {
    const t = renderValueType(props[k], defs, depth + 1);
    const opt = required.has(k) ? '' : '?';
    const safeKey = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    const desc = typeof props[k] === 'object' && props[k] && typeof props[k].description === 'string'
      ? `  /** ${props[k].description.replace(/\*\//g, '* /')} */\n`
      : '';
    return `${desc}  ${safeKey}${opt}: ${t};`;
  });
  // extra keys when additionalProperties is present as a schema or true
  const extra = schema.additionalProperties;
  if (extra && typeof extra === 'object') {
    // TypeScript requires the index signature to be a supertype of every
    // named property's emitted type. Widen to a union covering each property
    // type, plus undefined when any property is optional.
    const widen = new Set();
    widen.add(renderValueType(extra, defs, depth + 1));
    let hasOptional = false;
    for (const k of keys) {
      widen.add(renderValueType(props[k], defs, depth + 1));
      if (!required.has(k)) hasOptional = true;
    }
    if (hasOptional) widen.add('undefined');
    const indexType = widen.has('unknown') ? 'unknown' : Array.from(widen).join(' | ');
    lines.push(`  [key: string]: ${indexType};`);
  }
  return `{\n${lines.join('\n')}\n}`;
}

function renderLiteral(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return 'unknown';
}

function toTypeName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (cleaned === '') return '_Anon';
  if (/^[0-9]/.test(cleaned)) return `_${cleaned}`;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Public: given a schema and optional type name, return a .d.ts source.
function toTypeScript(schema, opts) {
  const options = opts || {};
  const rootName = toTypeName(options.name || 'Data');
  const defs = schema && (schema.$defs || schema.definitions);

  const defLines = [];
  if (defs && typeof defs === 'object') {
    for (const [defName, defSchema] of Object.entries(defs)) {
      const body = renderValueType(defSchema, defs, 0);
      defLines.push(`export type ${toTypeName(defName)} = ${body};`);
    }
  }

  const rootType = renderValueType(schema, defs, 0);
  // Use `interface` only for a pure object literal; otherwise fall back to
  // `type`. Catches cases like `{...}[]` (array of object) and `Record<...>`
  // which are valid TS but cannot be expressed as an interface body.
  const isPureObjectLiteral = rootType.startsWith('{') && rootType.endsWith('}') && !rootType.includes(' | ');
  const rootDecl = isPureObjectLiteral
    ? `export interface ${rootName} ${rootType}`
    : `export type ${rootName} = ${rootType};`;

  return `// Auto-generated by ata-validator — do not edit.
${defLines.length ? defLines.join('\n\n') + '\n\n' : ''}${rootDecl}

export interface ValidationError {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
}

export interface ValidResult {
  valid: true;
  errors: readonly never[];
}
export interface InvalidResult {
  valid: false;
  errors: readonly ValidationError[];
}
export type Result = ValidResult | InvalidResult;

export declare function isValid(data: unknown): data is ${rootName};
export declare function validate(data: unknown): Result;
declare const _default: { validate: typeof validate; isValid: typeof isValid };
export default _default;
`;
}

module.exports = { toTypeScript };
