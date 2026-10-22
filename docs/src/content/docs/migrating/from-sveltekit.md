---
title: Migrating from SvelteKit
order: 2
description: Map what you know from SvelteKit to kay, concept by concept, and see what has no counterpart.
---

SvelteKit is the closest model to kay's. A page loads its data on the server, a form works without JavaScript, and layouts wrap pages. There is no `kay migrate` command for it, as `.svelte` and `.kay` differ too much for a tool to translate. You move a project by hand, one route at a time.

Start with `kay new` (see [Installation](/getting-started/installation)), then move the routes. Each section below maps one part of SvelteKit.

## Files and routes

| SvelteKit | kay |
| --- | --- |
| `src/routes/about/+page.svelte` | `src/routes/about.kay`, or `about/index.kay` |
| `+page.server.ts` with `load` | The `--- server` fence of the page |
| `+layout.svelte` | `_layout.kay`, which renders the page at `slot` |
| `+layout.server.ts` with `load` | The `--- server` fence of the layout, for the layout's own markup |
| `+error.svelte` | `_error.kay`, reading `ctx.error` |
| `+server.ts` | An [API route](/guides/api-routes) in `src/api/`, or an [endpoint file](/essentials/routing#endpoint-files) |
| `[slug]`, `[...rest]`, `[[optional]]` | The same folder and file names |
| `[id=integer]` and `src/params/integer.ts` | `[id=integer]`, with built-in matchers and `src/params/` for your own |
| `(group)` | `(group)`, a folder that adds nothing to the URL |
| `src/lib` | Any folder you like, imported by a relative path |
| `static/` | `public/` |
| `svelte.config.js` | `kay.config.ts` |

A fixed name wins over a param, and a param over a catch-all, as in SvelteKit.

A `_404.kay` renders for `ctx.notFound()` and for every URL no page serves.

## Loading data

A `load` function returns an object, and the page reads it as `data`. In kay the fence is the load. Every top-level name it declares reaches the template, typed, and none of the fence ships to the browser.

```ts
// +page.server.ts
export async function load({ params }) {
  const post = await findPost(params.slug)

  if (!post)
    error(404, 'Not found')

  return { post }
}
```

In kay it is one file.

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

| SvelteKit | kay |
| --- | --- |
| `event.params`, `event.url`, `event.cookies` | `ctx.params`, `ctx.url`, `ctx.cookies` |
| `url.searchParams` | `ctx.query`, typed by a `query` schema in `page` (see [Data loading](/essentials/data-loading)) |
| `event.locals` | `ctx.locals` |
| `error(404)` | `ctx.notFound()` |
| `error(403, 'Members only')` | `ctx.deny(403, 'Members only')` |
| `redirect(302, '/login')` | `ctx.redirect('/login')` |
| `setHeaders` | `ctx.headers` |
| A promise returned from `load`, streamed | A promise left unawaited, rendered in an `await` block |
| `export const prerender = true` | `export const page = { prerender: true }` |
| `entries()` for prerendering | `prerender: [{ slug: 'a' }]` in `page`, or a content collection |
| `export const trailingSlash` | `trailingSlash` in `kay.config.ts` |

A layout's fence runs in parallel with the page's. What it declares reaches the layout's own template and no further, so a page does not get a layout's data as `data`.

A page reads what it needs in its own fence. A value several loads share goes through `cached()` from `kay/cache`. A value of the request, such as the signed-in user, goes through `ctx.locals`.

## Form actions

A SvelteKit action reads `FormData` by hand, returns `fail(400, ...)` for a refusal, and the page reads it as `form`. A kay action declares a schema, and kay validates the input before the handler runs.

```kay
--- server
import { s } from 'kay'
import { addTodo, listTodos } from '../data'

const newTodo = s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }) => {
  await addTodo(title)
})

const todos = await listTodos()
---
ul
  for todo of todos
    li {todo.title}
form(action={add})
  input(field="title" placeholder="New todo")
  error title
  button Add
```

| SvelteKit | kay |
| --- | --- |
| `export const actions = { add }` | `export const add = action(schema, handler)`, one export per action |
| `<form method="POST" action="?/add">` | `form(action={add})` |
| `use:enhance` | Nothing to add. With kay's script a form posts without a reload, and without it the form still posts |
| `fail(400, { missing: true })` | The schema refuses the input, or the handler returns `ctx.fail(409, data)` |
| `form?.missing` | `add.error('title')`, `error title` in the template, or `add.failed()?.data` |
| `form` after a success | `add.succeeded()` |
| `redirect(303, '/')` in an action | `return ctx.redirect('/')` |
| `invalidateAll()` after a post | Automatic. The page's loads run again after an action |
| `enhance` with a callback | An island calls `add({ title })` from a submit handler, see [Forms and actions](/essentials/forms-and-actions) |

A refused post renders the page again and the fields keep what was sent, so there is no `value={form?.title}` to write.

## Layouts

A `+layout.svelte` renders `{@render children()}`. A `_layout.kay` renders `slot`.

```kay
header
  a(href="/") Home
  a(href="/blog") Blog
main
  slot
```

Layouts nest, outermost first. `layouts: false` in a page's `page` drops the layouts above it, which SvelteKit does with `+page@.svelte`.

## Runes and stores

Runes become the signals of kay. A signal is read by calling it and written by assigning it, in the script and in the template.

| Svelte 5 | kay |
| --- | --- |
| `let count = $state(0)` | `const count = signal(0)` |
| `count++` | `count++` |
| `{count}` | `{count()}` |
| `$derived(count * 2)` | `memo(() => count() * 2)` |
| `$effect(() => { ... })` | `effect(() => { ... })`, which runs after the render and again when a signal it read changes |
| `let { title } = $props()` | `const { title } = props<{ title: string }>()` |
| `onMount` | `onMount`, which runs in the browser only |
| `bind:value={name}` | `bind:value={name}`, with `name` a signal |
| `onclick={...}` | `onClick={...}` |
| `{#if}`, `{:else}` | `if`, `else` |
| `{#each items as item}` | `for item of items` |
| `{#await promise}` | An `await` block with `then` and `catch` |
| `{@render children()}` | `slot` |
| `{#snippet x(a)}`, `{@render x(1)}` | `snippet x(a)` and `{x(1)}`, see [Templates](/essentials/templates#reuse-a-block-in-one-file) |
| A snippet passed as a prop | An `@name` block, which can take parameters, rendered with `slot name`, or a snippet or function passed as `row={x}` |
| `<svelte:head>` | A `head` block, see [Head and SEO](/essentials/head-and-seo) |
| `setContext`, `getContext` | `context`, see the [islands reference](/llms/islands) |
| `$env/static/public` | `s.Public` fields of `defineEnv`, read as `publicEnv` from `kay` |
| `$env/static/private` | `defineEnv` in `src/env.ts`, imported from server code |
| `goto('/todos')` | `navigate('/todos')` from `kay` |
| `page.url.searchParams` in a component | `queryParam('page')` from `kay`, or `ctx.query` on the server |

A store is a module that exports a signal. Every island that imports it shares one state.

```ts
// src/cart.ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`writable` becomes `signal`, `derived` becomes `memo`, and `$cart` becomes `cart()`. `persisted` keeps its value in a cookie, so the server renders the right first paint.

## What hydrates

SvelteKit hydrates the whole page. kay hydrates islands only. An island is a component with an `on*` handler, a `bind:`, a `ref` or a signal. Every other component renders to HTML and ships no JavaScript.

So a component that was only markup in Svelte needs nothing, and one with state becomes an island by having it. `kay build` lists the islands and what made each one. See [Islands](/essentials/islands).

## Hooks

There is no `hooks.server.ts`. What it did splits three ways.

```ts
// hooks.server.ts
export async function handle({ event, resolve }) {
  event.locals.user = await findUser(event.cookies.get('session'))

  return resolve(event)
}
```

| SvelteKit | kay |
| --- | --- |
| `handle` setting `event.locals` | An Elysia plugin using `derive`, mounted before `pages()` in `src/server.ts` |
| `handle` redirecting or denying | A `_guard.ts`, which runs before every page, action and endpoint in its folder and below |
| `handleError` | `_error.kay` for the page the visitor sees, and Elysia's `onError` for logging |
| `handleFetch` | Nothing: a fetch is a plain `fetch` |
| `sequence(...)` | `.use(...)`, one plugin after another |

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const auth = new Elysia({ name: 'auth' })
  .derive({ as: 'scoped' }, async ({ cookie }) => ({
    user: await findUser(cookie.session?.value),
  }))

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'

export default guard(({ locals, redirect }) => {
  if (locals.user === undefined)
    return redirect('/login')
})
```

See [Sessions and guards](/guides/sessions-and-guards), which also covers `session()`, and [kayjs-auth](/libraries/kayjs-auth) for sign-in pages.

## Styles

A component imports its stylesheet in its script, `import './card.css'`. Svelte's `<style>` block, scoped to its component, has no counterpart.

Tailwind works as in SvelteKit. See [Styling and assets](/essentials/styling-and-assets).

## Stricter TypeScript

Kay's `tsconfig.json` turns on `noUncheckedIndexedAccess`, so `cells[index]` is typed `Cell | undefined`, and plain modules written without it report errors `kay check` finds in files no `.kay` touches. Add `"noUncheckedIndexedAccess": false` to the app's own `compilerOptions` to keep them as they are, or write the `!` where the index is known to exist.

## What has no equivalent

- **A universal `load`** (`+page.ts`). A kay load runs on the server only. The browser asks for data through an [API route](/guides/api-routes) and `resource`.
- **Layout data passed to pages.** See [Loading data](#loading-data) for what to do instead.
- **`ssr = false` and `csr = false`.** A page is always rendered on the server, and a page with no island ships no component code. A component that cannot render on the server starts its script with `--- client`.
- **Adapters.** kay runs on Bun alone. `kay build --compile` makes one executable and `kay build --static` makes plain files, see [Deployment](/guides/deployment).
- **Svelte components.** They do not run in `.kay`. Rewrite each as a `.kay` component.
- **`use:` actions.** Use a `ref` or an `onMount` instead. Transitions are the `transition="fade"` attribute, played by CSS classes, see the [islands reference](/llms/islands).
- **`data-sveltekit-preload-data`.** Links are prefetched by kay's `prefetch` setting, and `data-no-prefetch` opts one out.

Run `bun run check` as you go. It type-checks every `.kay` file and reports each link to a page that does not exist.
