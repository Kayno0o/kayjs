---
title: Automatic Islands
description: Zero-directive island detection via oxc-parser, native <kay-island> hydration strategies, prop serialization, and <kay-slot> static children.
section: core
order: 2
---

Kay analyzes every `.tsx` file at build time using `oxc-parser`. Static components compile to flat SSR string concatenation (`0 KB` JS). Interactive components automatically become `<kay-island>` boundaries.

## How detection works

You never write `'use client'` or `client:load`. A component becomes an island automatically when it uses any of:

- Reactive primitives: `signal`, `computed`, `effect`, `onMount`, `store`, `selector`
- DOM interactivity: `on*` event handlers (`onClick`, `onInput`, etc.) or `ref` on an HTML or SVG element (on a component tag they are plain props)
- Reactive state imported from another module, such as `export const cart = store([])` in `src/state.ts`
- Explicit wrapper: `island(Component, { hydrate: 'visible' })`

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

## Hydration strategies (`$hydrate`)

Control when an island downloads and hydrates using `$hydrate` at the call site. Unknown modes and `$hydrate` on non-islands fail compilation.

| Strategy | When it hydrates | Best for |
| :--- | :--- | :--- |
| `$hydrate="load"` | Immediately on page load (default) | Critical above-the-fold controls |
| `$hydrate="visible"` | When scrolled into the viewport (`IntersectionObserver`) | Charts, tables, below-the-fold widgets |
| `$hydrate="interaction"` | On first pointer or keyboard interaction | Menus, dialogs, dropdowns |
| `$hydrate="idle"` | Via `requestIdleCallback` | Search palettes, non-blocking enhancements |
| `$hydrate="media(max-width: 768px)"` | When the CSS media query matches | Mobile-only drawers or nav toggles |
| `$hydrate="client"` | Skips SSR and mounts client-side only | Browser-only canvas or WebGL widgets |

## Props across the island boundary

Props passed from server code into an island are serialized into HTML and restored in the browser.

- **Supported**: JSON primitives, arrays, plain objects, `Date`, `Map`, `Set`, `URL`, and `RegExp`.
- **Refused**: Functions, signals, and arbitrary class instances fail `kay check` and SSR. Define callbacks inside the island, or pass serializable IDs and data instead.

## Static children inside islands (`<kay-slot>`)

When you pass server-rendered JSX children into an island (`<Modal><ServerMarkdown /></Modal>`), Kay renders those children on the server inside `<kay-slot>`. Hydration preserves the slot untouched and ships **0 bytes** of client JS for its content.

## Server-only `async` routes and layouts

An `export default async function Page()` route runs strictly on the server. You can `await` databases or files directly inside it. Using signals or DOM handlers inside an `async` route fails compilation — extract the interactive part into a child component.

`_layout.tsx`, `_error.tsx`, and `_404.tsx` also render on the server only. Move any interactive widget (such as a theme toggle or search palette) into its own component and render it from the layout.

## What an island may import

An island ships to the browser with every module it imports. If any reachable module imports a server-only module (`bun:sqlite`, `node:fs`, `@kayjs/kay/server`, and similar) or reads `process.env`, `kay build` fails and `kay check` names the module and the island that reaches it.

A file that declares server actions is the exception. The browser receives a tiny RPC stub instead of its server code. Importing any non-action export from that file inside an island fails the build.

Client code may read `process.env.PUBLIC_*`. The build inlines each value at build time, so never store secrets in `PUBLIC_*` variables.
