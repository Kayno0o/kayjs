import type { Lint } from './lints'

// The deprecated lints the type check finds, apart from the others: an old form the types of 1.105 refuse, which `kay check` names with the fix instead of leaving its type error.
export const TYPED_DEPRECATIONS = {
  'deprecated-callback-handler': {
    level: 'deny',
    group: 'deprecated',
    since: '1.105',
    typed: true,
    summary: 'A function written for the arguments a kayjs-ui, kayjs-ai or kayjs-cms callback took before 1.105, given to a callback that takes one event object since: `onValueChange={query.set}`, `onCheckedChange={toggle}` with `toggle(on: boolean)` or `onFiles={upload}` with `upload(files: File[])`. Found where the type check refuses the function and the component comes from a `@kayjs` library; the fix writes `event => query.set(event.value)`, passing the fields the handler took, first ones first, and is applied where its parameter is no object (a parameter typed as an object may be written for the event already, so that fix is offered). A handler that is not a plain name, such as an arrow function, is reported with no fix. The old form fails the type check, and would receive the event where it took the value, so the level is `deny` until it is rewritten.',
    wrong: '---\nimport { signal } from \'kay\'\nimport Checkbox from \'@kayjs/ui/checkbox.kay\'\n\nconst on = signal(false)\n\nfunction toggle(next: boolean) {\n  on.set(next)\n}\n---\nCheckbox(label="Notify" checked={on()} onChange={toggle})',
    right: '---\nimport { signal } from \'kay\'\nimport Checkbox from \'@kayjs/ui/checkbox.kay\'\n\nconst on = signal(false)\n\nfunction toggle(next: boolean) {\n  on.set(next)\n}\n---\nCheckbox(label="Notify" checked={on()} onChange={event => toggle(event.checked)})',
  },
  'deprecated-call-result': {
    level: 'deny',
    group: 'deprecated',
    since: '1.105',
    typed: true,
    summary: 'An island\'s call read as its data, `const list = await call(notes, \'/\')` then `list.items`, or `await add(input)` then `.id`, which resolved with the data before 1.105 and answers a `CallResult`, `{ ok: true, data }` or `{ ok: false, error }`, since. Found where the type check refuses a field of a `CallResult`, in a `.kay` script or a module. The fix writes `.orThrow()` after the call, which resolves with the data and throws a refusal as the call did; it is applied where the call is written on an imported name and nothing reads `ok`, `data` or `error` of the answer, and offered otherwise. The old form fails the type check, so the level is `deny`.',
    wrong: '---\nimport { call, signal } from \'kay\'\nimport notes from \'../api/notes\'\n\nconst names = signal(\'\')\n\nasync function load() {\n  const list = await call(notes, \'/\')\n\n  names = list.items.join(\', \')\n}\n---\nbutton(onClick={load}) Load\np {names()}',
    right: '---\nimport { call, signal } from \'kay\'\nimport notes from \'../api/notes\'\n\nconst names = signal(\'\')\n\nasync function load() {\n  const list = await call(notes, \'/\').orThrow()\n\n  names = list.items.join(\', \')\n}\n---\nbutton(onClick={load}) Load\np {names()}',
  },
} as const satisfies Record<string, Lint>
