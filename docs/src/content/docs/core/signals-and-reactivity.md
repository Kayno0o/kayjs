---
title: Signals & Reactivity
description: Fine-grained push-pull signals with .value, glitch-free computed values, effects, O(1) selector, and deep reactive stores.
section: core
order: 1
---

Kay's reactivity kernel (`kay`) uses a push-pull doubly-linked-list dependency graph with `"sideEffects": false` so unused primitives tree-shake to **0 bytes**.

## Core primitives

```tsx
import { batch, computed, effect, onCleanup, onMount, signal } from 'kay'

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
| `signal(initial)` | Reactive cell; read & write via `.value`, non-tracking read via `.peek()` |
| `computed(fn)` | Lazy, memoized, glitch-free derived signal |
| `effect(fn)` | Runs whenever tracked dependencies change; return a cleanup function |
| `batch(fn)` | Coalesces multiple signal writes into a single flush |
| `untrack(fn)` | Reads signals without subscribing the enclosing computation |
| `onMount(fn)` | Runs in the browser once the component's elements are in the document; return a cleanup function |
| `onCleanup(fn)` | Runs when the component is disposed |
| `root(dispose => ...)` | Creates an isolated disposal scope |

## Compiler-safe prop destructuring

Unlike SolidJS, destructuring props in Kay v2 **stays reactive**. The compiler rewrites reads of destructured props in client components to live getter reads:

```tsx
export function Badge({ count = 0, label }: { count?: number, label: string }) {
  return <span>{label}: {count}</span>
}
```

To let a child component mutate parent state, pass the signal itself as a prop (`<Modal open={isOpen} />`) — no special `bind:` syntax needed.

## Tree-shakable helpers (`selector` & `store`)

- **`selector(() => selectedId.value)`**: turns O(N) row-highlight checks in large tables into **O(1)** updates (only the previously selected and newly selected rows update).
- **`store(initial)` + `snapshot(s)`**: deep proxy store for nested objects and forms; 0 bytes in your bundle if unimported.
