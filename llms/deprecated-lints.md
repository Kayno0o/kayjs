# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-local-state` | warn | deprecated | `pending()` and `status()` of a `local()` collection, since 1.92: `unsynced()` and `syncStatus()`, as every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`. The old names work until 2.0, which gives them that meaning, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. `kay upgrade` renames the method, and a `status()` compared with a string reads `'unsynced'` for `'pending'`, on a name bound once to `local(` from `kay` in the file, its template included; a `status()` read in any other way is reported with no fix. |
| `deprecated-redirect-permanent` | warn | deprecated | `permanent` of a redirect in `kay.config.ts`, since 1.96: `status` is the one spelling for 301, 302, 307, 308 and 410 (a path that is gone, with no `to`), where `permanent` named two of them and could contradict it. The old form still works. Found in the `redirects` object of `kay.config.ts`, through a `const` it names. `kay upgrade` writes `status: 307` for `permanent: false`, and drops `permanent: true`, which is the 308 default, and `permanent` beside a `status` that agrees; any other form is reported with no fix. A static export lists a `status` as written in `_redirects`, where `permanent: false` was listed as 302, so it lists 307 after the fix. |
