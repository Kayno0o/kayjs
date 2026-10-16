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

`---` opens the component script: imports, props, signals, functions. It runs wherever the component renders.

`--- server` exists on pages and layouts only. It runs on the server for each request and never reaches the browser.

A fence ends on a `---` line, or on the line opening the next one. `--- script` spells the component script out, for when it follows another fence.

```kay
--- server
const greeting = 'Hello'
--- script
import Badge from './badge.kay'
---
p {greeting}
Badge(label="new")
```

Some names need no import: `props`, `signal`, `memo`, `effect`, `onMount`, `onCleanup`, the translation `t`, and `action` in a server fence. Import anything else, such as `persisted` from `kay`. [Modules](/reference/modules) says which entry holds what.

## Props

Declare props once with `props<T>()`. Destructure them, with defaults, and they stay reactive.

A page has no props. Its data comes from its `--- server` fence.

## Using a component

A component is a capitalised tag, imported in the script. Pass props as attributes.

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

`import.meta.glob` imports every file a pattern matches, as in Vite:

```kay
---
import type { Component } from 'kay'

const cards = import.meta.glob<Component>('../cards/*.kay', { eager: true, import: 'default' })
---
for Card of Object.values(cards)
  Card
```

Without `eager`, each value is a function that imports the file when called. Write the patterns and options in the call itself, because the build reads them there.

## Slots and blocks

Children of a component go to its `slot`. A `@name` block under it becomes the prop `name`, which the component renders with `slot name`. This is `src/components/card.kay`.

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

A parent fills both.

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

`signal(value)` holds state. Read it by calling it, `{count()}`. Write it by assigning it, `count++`, or with `.set`. Both work in the template and in the script.

`memo(fn)` caches a derived value.

```kay
---
const count = signal(0)
const double = memo(() => count() * 2)
---
button(onClick={() => count++}) {count()} x 2 = {double()}
```

A component using signals or handlers becomes an island: see [Islands](/essentials/islands).

Handed to a component as a prop, `Toggle(open={open})`, a signal passes as itself. The prop is typed `Signal<boolean>`, and the component reads and writes it.

Handed to a parameter typed `unknown` or `any`, as in `String(count)`, a signal is an error, `uncalled-signal`. Call it there.

Assigning works on a signal held in a `const`, an import or a `Signal<boolean>` prop, and on a `let` the script sets to `signal(...)`. For a signal in an object's property, `box.count`, or a `let` set from a function's result, write `.set`. Assigning would replace the property, and `kay check` reports a type error.

## Generic components

Type parameters on the fence line make a component generic. Each use infers them from its props.

```kay
--- <T extends { id: number }>
const { items, show } = props<{ items: T[], show: (item: T) => string }>()
---
ul
  for item of items
    li {show(item)}
```

<ReadMore href="/llms/components">Blocks taking parameters, `linked` and `selection` signals, and shipping components in a package are in the full components reference.</ReadMore>
