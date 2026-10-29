# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-auth-attempts` | warn | deprecated | An `attempts` counter in a kayjs-auth store the app writes, since 1.81: a store counts in `rates`, a kay `RateStore` with `peek` and `reset`, or leaves counting to the app's `store.rates`, else memory. Read until 1.84. `kay upgrade` drops `attempts: memoryAuthStore().attempts` and the import it leaves unread; another counter is reported with no fix. Found in object literals holding `users`, `identities` and `tokens`, in `.ts` files and `.kay` fences importing from the library. |
| `deprecated-auth-methods` | warn | deprecated | A call of a flat kayjs-auth method on `auth` or `ctx.locals.auth`, the names before 1.82: `auth.listUsers()` is `auth.admin.listUsers()`, `auth.signInWithPassword(input)` is `auth.password.signIn(input)`. The flat names work until 1.85. Found in a project depending on `@kaynooo/kayjs-auth`, in its TypeScript files and `.kay` fences; `kay upgrade` renames each call, its arguments unchanged. |
| `deprecated-session-stores` | warn | deprecated | An import of `memoryStore` or `sqliteStore` from `kay/server`, the session stores before 1.84: `memorySessions` and `sqliteSessions`, named for what every other store holds. The old names work until 1.87. `kay upgrade` renames the import and every use of it, or the member of an `import * as` namespace. Found in the project's `.ts` files and `.kay` fences. |
