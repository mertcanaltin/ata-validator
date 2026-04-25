# Framework integrations

`ata-validator` works in any runtime that accepts a function of `(data) => boolean`. Most frameworks need 10-20 lines of glue to plug it in. Recipes below cover the common ones.

## Quick map

| Framework | Pattern | File |
|---|---|---|
| Hono | middleware | [hono.md](./hono.md) |
| Elysia | direct handler check | [elysia.md](./elysia.md) |
| tRPC | Standard Schema V1 | [trpc.md](./trpc.md) |
| TanStack Form | Standard Schema V1 | [tanstack-form.md](./tanstack-form.md) |
| Express | middleware | [express.md](./express.md) |
| Koa | middleware | [koa.md](./koa.md) |
| NestJS | validation pipe | [nestjs.md](./nestjs.md) |
| SvelteKit | form action | [sveltekit.md](./sveltekit.md) |
| Astro | API route | [astro.md](./astro.md) |
| Effect | tagged error + Effect | [effect.md](./effect.md) |

For Fastify, use the dedicated [`fastify-ata`](https://github.com/ata-core/fastify-ata) plugin. For Vite build-time compilation, use [`ata-vite`](https://github.com/ata-core/ata-vite).

## Picking an approach

Three main patterns show up across frameworks:

**Standard Schema V1** (tRPC, TanStack Form, Drizzle): pass the Validator instance directly. ata implements the `~standard` contract natively, no adapter needed.

```ts
import { Validator } from 'ata-validator'
const userSchema = new Validator({ type: 'object', /* ... */ })
// drop userSchema wherever the framework accepts a Standard Schema.
```

**Middleware / pipe** (Express, Koa, Hono, NestJS): short adapter function that validates `req.body` (or similar) and rejects on failure.

**Direct handler check** (Elysia, SvelteKit, Astro): call `v.validate(data)` inline in the handler, return the error response manually. No framework hooks needed.

## Common patterns

### Reuse one Validator instance per schema

Instantiating `new Validator(schema)` is cheap but not free. Hold onto the instance at module scope:

```ts
const userSchema = new Validator({ type: 'object', /* ... */ })

export async function handler(req) {
  const result = userSchema.validate(await req.json())
  if (!result.valid) return Response.json({ errors: result.errors }, { status: 400 })
  // ...
}
```

### `abortEarly` for high-throughput route guards

When the handler only needs accept / reject (not detailed error messages), enable `abortEarly` to skip error collection:

```ts
const userSchema = new Validator(schema, { abortEarly: true })
// result.errors is always [{ message: 'validation failed' }] on failure,
// but the validation itself is ~4x faster on the invalid path.
```

### Buffer input (native addon required)

For frameworks that expose raw request buffers, skip `JSON.parse` and validate the buffer directly:

```ts
if (validator.isValid(bodyBuffer)) {
  const data = JSON.parse(bodyBuffer) // or use validateAndParse for single-pass
  // ...
}
```

`isValid(buffer)` uses simdjson on the native addon path. Great for proxies, webhook ingestion, or any endpoint that rejects more than it accepts.

## Build-time compile (any framework)

If the schema is known at build time, `ata compile` emits a self-contained validator module plus TypeScript declarations. Works with any of the frameworks below. The generated `.mjs` has no runtime dependency on `ata-validator`.

```bash
npx ata compile schemas/user.json -o src/user.validator.mjs --name User
```

See the [blog post on ata compile](https://altinmert.com/blog/json-schema-is-already-a-typescript-type) for the full picture.
