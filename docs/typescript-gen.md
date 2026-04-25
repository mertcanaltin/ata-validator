# TypeScript type generation

`ata compile` emits a self-contained validator module plus a `.d.mts`
declaration. This page documents what the generator captures in the type
system, what stays runtime-only, and the design choices that come up when
JSON Schema and TypeScript do not have a one-to-one correspondence.

## Quick example

Given `schemas/user.json`:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "integer", "minimum": 1 },
    "name": { "type": "string", "minLength": 1, "maxLength": 100 },
    "email": { "type": "string", "format": "email" }
  },
  "required": ["id", "name", "email"]
}
```

Run:

```bash
npx ata compile schemas/user.json -o src/user.validator.mjs --name User
```

You get `src/user.validator.mjs` and `src/user.validator.d.mts`. The
declaration looks like:

```ts
export interface User {
  /** @minimum 1 */
  id: number;
  /**
   * @minLength 1
   * @maxLength 100
   */
  name: string;
  /** @format email */
  email: string;
  [key: string]: unknown;
}

export declare function isValid(data: unknown): data is User;
export declare function validate(data: unknown): Result;
```

Use it from a handler:

```ts
import { isValid, type User } from './user.validator.mjs'

if (!isValid(body)) return new Response('invalid', { status: 400 })
// body is typed as User from here on
const user: User = body
```

The generated module has zero runtime dependency on `ata-validator`. The
emitted file is around 1 KB gzipped per schema.

## What the type captures

The generator turns these schema features into static type information:

- `type`: `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`
- `properties` plus `required`: object shape with optional and required keys
- `enum`: literal union (`'admin' | 'user'`)
- `const`: literal type
- `oneOf`, `anyOf`: both emitted as a TypeScript union of the alternative
  shapes. Note that TypeScript unions are inclusive (`A | B` allows values
  matching both), so the `oneOf` exclusivity is enforced only at runtime
- `items`: array element type
- `prefixItems`: tuple, with elements beyond `minItems` made optional
- `additionalProperties`: index signature widened to be compatible with
  the named property types
- `$ref` to local `$defs` or `definitions`: resolved to the named alias
- `description`, `default`, `examples`, `deprecated`: rendered into the
  JSDoc block on the property or type

`isValid` is emitted as a TypeScript type predicate, so a successful check
narrows the value at the call site:

```ts
import { isValid, type User } from './schemas/user.validator.mjs'

if (isValid(body)) {
  // `body` is typed as User from here on
  return body.id
}
```

## What stays runtime-only

TypeScript cannot enforce most of the value-level constraints JSON Schema
expresses. The generator preserves them as JSDoc tags so editors and
TypeDoc surface them on hover, and so reviewers can see the contract even
when `tsc` cannot:

| Schema keyword                       | JSDoc tag           | Enforced by |
|--------------------------------------|---------------------|-------------|
| `minLength`, `maxLength`             | `@minLength`, `@maxLength` | Runtime |
| `minItems`, `maxItems`               | `@minItems`, `@maxItems` | Runtime |
| `minProperties`, `maxProperties`     | same name           | Runtime |
| `minimum`, `maximum`                 | `@minimum`, `@maximum` | Runtime |
| `exclusiveMinimum`, `exclusiveMaximum` | same name         | Runtime |
| `multipleOf`                         | `@multipleOf`       | Runtime |
| `pattern`                            | `@pattern`          | Runtime |
| `format` (`email`, `date`, ...)      | `@format`           | Runtime, in assertion mode |
| `uniqueItems`                        | `@uniqueItems`      | Runtime |

Conditional schemas (`if` / `then` / `else`, `dependentSchemas`) are also
runtime-only: the generator emits the static union of the branches when
their shape is statically determinable, but the conditional discriminator
itself is not represented in the type.

## Design choices

### Excess properties

When a schema declares `properties` without setting
`additionalProperties: false`, JSON Schema accepts any extra keys. The
emitted interface includes a permissive index signature so `tsc` does not
reject excess properties the runtime would consider valid:

```ts
// Schema: { type: 'object', properties: { id: { type: 'integer' } } }
export interface T {
  id: number
  [key: string]: unknown
}
```

Set `additionalProperties: false` in the schema to opt into a closed
shape; the index signature is then omitted.

### Optional tuple elements

`prefixItems` does not require its entries to be present unless `minItems`
forces them. The generator marks tuple elements at indices `>= minItems`
as optional:

```ts
// Schema: { type: 'array', prefixItems: [{type:'string'}, {type:'number'}], items: false }
export type T = [string?, number?]
```

Setting `minItems` tightens this:

```ts
// Same schema with minItems: 2
export type T = [string, number]
```

### Schemas without `type`

A schema that uses `properties` or `required` but does not declare
`type: 'object'` technically passes non-object values at runtime. The
generator still emits an object type because that matches schema author
intent in practice. If you genuinely want a permissive schema, omit
`properties` and `required` so the generator falls back to `unknown`.

### Anonymous `$defs` keys

JSON Schema permits empty-string keys in `$defs`, which would produce an
unnamed type alias. The generator emits `_Anon` (or `_AnonN` for nested
anonymous entries) so the `.d.mts` stays valid TypeScript.

## Verifying generator output

Three test runners ship with the project:

- `npm run test:ts`: hand-written fixtures covering specific edge cases.
- `npm run test:ts-corpus`: every schema in the JSON Schema Test Suite is
  passed through the generator and `tsc`. Failures here mean the emitted
  `.d.mts` does not parse or does not type-check.
- `npm run test:ts-differential`: data the runtime marks as valid is
  asserted assignable to the emitted type. Failures here mean the type
  is strictly narrower than the runtime contract.

Both corpus runners accept `CORPUS_DRAFT=draft7` to switch from the
default `draft2020-12`. CI runs all five (fixtures, corpus 2020-12, corpus
draft 7, differential 2020-12, differential draft 7) on every push and
pull request.

## FAQ

### Do I need `ata-validator` at runtime when I use the compiled output?

No. The generated `.mjs` is self-contained: it inlines the validation
logic, has no `import` of `ata-validator`, and runs unchanged on Node,
Bun, Deno, edge runtimes, and browsers.

### What does the bundle size look like?

Around 1 KB gzipped per schema in the typical case. Schemas with many
constraints, `pattern` keywords, or deep `$ref` graphs grow with the
number of distinct rules. Run `ata compile` and `gzip -c | wc -c` to
measure your own.

### How do cross-document `$ref` references work?

`$ref` is resolved against the schema's own `$defs` or `definitions`
section. Cross-document references (`$ref` pointing at a different file
or remote URL) are not inlined; they fall back to `unknown` in the
emitted type. Bundle the referenced schemas into a single document
before running `ata compile` if you need them resolved.

### Can I generate a validator without the CLI?

Yes. The same code path is exposed programmatically:

```ts
import { Validator } from 'ata-validator'
import { toTypeScript } from 'ata-validator/lib/ts-gen'

const v = new Validator(schema)
const mjs = v.toStandaloneModule({ format: 'esm' })
const dts = toTypeScript(schema, { name: 'User' })
```

This is what `ata-vite` uses to regenerate validators on schema changes.

### What if my schema has a property named `toString` or `constructor`?

The generated interface emits these as ordinary members. `tsc` may
complain when a member shadows a narrower built-in (`Object.prototype.toString`
returns `string`, your schema may type it differently). The runtime
validator handles such property names correctly; the type-side warning
is from TypeScript treating the interface as extending `object` by
default. Rename the property in the schema if you need clean
TypeScript types.

### Can I add custom JSDoc tags to the generated output?

Not yet through the CLI. The generator reads `description`, `default`,
`examples`, `deprecated`, and the standard JSON Schema constraint
keywords. Open an issue if there is a specific tag you want surfaced.

### Are branded types supported for `format` or `pattern`?

Not by default. The generator emits the underlying primitive (`string`
for both `format: 'email'` and `pattern: '^[A-Z]+$'`) and records the
constraint as a JSDoc tag. A future `--branded` flag is on the roadmap
for users who want nominal types like `type Email = string & { __brand:
'Email' }`.

### Which TypeScript version is required?

The emitted output uses features available since TypeScript 4.0:
labelled tuple elements, optional tuple members, type predicates, and
template literal types. The corpus runner exercises the output against
the TypeScript version pinned in `package.json`.
