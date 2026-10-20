# Schemas

## Common tasks

### Write a value shape once

A shape the server validates and an island types is written once, as a schema in a plain `.ts` module, with its type read off it by `Static` from `kay`:

```ts
// src/schemas.ts
import type { Static } from 'kay'
import { s } from 'kay'

export const choice = s.Union([s.Literal('smash'), s.Literal('pass')])
export type Choice = Static<typeof choice>
```

An API module, a server fence and an `_actions.kay` import the schema; an island imports the type alone, which leaves the module out of its bundle:

```kay
--- server
import { action, s } from 'kay'
import { choice } from '../schemas'

export const castVerdict = action(s.Object({ choice }), input => input.choice)
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

- `s` from `kay` is Elysia's schema builder under a name that leaves `t` to translations, there to save an import in server fences and server modules, `defineEnv` and API modules included.
- The browser has none, nor Elysia's, which reads `Bun`: schemas live in modules only the server imports, and what an island needs of one, a length or a list of choices, in another module both import.
- A client build, `kay dev`'s and `bun test`'s included, refuses an island reaching kay's `s`, naming the modules taking it from `kay`.
- An island reads a schema's type, not its value: `import type { Choice } from '../schemas'`, or `import type { choice } from '../schemas'` for `Static<typeof choice>`, is erased from the browser build, so the module may build its schemas with `s`.
- `Static<typeof schema>` and `InputOf<typeof action>` are types from `kay` and cost the browser nothing.
- A module holding a value an island needs, a list of choices to draw as buttons, exports it apart from the schema, in a module with no `s`.
- A schema shared by API modules, server fences and `_actions.kay` lives in a `.ts` module of `src/`, `src/schemas.ts` or a folder of them, imported by its path from each.
