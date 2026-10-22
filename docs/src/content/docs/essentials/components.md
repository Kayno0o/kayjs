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

Everything `kay` exports needs no import in a script or a server fence: `signal`, `memo`, `persisted`, `navigate`, `s`, `action` and the rest, as well as `props` and the translation `t`. A name only the template reads, such as `route` in a link, is imported too.

Import what comes from another entry, such as `cached` from `kay/cache`, and `kay check` names the entry when you forget. [Modules](/reference/modules) says which entry holds what. A script using only helpers that read nothing reactive, such as `route` or `withBase`, keeps the component static.

## Props

Declare props once with `props<T>()`. Destructure them, with defaults, and they stay reactive.

A page has no props. Its data comes from its `--- server` fence.

A prop can hold an action, typed `Action<never, unknown>` for any action (see [Forms and actions](/essentials/forms-and-actions)), or a component, typed `Component<Props>` from `kay` and used by its capitalised name: `const { Icon } = props<{ Icon: Component }>()`, then `Icon` as a tag. An icon is drawn with `svg({...icon})`; see [Draw an icon or a component chosen by a value](/essentials/templates#draw-an-icon-or-a-component-chosen-by-a-value).

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
import type { Snippet } from 'kay'

const { title, actions } = props<{ title: string, actions?: Snippet }>()
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

### Blocks that take parameters

A `@name(x)` block is markup the component calls with values, typed `Snippet<[...]>` (`Snippet` alone is markup with no parameters, as the children and `@name` are), for a block that needs the component's own data. The component renders it with `slot name(x)`. This is `src/components/list.kay`.

```kay
---
import type { Snippet } from 'kay'

const { items, row } = props<{
  items: string[]
  row: Snippet<[item: string, index: number]>
}>()
---
ul
  for item, i of items
    slot row(item, i)
```

The parent names the parameters after the block.

```kay
---
import List from '../components/list.kay'
---
List(items={['Milk', 'Eggs']})
  @row(item, i)
    li {i + 1}. {item}
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

A prop is always a value: a parent hands a signal's value, `Toggle(open={open()})`, and the prop follows it. A child that writes the parent's state types the prop `Bindable<boolean>`, read and assigned as a plain name. The parent binds it with `bind:open={open}`, and the child's assignment writes the parent's signal. Given a plain value instead, the assignment stays in the child. A child passes it on with `bind:open={open}`, through any number of levels, and a bind makes the parent an island.

Handed to a parameter typed `unknown` or `any`, as in `String(count)`, a signal is an error, `uncalled-signal`. Call it there.

Assigning works on a signal held in a `const`, an import, a `let`, an object's property or an array element: `box.count = 1`, `list[2]++`. Where kay cannot tell a signal from a plain value, the runtime does, writing a signal and assigning anything else, and `kay check` types the write by what the target holds, so `box.count = 'x'` is a type error for a `Signal<number>`.

A field of `this`, a write beside another write, a `let` written with an `await`, a compound write holding an `await`, and a `let` update whose value is read stay plain assignments, so write the signal there with `.set`.

## Derived and selected state

`linked(() => source)` is a signal an island can edit, that takes the source's value again whenever the source changes. It suits a prop you edit locally. The edit is dropped once a refresh or the next page brings a new value.

```kay
---
import { linked } from 'kay'

const { tiers } = props<{ tiers: string[] }>()

const local = linked(() => tiers)
---
button(onClick={() => local = [...local()].reverse()}) Reverse
ul
  for tier of local()
    li {tier}
```

`selection<Key>()` holds one selected key among many rows, or none. Read it as `selected()`, write it with `selected.set(id)`. `selected.is(id)` re-runs only the two rows a change touches, not every row.

```kay
---
import { selection } from 'kay'

const { rows } = props<{ rows: { id: number, name: string }[] }>()

const selected = selection<number>()
---
table
  for row of rows
    tr(class={{ active: selected.is(row.id) }} onClick={() => selected.set(row.id)})
      td {row.name}
```

`linked` and `selection` come from `kay`, so import them.

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

<ReadMore href="/llms/components">When `linked` drops an edit, `persist` islands, and shipping components in a package are in the full components reference.</ReadMore>
