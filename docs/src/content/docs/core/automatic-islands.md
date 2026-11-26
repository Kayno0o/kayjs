---
title: Automatic Islands
description: Zero-directive island detection via oxc-parser, native <kay-island> hydration strategies, prop serialization, and <kay-slot> static children.
section: core
order: 2
---

Kay analyzes every `.tsx` file at build time using `oxc-parser`. Static components compile to flat SSR string concatenation (`0 KB` JS). Interactive components automatically become `<kay-island>` boundaries.

## How detection works

You never write `'use client'` or `client:load`. A component becomes an island automatically when it uses any of:

- A call to a reactive primitive: `signal`, `computed`, `effect`, `onMount`, `store`, `selector`
- DOM interactivity: `on*` event handlers (`onClick`, `onInput`, etc.) or `ref` on an HTML or SVG element (on a component tag they are plain props)
- Reactive state imported from another module, such as `export const cart = store([])` in `src/state.ts`

kay decides this for each component, not for each file. A static component exported beside an island stays static and ships no JS. A component that needs the browser is an island wherever server code renders it as a tag, even in the same file. A page that declares `Counter` and renders `<Counter />` in twelve sections stays static, and only the counter ships. The island's JS holds the code it reaches and nothing else of the file. So an `async` page can await data from server code and still render a local widget. Its props cross the same boundary as an imported island's, so a handler the page passes to it is refused. A helper called as a function, such as `renderDialog()`, runs where its caller runs: calling one that needs the browser makes the caller an island. Code at the top of a file that calls a primitive, such as `effect(...)`, makes every component of that file an island.

A handler passed from server code to a component that is not an island would never reach the browser, so `kay build` and `kay check` refuse `<Button onClick={...}>` there. Write the handler inside `Button`, which makes it an island, or render `Button` from an island.

An island renders on the server first, where `window`, `document` and `localStorage` do not exist. Reading one while a component renders, or when its module loads, throws at the first request, so `kay build` and `kay check` warn with the file and line. Read it in `onMount()`, an effect or an event handler, or check `typeof window !== 'undefined'` first.

<Callout title="Zero-JS guarantee" tone="tip">
When a route renders only static components and native HTML forms, Kay omits the client runtime completely. Zero `<script>` tags are emitted in the HTML.
</Callout>

```tsx
// src/components/Counter.tsx — auto-detected island
import { signal } from '@kayjs/kay'

export function Counter({ initial = 0 }: { initial?: number }) {
  const count = signal(initial)
  return (
    <button onClick={() => count.value++}>
      Clicked {count.value} times
    </button>
  )
}
```

## Why a route ships JS

`kay build --analyze` lists, under each route, the islands it loads and why each became one:

```text
/about                               0.00 KB       0.00 KB     0j/0c
/                                    3.68 KB       0.00 KB     5j/0c
  island: Clicker (src/components/Count.tsx) uses onClick
  island: Total (src/components/Count.tsx) reads count from '../stores/count'
  island, deferred: Later (src/components/Later.tsx) uses onClick
```

Here `/about` renders `Label`, a static component of `Count.tsx`, and ships no JS.

A deferred island hydrates later (any mode but `load`), so its JS is not counted in the route's eager weight. A plugin with a `clientEntry`, such as `spa()`, loads the runtime on every page, so its JS counts on a page with no island too. `kay build --max-js 40kb` fails the build when a route's gzipped eager JS is over 40 KB, and names the route and its eager islands.

## Hydration strategies (`$hydrate`)

Control when an island downloads and hydrates using `$hydrate` at the call site, or set the default for every call site with `export const hydrate = 'visible'` in the component's file. Unknown modes and `$hydrate` on non-islands fail compilation.

| Strategy | When it hydrates | Best for |
| :--- | :--- | :--- |
| `$hydrate="load"` | Immediately on page load (default) | Critical above-the-fold controls |
| `$hydrate="visible"` | When scrolled into the viewport (`IntersectionObserver`) | Charts, tables, below-the-fold widgets |
| `$hydrate="interaction"` | On first pointer or keyboard interaction | Menus, dialogs, dropdowns |
| `$hydrate="idle"` | Via `requestIdleCallback` | Search palettes, non-blocking enhancements |
| `$hydrate="media(max-width: 768px)"` | When the CSS media query matches | Mobile-only drawers or nav toggles |
| `$hydrate="client"` | Skips SSR and mounts client-side only | Browser-only canvas or WebGL widgets |

The code that waits for a strategy ships only when an island of the app can use it, so an app hydrating everything on `load` ships none of it. A page preloads the JS of its `load` islands and every chunk they and the runtime import, so the browser fetches them all at once. The other islands download when their strategy fires.

## Props across the island boundary

Props passed from server code into an island are serialized into HTML and restored in the browser.

- **Supported**: JSON primitives, arrays, plain objects, `Date`, `Map`, `Set`, `URL`, and `RegExp`. Plain JSON costs no extra JS. A page whose props hold one of these classes also preloads a small file that turns them back into objects.
- **Refused**: Functions, signals, and arbitrary class instances fail `kay check` and SSR. Define callbacks inside the island, or pass serializable IDs and data instead.
- **JSX goes in children**: JSX in any other prop (`<Modal header={<h2>Hi</h2>} />`) fails `kay check` and SSR, because it would reach the browser as a plain object. Pass it as children, which render on the server, or build it inside the island.

## Static children inside islands (`<kay-slot>`)

When you pass server-rendered JSX children into an island (`<Modal><ServerMarkdown /></Modal>`), Kay renders those children on the server inside `<kay-slot>`. Hydration preserves the slot untouched and ships **0 bytes** of client JS for its content. The children render before the island, in the page's scope: they read the page's contexts, and an island among them hydrates on its own.

## When the page changed before hydration

A browser extension or a password manager sometimes adds its own element inside an island before it hydrates. Hydration steps over that element and attaches to the markup kay rendered. If the server rendered something else entirely, the island draws that part again from scratch rather than wiring handlers to the wrong element. Both work in production; in dev, the console also names the island, the element expected and the one found.

## What an island cannot use

The browser renders an island without the page around it, so kay refuses what would differ there:

- `<Head>` and `<Suspense>` run during server rendering only. In an island they fail compilation: render them in the page or a layout.
- A context provided outside the island reaches it on the server only. Reading one throws `kay: <Counter> reads a context provided outside the island`: pass the value as a prop. A context the island provides itself works on both sides.

## Server-only `async` routes and layouts

An `export default async function Page()` route runs strictly on the server. You can `await` databases or files directly inside it. Using signals or DOM handlers inside an `async` route fails compilation — extract the interactive part into a child component.

`_layout.tsx`, `_error.tsx`, and `_404.tsx` also render on the server only. Move any interactive widget (such as a theme toggle or search palette) into its own component and render it from the layout.

## What an island may import

An island ships to the browser with every module it imports. If any reachable module imports a server-only module (`bun:sqlite`, `node:fs`, `@kayjs/kay/server`, and similar) or reads `process.env`, `kay build` fails and `kay check` names the module and the island that reaches it.

A file that declares server actions is the exception. The browser receives a tiny RPC stub instead of its server code. Importing any non-action export from that file inside an island fails the build.

Client code may read `process.env.PUBLIC_*`. The build inlines each value at build time, so never store secrets in `PUBLIC_*` variables.
