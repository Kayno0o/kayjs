# Lints and warnings

## Common tasks

### Change a lint's level

`lints` in `kay.config.ts` sets a lint's level to `deny`, `warn` or `allow`:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lints: { 'positional-key': 'deny', 'unread-name': 'warn' },
})
```

### Set the level of a whole group

A group's name takes a level for every lint in it, a lint's own level winning:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lints: { a11y: 'warn', 'missing-alt': 'deny' },
})
```

### Allow a lint on one line

`// kay-allow` followed by a lint's name allows it on the line it ends, or, alone on its line, on the line after it:

```kay
---
// kay-allow constant-signal
const label = signal('Save')
---
button {label()}
```

### Apply the quick fixes

`--fix` applies the quick fixes that change nothing else, then reports what is left:

```sh
kay check --fix
```

### Learn what a lint reports

`kay explain` lists the lints with their group and the errors kay raises (see [Errors](errors.md#errors)), and given a lint prints it with an example it reports and the same written right:

```sh
kay explain
kay explain positional-key
```

### Audit a public site's SEO

`--only` prints one group's lints alone, an audit rather than a check:

```sh
kay check --only seo
```

## Reference

### Lints and warnings

- `kay check`, `kay build` and `kay dev`'s dev tool print a problem as rustc does, and the editor shows the same message, note and help, type errors and their help included, leaving out the type errors `kay check` leaves out (a file that did not compile, a library component the app never imports).
- A problem prints as `error[missing-alt]: An \`img\` needs \`alt\``, then ` --> src/routes/index.kay:4:3`, the lines at fault with the span underlined and the other places involved labelled, then `= note:` saying why when the message does not, and `= help:` saying what to write.
- A name in brackets is a lint's, and the project sets its level: `deny` reports it as an error, `warn` as a warning, and `allow` not at all.
- `kay check` prints warnings beside the errors and counts them apart, failing on them only with `--deny-warnings`, which the `check` script `kay new` writes leaves out; `kay build` and `kay dev` never fail on one.
- Lints are found while type checking, so a page with one still runs.
- Beside each open file's problems, the editor runs what `kay check` finds across the project after a save or a change on disk, never on a keystroke: the config, the collections' entries, the locales' messages, what the server refuses when it boots, the settings libraries take and what guards, API modules and matchers export, each shown at its file.
- `lints` in `kay.config.ts` sets levels over the defaults: `defineConfig({ lints: { 'positional-key': 'deny', 'unread-name': 'warn' } })`.
- Each lint is in a group, `code`, `a11y`, `forms`, `islands`, `performance`, `seo`, `security`, `i18n` or `deprecated`, and `lints` takes a group's level for every lint in it, a lint's own level winning.
- The `deprecated` group holds the old forms a minor replaced, each with a safe fix and the minor it came in (`since`, in `kay explain --format json`): `kay upgrade` moves an app to the latest kay and applies them (see [Commands](check-and-tools.md#check-and-inspect-commands)), and `kay check --fix` any time; `kay check --fix --since 1.46` fixes and reports the ones of that minor alone. A deprecation stays three minors, then goes. Their rows are in [Deprecated lints](deprecated-lints.md#deprecated-lints).
- `kay check --only seo` prints one group's lints alone, with no other problem, type errors included: an audit, not a check.
- `// kay-allow constant-signal` allows a lint on the line it ends, or, alone on its line, on the line after it, in a fence or in the template; it takes several names separated by commas, and one that is no lint is reported. A reason follows ` -- ` as in ESLint's `eslint-disable`, `// kay-allow unreachable-click -- kaynooo/kayjs#3120, Escape closes it`, and may hold commas.
- `// kay-allow-file constant-signal, missing-alt` anywhere in a file allows those lints in the whole file; it takes a ` -- ` reason too.
- `lints: { comments: { reason, file, denied } }` in `kay.config.ts` (booleans) makes a comment allow nothing with no ` -- reason`, as a `kay-allow-file`, or for a lint the config sets to `deny` by name or group; the first two are reported as `allow-refused`.
- `kay explain` lists the lints with their group; `kay explain seo` lists a group's; `kay explain positional-key` prints one with an example it reports and the same written right.

The table of lints is split by group, each page holding its rows (the `deprecated` group's are in [Deprecated lints](deprecated-lints.md)):

- [Accessibility lints](a11y-lints.md): `a11y`
- [Code lints](code-lints.md): `code`
- [Island and form lints](island-and-form-lints.md): `islands`, `forms`
- [Security and i18n lints](security-and-i18n-lints.md): `security`, `i18n`

### Performance lints

The `performance` group (`unsized-image`, `large-public-image`, `serial-awaits`) has its own page, which holds its rows: [Performance lints](performance-lints.md).

### SEO lints

The `seo` group has its own page, which holds its rows: [SEO lints](seo-lints.md).
