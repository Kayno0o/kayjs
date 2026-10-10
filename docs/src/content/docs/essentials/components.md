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

```kay
--- server
const greeting = 'Hello'
---
---
import Badge from './badge.kay'
---
p {greeting}
Badge(label="new")
```

`props`, `signal`, `memo`, `effect`, `onMount` and the translation `t` need no import. The rest of `kay`, such as `persisted` or `navigate`, is imported.

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

`signal(value)` holds state. In the template it is read by its name, in the script by calling it, and written with `.set`. `memo(fn)` caches a derived value.

```kay
---
const count = signal(0)
const double = memo(() => count() * 2)
---
button(onClick={() => count.set(c => c + 1)}) {count} x 2 = {double}
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
