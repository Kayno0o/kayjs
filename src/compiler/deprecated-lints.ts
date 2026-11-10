import type { Lint } from './lints'

// The lints of the `deprecated` group, with the other lints in `LINTS`; each stays three minors from its `since`.
export const DEPRECATED_LINTS = {
  'deprecated-stream-open': {
    level: 'warn',
    group: 'deprecated',
    since: '1.92',
    site: true,
    summary: '`.onOpen(reconnected => ...)` of a stream or a socket, `.onOpen(({ reconnected }) => ...)` since 1.92: the hook is told one object, as every hook is. The old form still compiles, as an object is truthy, so a callback testing `reconnected` now runs on every open, the first included. Found in the TypeScript files and `.kay` fences of the project, on a name bound once to a call of `stream` or `socket` from `kay`, as `kay check` reads no types: a stream an action answered with, or one reached through a property or a parameter, is not found and changed by hand. The fix gives an arrow of one plain parameter `{ reconnected: parameter }`; a function reference, which may take either form, and any other callback are reported with no fix.',
    wrong: '--- server\nimport { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\nfeed.onOpen(again => again && console.log(\'back\'))\n---\np x',
    right: '--- server\nimport { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\nfeed.onOpen(({ reconnected: again }) => again && console.log(\'back\'))\n---\np x',
  },
  'deprecated-local-state': {
    level: 'warn',
    group: 'deprecated',
    since: '1.92',
    site: true,
    summary: '`pending()` and `status()` of a `local()` collection, `unsynced()` and `syncStatus()` since 1.92: every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`, so the count of writes waiting and the sync states took names of their own. The old names work until 2.0, which gives `pending()` and `status()` the meaning they have on every source, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. Found in the TypeScript files and `.kay` files of the project, templates included, on a name bound once to a call of `local` from `kay`, as `kay check` reads no types: a collection reached through a property, a prop or another file is not found. The fix renames the method, and a `status()` compared with a string (`===`, `!==`, `==`, `!=` or a `switch`) reads `\'unsynced\'` for `\'pending\'`; a `status()` read in any other way is reported with no fix.',
    wrong: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.pending()} waiting',
    right: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.unsynced()} waiting',
  },
  'deprecated-auth-error': {
    level: 'warn',
    group: 'deprecated',
    since: '1.92',
    typed: true,
    summary: 'A kayjs-auth result\'s `error` compared with a kind, `result.error === \'limited\'`, `!==`, or a `switch (result.error)` over kinds: since 1.92 `error` is the `ErrorShape` every result carries (`status`, `message`, `errors`, `data`) and the kind is its `code`, so the old comparison is never true. Unlike the other deprecations the old form does not keep working, so TypeScript refuses it too; the lint is found when `kay check` types the result as an auth one, and a comparison of a result it cannot type keeps TypeScript\'s own error. The fix reads `error.code`, and `kay upgrade` applies it.',
    wrong: '--- server\nimport { action } from \'kay\'\n\nexport const signIn = action(async (_input, ctx) => {\n  const result = await ctx.locals.auth.password.signIn({ identifier: \'ada\', password: \'x\' })\n\n  return !result.ok && result.error === \'limited\' ? ctx.fail(429, {}) : undefined\n})\n---\np x',
    right: '--- server\nimport { action } from \'kay\'\n\nexport const signIn = action(async (_input, ctx) => {\n  const result = await ctx.locals.auth.password.signIn({ identifier: \'ada\', password: \'x\' })\n\n  return !result.ok && result.error.code === \'limited\' ? ctx.fail(429, {}) : undefined\n})\n---\np x',
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
