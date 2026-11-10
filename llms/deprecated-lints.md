# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-auth-error` | warn | deprecated | A kayjs-auth result's `error` compared with a kind, `result.error === 'limited'`, `!==` or a `switch (result.error)` over kinds, since 1.92: `error` is an `ErrorShape` with the kind as `code`, so the old comparison is never true, and TypeScript refuses it too. Found where `kay check` types the result as an auth one; a comparison it cannot type keeps TypeScript's own error. `kay upgrade` reads `error.code`; a subject that is no plain `a.b.error` chain is reported with no fix. |
| `deprecated-stream-open` | warn | deprecated | `.onOpen(reconnected => ...)` of a stream or a socket, since 1.92: `.onOpen(({ reconnected }) => ...)`, the one object argument every hook takes. The old form still compiles, as an object is truthy, so a callback testing `reconnected` runs on every open. `kay upgrade` gives an arrow of one plain parameter `{ reconnected: parameter }`, on a name bound once to `stream(` or `socket(` from `kay` in the file; a function reference, which may take either form, and any other callback are reported with no fix. |
| `deprecated-local-state` | warn | deprecated | `pending()` and `status()` of a `local()` collection, since 1.92: `unsynced()` and `syncStatus()`, as every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`. The old names work until 2.0, which gives them that meaning, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. `kay upgrade` renames the method, and a `status()` compared with a string reads `'unsynced'` for `'pending'`, on a name bound once to `local(` from `kay` in the file, its template included; a `status()` read in any other way is reported with no fix. |
| `deprecated-redirect-permanent` | warn | deprecated | `permanent` of a redirect in `kay.config.ts`, since 1.96: `status` is the one spelling for 301, 302, 307, 308 and 410 (a path that is gone, with no `to`), where `permanent` named two of them and could contradict it. The old form still works. Found in the `redirects` object of `kay.config.ts`, through a `const` it names. `kay upgrade` writes `status: 307` for `permanent: false` and `status: 308` for `permanent: true`, and drops `permanent` beside a `status` that agrees; any other form is reported with no fix. |
