---
title: Components
order: 2
description: One .kay file is one component, with fences for its code and a template for its markup.
---

A component is a `.kay` file: up to two fences, then the template. Both fences are optional.

```kay
---
import type { Todo } from '../data'

const { todo, size = 'md', onToggle } = props<{
  todo: Todo
  size?: 'sm' | 'md'
  onToggle?: (id: number) => void
}>()
---
li(class={size})
  input(
    type="checkbox"
    aria-label="Done"
    checked={todo.done}
    onChange={() => onToggle?.(todo.id)}
  )
  span {todo.title}
```

## Fences

- `---` is the component script: imports, props, signals, functions. It runs wherever the component renders.
- `--- server` exists on pages and layouts only. It runs on the server for each request and never reaches the browser.

A fence ends on a `---` line, or on a `--- server`, `--- client` or `--- script` line, which opens the next fence. `--- script` is the component script spelled out, for when it follows another fence.

```kay
--- server
const greeting = 'Hello'
--- script
import Badge from './badge.kay'
---
p {greeting}
Badge(label="new")
```

`props`, `signal`, `memo`, `effect`, `onMount`, `onCleanup` and the translation `t` need no import. The rest of `kay`, such as `persisted` or `navigate`, is imported.

## Props

Props are declared once with `props<T>()`. Destructure them, with defaults, and they stay reactive. A default applies only to an `undefined` prop. A page has no props: its data comes from its `--- server` fence.

## Using a component

A component is a capitalised tag, imported in the script. Pass props as attributes:

```kay
---
import type { Todo } from '../data'
import TodoItem from './todo-item.kay'

const { todos } = props<{ todos: Todo[] }>()
---
ul
  for todo of todos
    TodoItem(todo={todo} size="sm")
```

## Many components at once

`import.meta.glob` imports every file a pattern matches, as in Vite, keyed by its path as the pattern writes it:

```kay
---
import type { Component } from 'kay'

const cards = import.meta.glob<Component>('../cards/*.kay', { eager: true, import: 'default' })
---
for Card of Object.values(cards)
  Card
```

Without `eager`, each value is a function importing the file when called. A pattern starts with `./`, `../` or `/` for the project's root, and one starting with `!` leaves its files out. Patterns and options are written in the call, as the build reads them, and `kay dev` picks up a file added or removed with nothing to rerun.

## Slots and blocks

Children of a component go to its `slot`. A `@name` block directly under it becomes the prop `name`, which the component renders with `slot name`; the lines under a `slot` render when it gets nothing. `src/components/card.kay`:

```kay
---
import type { JSX } from 'kay'

const { title, actions } = props<{ title: string, actions?: JSX.Element }>()
---
article.card
  header
    h2 {title}
    slot actions
  slot
```

And a parent filling both:

```kay
---
import Card from '../components/card.kay'
---
Card(title="Todos")
  @actions
    a(href="/new") New
  p Body text
```

## Signals

`signal(value)` holds state. In the template it is read by its name, in the script by calling it, and written in both by assigning it, `count++`, or with `.set`. `kay check` narrows a signal within the template expression reading it, so `{error && error.message}` checks with `error` a `signal<Error>()`; reads inside a handler or a `.map` callback run later and are not narrowed at all: copy the value into a `const` first, or assert it, `error!`. `memo(fn)` caches a derived value.

```kay
---
const count = signal(0)
const double = memo(() => count() * 2)
---
button(onClick={() => count++}) {count} x 2 = {double}
```

A component using signals or handlers becomes an island: see [Islands](/essentials/islands).

## Generic components

Type parameters on the fence line make a component generic. Each use infers them from its props:

```kay
--- <T extends { id: number }>
const { items, show } = props<{ items: T[], show: (item: T) => string }>()
---
ul
  for item of items
    li {show(item)}
```

<ReadMore href="/llms/components">Blocks taking parameters, `linked` and `selection` signals, and shipping components in a package are in the full components reference.</ReadMore>
