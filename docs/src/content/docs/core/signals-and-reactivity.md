---
title: Signals & Reactivity
description: Fine-grained push-pull signals with .value, glitch-free computed values, effects, O(1) selector, deep reactive stores, and JSX rules.
section: core
order: 1
---

Kay's reactivity kernel (`@kayjs/kay`) uses a push-pull doubly-linked-list dependency graph. With `"sideEffects": false`, unused helpers tree-shake to **0 bytes**.

## Core primitives

```tsx
import { batch, computed, effect, onCleanup, onMount, signal } from '@kayjs/kay'

export function Counter({ step = 1 }: { step?: number }) {
  const count = signal(0)
  const doubled = computed(() => count.value * 2)

  onMount(() => {
    const id = setInterval(() => { count.value += step }, 1000)
    onCleanup(() => clearInterval(id))
  })

  return (
    <div>
      <p>{count.value} × 2 = {doubled.value}</p>
      <button onClick={() => batch(() => { count.value += step })}>
        +{step}
      </button>
    </div>
  )
}
```

| Primitive | Purpose |
| :--- | :--- |
| `signal(initial)` | Reactive cell. Read and write via `.value`; read without subscribing via `.peek()`. |
| `computed(fn)` | Lazy, memoized, glitch-free derived signal. |
| `effect(fn)` | Runs whenever tracked dependencies change. Return a cleanup function if needed. |
| `batch(fn)` | Coalesces multiple signal writes into a single flush. |
| `untrack(fn)` | Reads signals without subscribing the enclosing computation. |
| `onMount(fn)` | Runs in the browser after the component's elements attach to the document. Return a cleanup function if needed. |
| `onCleanup(fn)` | Runs when the enclosing component or effect is disposed. |
| `root(dispose => ...)` | Creates an isolated disposal scope. |

## Compiler-safe prop destructuring

Destructuring props in Kay v2 stays reactive. The compiler rewrites reads of destructured props inside client components to live getter reads:

```tsx
export function Badge({ count = 0, label }: { count?: number, label: string }) {
  return <span>{label}: {count}</span>
}
```

To let a child mutate parent state, pass the signal itself as a prop (`<Modal open={isOpen} />`). No `bind:` syntax is needed.

## Tree-shakable helpers (`selector` & `store`)

- **`selector(() => selectedId.value)`**: Turns O(N) row-highlight checks in large tables into **O(1)** updates. Only the previously selected and newly selected rows re-run.
- **`store(initial)` + `snapshot(s)`**: Deep proxy store for nested objects and arrays. Costs 0 bytes if unimported.

## JSX rules

Kay's compiler and runtime reject common React, Solid, and Astro habits that would otherwise fail silently:

- **Raw HTML**: Use `innerHTML={html}` with a string (or `raw(html)` from `@kayjs/kay/server`). Never pass `{ __html }`, never use `dangerouslySetInnerHTML`, never combine `innerHTML` with children, and never put it on a void element.
- **Events**: Use camelCase DOM names (`onClick`, `onDblClick`, `onKeyDown`). Lowercase (`onclick`), namespaced (`on:click`), `onDoubleClick`, `*Capture`, string handlers, and render-time assignments (`onClick={count.value++}`) fail compilation. For capture listeners or custom events, call `addEventListener` inside a `ref`.
- **Refs**: Always pass a callback: `ref={el => ...}`. Ref objects (`{ current }`) are refused.
- **Attributes & SVG**: Use `class` or `className` (never both), standard `value`/`checked` (never `defaultValue`/`defaultChecked`), kebab-case SVG attributes (`stroke-width`, `fill-opacity`), and boolean `{false}` (never `"false"`). `style` accepts either a CSS string or an object (`style={{ color: 'red' }}`).
- **Renderable values**: Promises, functions, raw signal objects, and plain objects throw in JSX text and attributes. Read `count.value` instead of passing `count`.
- **Spread safety**: `{...spread}` automatically strips `on*` handlers, `innerHTML`, `srcdoc`, and `javascript:`/`vbscript:` URLs during SSR.
