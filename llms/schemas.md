# Schemas

## Common tasks

### Write a value shape once

A shape the server validates and an island types is written once, as a schema in a plain `.ts` module, with its type read off it by `Static` from `kay`:

```ts
// src/schemas.ts
import type { Static } from 'kay'
import { s } from 'kay'

export const choice = s.union([s.literal('smash'), s.literal('pass')])
export type Choice = Static<typeof choice>
```

An API module, a server fence and an `_actions.kay` import the schema; an island imports the type alone, which leaves the module out of its bundle:

```kay
--- server
import { action, s } from 'kay'
import { choice } from '../schemas'

export const castVerdict = action({ choice }, input => input.choice)
---
```

```kay
---
import type { Choice } from '../schemas'

const { initial } = props<{ initial: Choice }>()
---
```

### Type what an action hands over

`InputOf<typeof contact>` from `kay` is an action's input as its schema describes it, so a mail or a module the handler calls types its argument without writing the fields again. Import the action as a type: `import type { contact } from './routes/index.kay'`.

## Reference

### Schemas

- `s` from `kay` is kay's own schema builder, over TypeBox so a schema stays JSON Schema data for OpenAPI, MCP and the form rules, under a name that leaves `t` to translations: lowercase builders with short options, there to save an import in server fences and server modules, `defineEnv` and API modules included.
- The builders: `s.string({ min, max, pattern })`, `s.email()`, `s.url()`, `s.slug()`, `s.int({ min, max })`, `s.number({ min, max })`, `s.boolean()`, `s.date()` (ISO text only, read as a `Date`), `s.enum(values)` or `s.enum(record)` (a record gives its keys), `s.literal(value)`, `s.union([a, b])`, `s.object(shape)`, `s.record(value)`, `s.list(item, { min, max })`, `s.file({ type, minSize, maxSize })`, `s.files()`, `s.secret()` and `s.public(field)` (the last two for `defineEnv`).
- Every builder takes the same field options: `optional: true` (the field may be left out, typed `T | undefined`), `default`, `error` (a text, or a function called in the request's locale), `label`, `description` and `example`. Any other option is a JSON Schema keyword, kept as written.
- Strict by default: a string is at most 10,000 characters, a list at most 1,000 items and a file size is `'2mb'`, `'600kb'` or bytes, each unless the options give another; `s.object` refuses a key its shape lacks, and `s.object(shape, { extra: 'strip' })` drops it instead.
- A plain record of schemas is the object schema wherever a schema is taken: `action({ title: s.string() }, handler)` and `defineEnv({ PORT: s.int({ default: 3000 }) })`, so `s.object()` is rarely written. A record is strict as `s.object` is, and kay's own form fields (the honeypot, the stamp) are not its keys.
- The PascalCase builders of 1.x, `s.String`, `s.Object`, `s.Optional(field)`, `s.UnionEnum`, `s.UnionKeys`, `s.Numeric` and the rest, are Elysia's under their old names and work until 2.0: `kay upgrade` rewrites them (`deprecated-schema-builders`). A schema built with Elysia's `t` is still a `Schema`.
- `Schema` from `kay` is the type of what `s` builds, and what `action`, `defineEnv`, `collection`, an API route's `query` and a library's schema option take: name it in a signature, never TypeBox's `TSchema`. `Static<typeof schema>` reads the TypeScript type. Elysia and TypeBox are implementation details of kay: `s` has no door to TypeBox's own builders, and a schema it builds is JSON Schema data.
- The browser has no Elysia, which reads `Bun`: there `s.object(...)` and the rest build an inert stand-in, so a module shared by the server and an island may build its schemas as it loads, with no validator in the island's chunk, only the calls and their literals.
- The stand-in only passes into another builder: reading a key of one, or validating with it, throws in the browser. An island reads the type, `Static<typeof schema>`, and the server validates.
- An island reads a schema's type, not its value: `import type { Choice } from '../schemas'`, or `import type { choice } from '../schemas'` for `Static<typeof choice>`, is erased from the browser build; a plain `import { choice }` works too, keeping the inert stand-in and the schema's literal in the chunk.
- `Static<typeof schema>` and `InputOf<typeof action>` are types from `kay` and cost the browser nothing.
- A module holding a value an island needs, a list of choices to draw as buttons, exports it apart from the schema, in a module with no `s`.
- A schema shared by API modules, server fences and `_actions.kay` lives in a `.ts` module of `src/`, `src/schemas.ts` or a folder of them, imported by its path from each.
