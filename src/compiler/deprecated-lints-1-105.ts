import type { Lint } from './lints'

// The lints of the `deprecated` group for how an island read its sources and actions before 1.105, with the others in `DEPRECATED_LINTS`.
export const SOURCE_READERS = {
  'deprecated-source-readers': {
    level: 'warn',
    group: 'deprecated',
    since: '1.105',
    site: true,
    summary: 'The readers and hooks of an island\'s sources before 1.105, which every source reads alike since: `data()` in place of `value()` (a `resource`), `last()` (a `stream` or `socket`) and `rows()` (a `local` collection), `onData` in place of `onSuccess` (a `track()` handle) and `onSync` (a collection), whose event hands `value` where they handed `data` and `rows`, an action\'s `data()` and `status()` in place of `succeeded()`, and a collection\'s `sync.queued()` and `sync.status()` in place of `unsynced()` and `syncStatus()`. The old names work until 1.108. Found in the TypeScript files and `.kay` files of the project, templates included, on a name bound once to a call of `resource`, `stream`, `socket` or `local` from `kay` or to a `.track()` call, as `kay check` reads no types: a source reached through a property, a prop or another file is not found; `succeeded()` is found on any receiver. The fix renames the member, and the `data` or `rows` of a hook\'s inline handler to `value`; `succeeded()?.data` becomes `data()` and `succeeded() !== undefined` becomes `status() === \'ready\'`. A `succeeded()` read in any other way, a handler that is no inline function and a shorthand hook are reported with no fix.',
    wrong: '---\nimport { local, resource } from \'kay\'\nimport notesApi from \'../api/notes\'\nimport { save } from \'./notes\'\n\nconst list = resource(notesApi, \'/\')\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {list.value()?.length} on the server, {notes.rows().length} here, {notes.unsynced()} waiting',
    right: '---\nimport { local, resource } from \'kay\'\nimport notesApi from \'../api/notes\'\nimport { save } from \'./notes\'\n\nconst list = resource(notesApi, \'/\')\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {list.data()?.length} on the server, {notes.data().length} here, {notes.sync.queued()} waiting',
  },
  'deprecated-live-api': {
    level: 'warn',
    group: 'deprecated',
    since: '1.105',
    site: true,
    summary: 'The forms of `set` and `presence` before 1.105, which write every live value and every room alike since: `set(next, { key })` of a value per key and `set(next, { user })` of a value per user in place of `set(key, next)` and `set(user, next)`, and `presence({ room, member })` in place of `presence(room, member)`. The old forms work until 1.108. Found in the TypeScript files and `.kay` files of the project, on a name bound once to a `live()` call from `kay`, or imported under the name of a declaration every file of the project agrees on (a value per key is one declared with a function of the key or `key: true`, per user with `user: true`), as `kay check` reads no types: a value reached through a namespace import or a property is not found. `presence` is the one imported from `kay`. The fix reorders the arguments of `set`, and writes the arguments of `presence` as one object, its options object spread into it; a `presence` given options that are no object written there is reported with no fix.',
    wrong: '// src/live.ts\nimport { live } from \'kay\'\n\nexport const room = live((id: string) => ({ id, users: 0 }))\n\nroom.set(\'lobby\', { id: \'lobby\', users: 3 })',
    right: '// src/live.ts\nimport { live } from \'kay\'\n\nexport const room = live((id: string) => ({ id, users: 0 }))\n\nroom.set({ id: \'lobby\', users: 3 }, { key: \'lobby\' })',
  },
  'deprecated-action-type': {
    level: 'warn',
    group: 'deprecated',
    since: '1.105',
    site: true,
    summary: '`Action<never, unknown>` before 1.105, the type a prop takes to accept any action: `Action` since, whose two parameters default to it. `Action<{ name: string }, string>` keeps its input and output types, and a `.with()` action crosses into an island as any other does. The old form works until 1.108. Found on the `Action` a file imports from `kay`, under any local name, in the TypeScript files and the fences of `.kay` files. The fix drops the type arguments.',
    wrong: '---\nimport type { Action } from \'kay\'\n\nconst { run } = props<{ run: Action<never, unknown> }>()\n---\nform(action={run})\n  button Go',
    right: '---\nimport type { Action } from \'kay\'\n\nconst { run } = props<{ run: Action }>()\n---\nform(action={run})\n  button Go',
  },
  'deprecated-action-readers': {
    level: 'warn',
    group: 'deprecated',
    since: '1.105',
    site: true,
    summary: 'An action\'s `failed()`, `error(field)` and `validate(form, field)` before 1.105, which a form shows and now reads from `form`: `form.failed()`, `form.error(field)` and `form.validate(form, field)`, the call state (`pending()`, `status()`, `data()`) staying on the action. The old names work until 1.108. Found in the TypeScript files and `.kay` files of the project, templates included, on a name bound once to a call of `action` from `kay`, to the `.with()` of one, or imported in lowercase from a `.kay` file, as `kay check` reads no types: an action reached through a property or a prop is not found. The fix writes `form.` before the name.',
    wrong: '---\nimport { add } from \'./notes.kay\'\n---\nform(action={add})\n  input(name="title" aria-invalid={add.error(\'title\') ? \'true\' : undefined})\n  if add.failed()\n    p Not saved',
    right: '---\nimport { add } from \'./notes.kay\'\n---\nform(action={add})\n  input(name="title" aria-invalid={add.form.error(\'title\') ? \'true\' : undefined})\n  if add.form.failed()\n    p Not saved',
  },
} as const satisfies Record<string, Lint>
