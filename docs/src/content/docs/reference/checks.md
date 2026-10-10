---
title: Checks
order: 4
description: What kay check reports, how to fix it and how to change a lint's level.
---
`kay check` type-checks the whole project, `.kay` files included, and reports each problem at its `.kay` line and column, as rustc does:

```
error[missing-alt]: An `img` needs `alt`
 --> src/routes/index.kay:4:3
  = note: `alt=""` marks an image as decoration
```

The name in brackets is a lint. `kay build` runs the same check and `kay dev` shows it in a panel in the browser.

## What it verifies

- Expressions, props and server data, as TypeScript does.
- Links to pages, public files and API routes, including `ctx.redirect`, `navigate()` and form `action`s.
- Form field names against the action's schema.
- Content collection entries against their schema.
- With `i18n`, every `t()` key and placeholder in every locale.
- Island props can be serialized, and no component reads a browser global while it renders.
- Accessibility basics: `alt`, labels, headings, keyboard access.
- Config the server would refuse at boot, such as two pages serving one path.

## Errors and warnings

Each lint has a level. `deny` is an error, `warn` a warning, `allow` hides it. Warnings fail the check only with `--deny-warnings`, which the `check` script of a new project passes. `kay build` and `kay dev` never fail on one.

| Lint | Default | Reports |
| --- | --- | --- |
| `unread-name` | deny | A prop, import or declaration nothing reads |
| `missing-alt` | deny | An `img` with no `alt` |
| `missing-title` | deny | An `iframe` with no `title` |
| `unreachable-click` | deny | An `onClick` on an element no keyboard reaches |
| `empty-control` | deny | A button or link with nothing to announce |
| `unbounded-string` | deny | A string field of an action with no `maxLength` |
| `positional-key` | warn | A `for` keyed by position whose rows read `item.id` |
| `identity-key` | warn | An island `for` over objects with no `id` or `key` |
| `missing-label` | warn | A form field with no label |
| `skipped-heading` | warn | An `h3` right after an `h1` |
| `constant-signal` | warn | A signal that is only ever read |
| `uncaught-await` | warn | An `await` block with no `catch` |

## Fixing

```sh
kay check --fix        # applies the safe fixes, such as removing unread props
kay explain            # lists the lints
kay explain missing-alt
```

`kay explain <lint>` prints an example it reports and the same written right.

## Changing a level

In `kay.config.ts`, for the whole project:

```ts
export default defineConfig({
  lints: { 'positional-key': 'deny', 'unread-name': 'warn' },
})
```

For one place, with a comment on the line, or alone on the line before:

```kay
// kay-allow constant-signal
const label = signal('Save')
```

## ESLint

ESLint lints the script and server fences of `.kay` files through `kay/eslint`. With `@kaynooo/eslint`, turn it on in `eslint.config.ts`:

```ts
export default defineConfig({ strict: true, kay: true })
```

<Callout type="note">

Type-aware rules read files that `kay check`, `kay dev` and the editor write, so run one of them before linting.

</Callout>

<ReadMore href="/llms/checks">Every check in detail, what the editor adds and how the check cache works are in the full checks reference.</ReadMore>
