---
title: Automatic Islands
description: Zero-directive island detection via oxc-parser, native <kay-island> hydration strategies, and <kay-slot> static children.
section: core
order: 2
---

Kay analyzes every `.tsx` file at build time using `oxc-parser`. Static components compile to flat SSR string concatenation (`0 KB` JS); interactive components automatically become `<kay-island>` boundaries.

## How detection works

You never write `'use client'` or `client:load`. A component is compiled as an island automatically when it uses any of:

- Reactive primitives: `signal`, `computed`, `effect`, `onMount`, `store`, `selector`
- DOM interactivity: `on*` event handlers (`onClick`, `onInput`, etc.) or `ref` on an HTML or SVG element. On a component tag they are plain props.
- Reactive state imported from another module, such as `export const cart = store([])` in `src/state.ts`
- Explicit wrapper: `island(Component, { hydrate: 'visible' })`

<Callout title="Zero-JS Guarantee" tone="tip">
When a route only renders static components and native HTML forms, Kay omits the client runtime completely — zero `<script>` tags are emitted in the HTML.
</Callout>

```tsx
// src/components/Counter.tsx — auto-detected island (~0.20 KB br)
import { signal } from 'kay'

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

Control when any island downloads and hydrates using the TypeScript-checked `$hydrate` prop at the call site:

| Strategy | When it hydrates | Best for |
| :--- | :--- | :--- |
| `$hydrate="load"` | Immediately on page load (default) | Critical above-the-fold controls |
| `$hydrate="visible"` | When scrolled into the viewport (`IntersectionObserver`) | Charts, tables, below-the-fold widgets |
| `$hydrate="interaction"` | On first pointer/keyboard interaction | Menus, dialogs, dropdowns |
| `$hydrate="idle"` | Via `requestIdleCallback` | Search palettes, non-blocking enhancements |
| `$hydrate="media(max-width: 768px)"` | When the CSS media query matches | Mobile-only drawers or nav toggles |
| `$hydrate="client"` | Skips SSR, mounts client-side only | Browser-only canvas / WebGL widgets |

## Static children inside islands (`<kay-slot>`)

When you pass server-rendered JSX children into an interactive island (`<Modal><ServerMarkdown /></Modal>`), Kay renders the children on the server inside `<kay-slot>` and preserves them untouched during hydration — shipping **0 bytes** of client JS for the slotted content.

## Server-only `async` routes

An `export default async function Page()` route is strictly server-only. You can `await` databases or files directly inside it, and the compiler rejects accidental signals or event handlers inside the async page body (guiding you to extract the interactive piece into a child component).

`_layout.tsx`, `_error.tsx` and `_404.tsx` render on the server only too. If one of them uses a signal or an event handler, `kay build` fails: move that part into a component and render it from the layout.

## What an island may import

An island ships to the browser with every module it imports. If one of those modules, at any depth, imports a server-only module (`bun:sqlite`, `node:fs`, `kay/server` and the like) or reads `process.env`, `kay build` fails and `kay check` names the module and the island that reaches it. A file that declares server actions is the exception: the browser gets a stub that calls the server, never its code. Only its actions reach the browser, so importing any other export of it from an island fails the build.

Client code may read `process.env.PUBLIC_*`. The build replaces each one with its value at build time, so never put a secret in a `PUBLIC_` variable.
