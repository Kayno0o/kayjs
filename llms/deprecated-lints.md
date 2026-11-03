# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-safe-redirect` | warn | deprecated | A call of kayjs-auth's `safeRedirect(path, fallback?)`, since 1.84: kay's `localPath(path, fallback)`, with `/` as the fallback when the call gave none. Works until 1.87. `kay upgrade` calls `localPath` imported from `kay`; a call whose fallback is no string literal, or a `safeRedirect` read as a value, is reported with no fix. Found in `.ts` files and `.kay` fences importing it from `@kaynooo/kayjs-auth`. |
| `deprecated-session-stores` | warn | deprecated | An import of `memoryStore` or `sqliteStore` from `kay/server`, the session stores before 1.84: `memorySessions` and `sqliteSessions`, named for what every other store holds. The old names work until 1.87. `kay upgrade` renames the import and every use of it, or the member of an `import * as` namespace. Found in the project's `.ts` files and `.kay` fences. |
| `deprecated-collection-links` | warn | deprecated | A collection with a literal `route` that also says where its entries' pages are, since 1.87: a `url` function (the route wins over it) and a `path` in its feed's items (the feed links the entry's `url`). Works until 1.90. `kay upgrade` drops the `url` function and a `path` written as the route with the slug, `` `/blog/${post.slug}` `` for `/blog/:slug`; a `path` that differs from the route is reported with no fix. Found in `.ts` files calling `collection` from `kay/content`. |
| `deprecated-config-keys` | warn | deprecated | A config key under its name before 1.84, in `kay.config.ts`, in the options of `pages()` and `testSite()` (imported under any name) or in an extension's `config`: `routes` is `routesDir`, `api` is `apiDir`, `content` is `contentConfig`, `storage` is `fileStore`, `maxSizes` is `maxSizeByPath`, `settings` is `librarySettings`. The old names work until 1.87. `kay upgrade` renames the key (a shorthand becomes `routesDir: routes`); a key written beside its new name is reported with no fix. |
| `deprecated-ui-tone` | warn | deprecated | A kayjs-ui form 1.87 replaced: the `muted` tone of a Sparkline (`tone`, `tones`), a StatusStrip (`cells`) or a Timeline (`entries`), now `neutral`, and a native `size` such as `size={20}` on a TextInput, Select, Combobox, DateInput, TimeInput or DateTimeInput, now `sm`, `md` or `lg`. The old tone draws until 2.0.0. `kay upgrade` writes `neutral` where `muted` is a literal; a native `size` is reported with no fix, its width is a class now. Found in `.kay` files importing the component from `@kaynooo/kayjs-ui`. |
