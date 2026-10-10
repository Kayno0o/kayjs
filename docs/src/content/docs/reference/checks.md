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
- On a public site, what search engines and social networks read: a `site`, a description, a share image, a favicon. `kay build` also reads the head of every page it prerenders.

## Errors and warnings

Each lint has a level. `deny` is an error, `warn` a warning, `allow` hides it. Warnings fail the check only with `--deny-warnings`, which the `check` script of a new project passes. `kay build` and `kay dev` never fail on one.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unread-name` | deny | code | A prop, import or declaration nothing reads |
| `missing-alt` | deny | a11y | An `img` with no `alt` |
| `missing-title` | deny | a11y | An `iframe` with no `title` |
| `unreachable-click` | deny | a11y | An `onClick` on an element no keyboard reaches |
| `empty-control` | deny | a11y | A button or link with nothing to announce |
| `unknown-aria` | deny | a11y | An `aria-*` attribute ARIA does not define |
| `unknown-role` | deny | a11y | A `role` ARIA does not define |
| `missing-state` | deny | a11y | A `role="switch"` with no `aria-checked` |
| `hidden-focusable` | deny | a11y | A focusable element under `aria-hidden` |
| `positive-tabindex` | deny | a11y | A `tabindex` above 0 |
| `link-as-button` | deny | a11y | An `a` with `onClick` and no `href` |
| `nested-control` | deny | a11y | A button inside a link |
| `duplicate-id` | deny | a11y | An id two elements share |
| `invalid-autocomplete` | deny | forms | An `autocomplete` value HTML does not define |
| `unbounded-string` | deny | forms | A string field of an action with no `maxLength` |
| `positional-key` | warn | islands | A `for` keyed by position whose rows read `item.id` |
| `identity-key` | warn | islands | An island `for` over objects with no `id` or `key` |
| `missing-label` | warn | a11y | A form field with no label |
| `skipped-heading` | warn | a11y | An `h3` right after an `h1` |
| `autofocus` | warn | a11y | `autofocus` outside a `dialog` |
| `dangling-label` | warn | a11y | A `label(for)` pointing at no id |
| `missing-captions` | warn | a11y | A `video` with no captions |
| `redundant-alt` | warn | a11y | Alt text that says it is an image |
| `constant-signal` | warn | islands | A signal that is only ever read |
| `deprecated-page-export` | warn | code | A page setting exported under its own name, now a key of `page` |
| `deprecated-schema-name` | warn | code | The schema builder imported as `t`, now `s` |
| `literal-tag` | warn | code | An HTML tag written in template text, shown as written |
| `uncaught-await` | warn | code | An `await` block with no `catch` |
| `missing-site` | warn | seo | `seo` with no `site` |
| `missing-description` | warn | seo | No `seo.description` |
| `missing-share-image` | warn | seo | No share image on any page |
| `default-favicon` | warn | seo | kay's mark as the favicon |
| `untitled-page` | warn | seo | A page with no title |
| `undescribed-page` | warn | seo | A page with no description |
| `duplicate-title` | warn | seo | Two pages with one title |
| `long-description` | warn | seo | A description over 160 characters |
| `unsized-share-image` | warn | seo | A share image of unknown size |
| `noindex-in-sitemap` | warn | seo | A `noindex` page the sitemap lists |

## Fixing

```sh
kay check --fix        # applies the safe fixes, such as removing unread props
kay explain            # lists the lints
kay explain seo        # lists a group's
kay explain missing-alt
kay check --only seo   # one group's lints alone, as an audit
```

`kay explain <lint>` prints an example it reports and the same written right.

## Changing a level

In `kay.config.ts`, for the whole project:

```ts
export default defineConfig({
  lints: { 'positional-key': 'deny', 'unread-name': 'warn' },
})
```

A group sets every lint in it, and a lint's own level wins:

```ts
export default defineConfig({
  lints: { 'seo': 'deny', 'default-favicon': 'allow' },
})
```

The `seo` lints warn on a site with `site` or `seo` set, or exported with `--static`, and stay quiet on any other unless `lints` turns them on. The ones about pages are found by `kay build`, in the pages it prerenders. `missing-site`, `missing-share-image` and `default-favicon` name what a site lacks until it goes public, so only `kay build` and `kay check --only seo` report them, never a plain `kay check`.

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
