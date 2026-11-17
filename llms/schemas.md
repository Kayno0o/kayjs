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
- The builders: `s.string({ min, max, pattern })`, `s.email()`, `s.url()`, `s.slug()`, `s.int({ min, max })`, `s.number({ min, max })`, `s.boolean()`, `s.date()` (read as a `Date`), `s.enum(values)` or `s.enum(record)` (a record gives its keys), `s.literal(value)`, `s.union([a, b])`, `s.object(shape)`, `s.record(value)`, `s.list(item, { min, max })`, `s.file({ type, minSize, maxSize })`, `s.files()`, `s.secret()` and `s.public(field)` (the last two for `defineEnv`).
- Every builder takes the same field options: `optional: true` (the field may be left out, typed `T | undefined`), `default`, `error` (a text, or a function called in the request's locale), `label`, `description` and `example`. Any other option is a JSON Schema keyword, kept as written.
- Strict by default: a string is at most 10,000 characters, a list at most 1,000 items and a file size is `'2mb'`, `'600kb'` or bytes, each unless the options give another; `s.object` marks its shape closed, and `s.object(shape, { extra: 'strip' })` leaves it open. What a closed shape does with a key it lacks depends on who reads it: kay refuses it in an action's input, an API route's body, a socket message, `defineEnv`, collection frontmatter and a JSON Schema check by `ask` (a form post drops the fields the schema does not name); a response is read by Elysia, which drops it; the search params of a page or an API route and a request's headers are dropped whatever the shape says, and an API route's `cookie` schema ignores the cookies it does not name, as a third party sets some.
- A plain record of schemas is the object schema wherever a schema is taken: `action({ title: s.string() }, handler)` and `defineEnv({ PORT: s.int({ default: 3000 }) })`, so `s.object()` is rarely written. A record is strict as `s.object` is, and kay's own form fields (the honeypot, the stamp) are not its keys.
- Any Standard Schema validator (Zod 4.2+, ArkType 2.1.28+, Valibot) is accepted where a schema is: an action's `input` (typed by its output type) and an API route's `body`, `query`, `params`, `headers` and `cookie`. kay validates through `~standard.validate`, and reads constraints, OpenAPI and MCP from `~standard.jsonSchema.input({ target: 'draft-2020-12' })`; one without it still validates, but a form shows no constraints, a text source (a form, a query) is not read as numbers and booleans, and OpenAPI and MCP show an open schema; `kay check` names a hand-written or valibot one in those positions (`schema-without-json-schema`).
- `validate(schema, value, { source, locale })` from `kay/server` reads a value as its `source` says (`'form'`, `'query'`, `'params'` and `'env'` text is read as numbers, booleans and lists; `'json'` never is, and a form's or a query's text loses its surrounding spaces unless `trim: false`, as an API route reads it) and answers `{ value }` or, when `'errors' in result`, `{ errors: [{ path, key, params, message }], status: 422 }`: `path` is dotted (`tags.0`), `key` a `kay.invalid.*` message, `message` its text in the locale. `error` on a field is a text, a function, or a record by rule (`{ min, max, pattern, format, required, type, default }`). Nothing depends on `NODE_ENV`.
- The PascalCase builders of 1.x, `s.String`, `s.Object`, `s.Optional(field)`, `s.UnionEnum`, `s.UnionKeys`, `s.Numeric` and the rest, are Elysia's under their old names and work until 2.0: `kay upgrade` rewrites them (`deprecated-schema-builders`). A schema built with Elysia's `t` is still a `Schema`.
- `Schema` from `kay` is the type of what `s` builds, and what `action`, `defineEnv`, `collection`, an API route's `query` and a library's schema option take: name it in a signature, never TypeBox's `TSchema`. `Static<typeof schema>` reads the TypeScript type. Elysia and TypeBox are implementation details of kay: `s` has no door to TypeBox's own builders, and a schema it builds is JSON Schema data.
- The browser has no Elysia, which reads `Bun`: there `s.object(...)` and the rest build the plain JSON Schema of the field, a few lines each, so a module shared by the server and an island may build its schemas as it loads. The builders are a few small functions in the chunk of an island that imports a module building schemas as it loads; a module it imports as a type costs nothing. The PascalCase builders, deprecated, build a schema that accepts anything there.
- An island validates with the same schema: `validate(schema, value, { source })` from `kay` is the browser's `validate`, answering the same `{ value }` or `{ errors, status: 422 }`, worded in the page's locale (a `locale` option is the server's). Its code is a chunk of its own that the first call loads, so a page's eager JS does not grow and a page whose islands never call it never fetches it. A form is read as text (`'form'`), JSON as it is, defaults fill in, an unknown key is refused as on the server, and a Standard Schema validator is called as it is. A date stays the text it was given, and a file is checked by the server alone, which reads its bytes.
- An island may also read a schema's type alone: `import type { Choice } from '../schemas'`, or `import type { choice } from '../schemas'` for `Static<typeof choice>`, is erased from the browser build.
- `Static<typeof schema>` and `InputOf<typeof action>` are types from `kay` and cost the browser nothing.
- A module holding a value an island needs, a list of choices to draw as buttons, exports it apart from the schema, in a module with no `s`.
- A schema shared by API modules, server fences and `_actions.kay` lives in a `.ts` module of `src/`, `src/schemas.ts` or a folder of them, imported by its path from each.
