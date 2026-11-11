import type { Lint } from './lints'

// The lints of the `deprecated` group, with the other lints in `LINTS`; each stays three minors from its `since`.
export const DEPRECATED_LINTS = {
  'deprecated-local-state': {
    level: 'warn',
    group: 'deprecated',
    since: '1.92',
    site: true,
    summary: '`pending()` and `status()` of a `local()` collection, `unsynced()` and `syncStatus()` since 1.92: every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`, so the count of writes waiting and the sync states took names of their own. The old names work until 2.0, which gives `pending()` and `status()` the meaning they have on every source, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. Found in the TypeScript files and `.kay` files of the project, templates included, on a name bound once to a call of `local` from `kay`, as `kay check` reads no types: a collection reached through a property, a prop or another file is not found. The fix renames the method, and a `status()` compared with a string (`===`, `!==`, `==`, `!=` or a `switch`) reads `\'unsynced\'` for `\'pending\'`; a `status()` read in any other way is reported with no fix.',
    wrong: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.pending()} waiting',
    right: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.unsynced()} waiting',
  },
  'deprecated-redirect-permanent': {
    level: 'warn',
    group: 'deprecated',
    since: '1.96',
    site: true,
    summary: '`permanent` of a redirect in `kay.config.ts`, `status` since 1.96: `status` is the one spelling for 301, 302, 307, 308 and 410 (a path that is gone, with no `to`), where `permanent` named two of them and could contradict it. The old form still works. Found in the `redirects` object of `kay.config.ts`, through a `const` it names. The fix writes `status: 307` for `permanent: false`, and drops `permanent: true`, which is the 308 default, and `permanent` beside a `status` that agrees; any other form is reported with no fix. A static export lists a `status` as written in `_redirects`, where `permanent: false` was listed as 302, so it lists 307 after the fix.',
    wrong: '// kay.config.ts\nexport default { redirects: { \'/sale\': { to: \'/offers\', permanent: false } } }',
    right: '// kay.config.ts\nexport default { redirects: { \'/sale\': { to: \'/offers\', status: 307 } } }',
  },
} as const satisfies Record<string, Lint>
