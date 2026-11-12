# Security and i18n lints

## Common tasks

- Set a lint's level, allow it on one line or apply its quick fix: [Lints and warnings](lints.md).

## Reference

- The `security` group reads redirects, guards and values that reach the browser; the `i18n` group reads machine translations and path entries.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `external-redirect` | warn | security | A `redirect()` or `ctx.redirect()` whose target is not a literal starting with one slash, a template or concatenation starting with `/name` (a bare `/` and a value may make `//host`), `localPath(...)`, a `const` holding one, or a value no request data reaches (a helper called with the app's own values, `result.redirect`): a literal URL, an unknown name or a value built from `ctx.query`, `ctx.url`, `ctx.params`, `ctx.body` or `input` may be any URL, an open redirect. Allowed with `// kay-allow external-redirect`; in `.kay` fences and `.ts` modules alike. |
| `unguarded-route` | deny | security | A page, an endpoint or an API module of the app no guard covers and not setting `guards: false` on a site with a guard of its own, or any site with `requireGuards: true`, which also names a layout or module with actions: the server answers each 403. |
| `unguarded-tool` | warn | security | With `mcp`, an action that sets `tool` and a `honeypot`, `minTime` or `proofOfWork` with no guard covering it: an agent skips what those ask of a person, so anonymous callers can spam it. A `...spread` in the options counts as a `honeypot`, `minTime` or `proofOfWork`; options that are not an object literal are not read. |
| `secret-prop` | warn | security | A value handed to an island holding a field named like a secret (`password`, `token`, `secret`, `apiKey`, `credential`, `email`, in any case), found by the types: island props are written into the page source, so every field reaches anyone viewing it. Hand the island the fields it shows, `user={{ name: user.name }}`; `// kay-allow secret-prop` keeps a public one. Flags, counts, lists of objects (`emailVerified`, `tokenCount`) and types deeper than eight levels are skipped. |
| `draft-message` | warn | i18n | With `i18n`, a message whose own line (not a group's opening brace) in its locale's file ends on a `// draft` comment, as `writeDraftMessages` writes a machine translation: served as any message, waiting for a person. Deleting the comment accepts it, `kay i18n accept <locale>` every draft of the locale; `deny` holds a release until they are checked. |
| `draft-entry` | warn | i18n | With `i18n`, an entry of a localized collection whose YAML (or Markdown frontmatter) opens on a `# draft` line, as `kay i18n translate` marks a machine translation in a collection with no `draft` field: served as any entry, waiting for a person. Deleting the line (or saving the entry from a CMS) accepts it; `deny` holds a release until they are checked. |
| `default-locale-path` | warn | i18n | With `i18n`, an `i18n.paths` entry translating a pattern for the default locale, whose path is the pattern itself: the entry is accepted but links to it never localize. Name the page the default locale's way and translate it for the other locales. |
