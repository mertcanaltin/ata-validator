# Effect

[Effect](https://effect.website) has its own schema library, `effect/Schema`, which is the idiomatic choice for schemas authored inside Effect code. ata fits when the schema lives outside the codebase as a JSON Schema document (OpenAPI specs, shared registries, generated schemas) and you want to validate against it without a translation step.

The recipe below wraps `Validator` so it returns an `Effect` that fails with a typed error on invalid input.

## Install

```bash
npm install ata-validator effect
```

## Tagged error and validator factory

```ts
import { Data, Effect } from 'effect'
import { Validator } from 'ata-validator'

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly errors: ReadonlyArray<{ message: string; path?: string }>
}> {}

export function ataValidate<T>(schema: object) {
  const v = new Validator(schema)
  return (input: unknown): Effect.Effect<T, ValidationError> => {
    const r = v.validate(input)
    return r.valid
      ? Effect.succeed(input as T)
      : Effect.fail(new ValidationError({ errors: r.errors }))
  }
}
```

`ataValidate` builds the `Validator` once and returns a function that produces a fresh `Effect` per call. The returned effect fails in the typed error channel, so downstream code can recover with `Effect.catchTag`.

## Use in a pipeline

```ts
import { Effect } from 'effect'

interface User {
  id: number
  name: string
  email: string
}

const validateUser = ataValidate<User>({
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string' },
  },
  required: ['id', 'name', 'email'],
})

const program = (raw: unknown) =>
  Effect.gen(function* () {
    const user = yield* validateUser(raw)
    return { ok: true, id: user.id }
  }).pipe(
    Effect.catchTag('ValidationError', (e) =>
      Effect.succeed({ ok: false, errors: e.errors }),
    ),
  )
```

`catchTag` narrows on the tag, so the recovery branch sees `e.errors` typed.

## HTTP handler example

Wrapping an incoming request in the same pipeline:

```ts
import { Effect } from 'effect'

export async function POST(request: Request) {
  const handler = Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new ValidationError({ errors: [{ message: 'invalid JSON' }] }),
    })
    const user = yield* validateUser(body)
    return Response.json({ ok: true, id: user.id })
  }).pipe(
    Effect.catchTag('ValidationError', (e) =>
      Effect.succeed(Response.json({ errors: e.errors }, { status: 400 })),
    ),
  )

  return Effect.runPromise(handler)
}
```

## Bridge into `effect/Schema`

If the rest of the codebase is Schema-first, the same `Validator` can sit inside a `Schema.declare` so ata-validated values flow through Schema's pipe:

```ts
import { Schema } from 'effect'
import { Validator } from 'ata-validator'

function fromAta<A>(schema: object) {
  const v = new Validator(schema)
  return Schema.declare(
    (input): input is A => {
      const r = v.validate(input)
      return r.valid
    },
    {
      identifier: 'AtaValidated',
      jsonSchema: schema,
    },
  )
}

const UserSchema = fromAta<User>({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['id', 'name'],
})

// Schema.decode, Schema.encode, etc. now flow through ata
```

This gives you Schema's pipe operators on top of ata's runtime. Validation cost stays the same.

## Build-time compile

For services that load the schema from disk on boot, pre-compile with `ata compile` and skip the runtime `ata-validator` dependency:

```bash
npx ata compile schemas/user.json -o src/user.validator.mjs --name User
```

```ts
import { Effect, Data } from 'effect'
import { isValid, type User } from './schemas/user.validator.mjs'

class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string
}> {}

export function validateUser(input: unknown): Effect.Effect<User, ValidationError> {
  return isValid(input)
    ? Effect.succeed(input)
    : Effect.fail(new ValidationError({ message: 'invalid user payload' }))
}
```

`isValid` is a type predicate, so Effect's success channel narrows to `User` automatically. The compiled module is around 1 KB per schema and has no runtime dependency on ata.

## Notes

- `effect/Schema` remains the right choice for schemas defined alongside Effect code. Reach for ata when JSON Schema is the contract.
- Build the `Validator` once at module scope. Constructing inside the Effect on every call recompiles the schema.
- For high-throughput endpoints, the buffer path (`v.isValid(buffer)`) works the same way inside an Effect, just `Effect.sync` around the call.
