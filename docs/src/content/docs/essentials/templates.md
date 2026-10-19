---
title: Templates
order: 1
description: The indented syntax that turns a component into HTML.
---

The template is what follows the fences of a `.kay` file. Each line is an element, a text line or a block, and indentation nests children under the line above.

```kay
---
const { todos } = props<{
  todos: { id: number, title: string, done: boolean }[]
}>()
---
section.todo-list
  h2 Todos
  ul
    for todo of todos
      li(class={{ done: todo.done }}) {todo.title}
    else
      li Nothing to do
```

## Elements

A line is `tag.class#id(attributes) text`, every part optional. A line starting with `.` or `#` is a `div`.

```kay
.card#intro
  a.link.md:underline(href="/about" target="_blank") About
  input(type="text" disabled)
```

A class takes Tailwind's names whole: `md:hover:underline`, `w-1/2`, `gap-1.5`, `w-[calc(100%-2rem)]`, `[&>svg]:size-4`, `bg-(--brand)/50` and `*:p-2`. Inside a `[...]` or a `-(...)` nothing ends the class, so a `#`, a `.` or a `,` there is part of the value, but the group closes before any space: write a space in a Tailwind value as `_`.

```kay
.grid.grid-cols-[1fr_2fr].gap-1.5.[&>svg]:size-4.bg-(--brand).2xl:grid-cols-3
```

A `class="..."` may run over several lines, and its words join with single spaces. `kay fmt` writes a long list that way:

```kay
div(
  class="
    flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3
    shadow-sm hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 md:px-6 md:py-4
  "
) Content
```

Attributes sit in one pair of parentheses, separated by spaces. A value is a quoted string or `{expression}`. A bare name is a boolean attribute.

`tag: child` nests one element on the same line.

```kay
li: a(href="/") Home
```

<Callout type="warning">

Every dynamic value sits in braces: `a(href={url})`, never `a(href=url)`. A static value is a quoted string.

</Callout>

## Text and expressions

Text follows the tag after one space. `{}` holds any expression, escaped for HTML. A `|` line is a text line of its own.

```kay
p Hello {user.name}, you have {messages.length} messages
| {summary}
```

`#[tag text]` puts an element inside text.

```kay
p Read #[a(href="/terms") the terms] first
```

## Conditions and lists

```kay
if user
  p Welcome back {user.name}
else if guest
  p Welcome
else
  a(href="/login") Sign in

ul
  for post of posts
    li {post.title}
  else
    li No posts yet
```

`match` renders the block of the first `when` that lists the value, else the `else` block.

```kay
match post.status
  when 'draft'
    p Draft
  when 'published', 'scheduled'
    p Live
  else
    p Archived
```

`if user as u` binds the truthy value to `u` for the children.

A `for` tracks its rows by `item.id`. When your items have no `id`, name a key: `for post of posts key={post.slug}`.

Rows of plain objects with no `id`, edited immutably, need no key. Avoid `key={index}` for them, because it matches rows by position.

<ReadMore href="/llms/templates">How rows are matched without a key, and when to give them an `id`.</ReadMore>

A `const` line names a value for the lines after it, computed once per row.

```kay
for product of products
  const price = (product.cents / 100).toFixed(2)
  const { name, stock } = product
  li(title={price}) {name}: {price}
    if stock < 3
      span.badge Only {stock} left
```

## Events and bindings

Handlers are camelCase attributes. A component with one becomes an [island](/essentials/islands).

```kay
---
const name = signal('')
const agree = signal(false)
---
input(bind:value={name} placeholder="Your name")
label
  input(type="checkbox" bind:checked={agree})
  |  I agree
button(onClick={() => name.set('')}) Clear
```

`bind:value` and `bind:checked` read and write a signal both ways.

## Markup in a spread

A spread sets `innerHTML` only from markup that `sanitizeHtml`, `trustHtml` or an icon import vouched for. It drops any other value, with a warning in development.

An icon keeps drawing, `svg({...Home})`, while a record's plain-string `innerHTML` is dropped.

A string built from a vouched one, such as `markup + '<b>'`, is plain again.

To render a string as markup, pass it through one of two helpers first. `sanitizeHtml(text)` is for markup a user wrote. `trustHtml(text)` is for markup the app made.

Call `trustHtml` where the markup is used, not once for a constant kept for hours.

<ReadMore href="/llms/templates">How the vouching travels from the server to the browser, what the server remembers, and what a dropped value logs.</ReadMore>

## Draw an icon or a component chosen by a value

An icon import is a record of props. An `svg` that spreads it draws it, whichever icon a lookup, a prop or a row holds. Type the lookup `Record<string, typeof Icon>`, using any one of the icons.

```kay
---
import Flame from '~icons/tabler/flame'
import Home from '~icons/tabler/home'

const ICONS: Record<string, typeof Flame> = { home: Home, flame: Flame }
const { key } = props<{ key: string }>()
---
svg.size-4({...ICONS[key]})
```

A component held in a value is drawn by its capitalised name as the tag. The value can be a prop, a `const` in the script, a server value or a loop item. Type it `Component<Props>` from `kay`. To pick one by a key, look it up in a record of components. A `match` does the same when each case passes different props.

## Functions and rendered values

A function that is not a handler is never written as an attribute, on the server or in the browser. A JSON value with a `t` string, shown as `{value}`, renders nothing, like any other object: only what a component, an element or an island rendered is markup.

## Fallback when something throws

A `try` block renders its `catch` block when what it renders throws. One broken widget then does not take the page down.

```kay
---
import Chart from './chart.kay'

const { points } = props<{ points: number[] }>()
---
try
  Chart(points={points})
catch error
  p.error The chart could not be drawn: {(error as Error).message}
```

It works on the server and in an island. On the server the error still goes to the log and `onError`, and the page answers 200. In an island, a block that throws while it hydrates or later renders `catch` in its place.

`catch` may leave out the error name. A `try` with no `catch` renders nothing when it throws.

<ReadMore href="/llms/islands#error-fallbacks">How an island reports the error to the server, and what the head keeps.</ReadMore>

## Comments and slots

`// note` is a comment. `slot` is where a layout or wrapper component renders its children.

```kay
// not rendered
main
  slot
```

See [Components](/essentials/components) for named slots.

<ReadMore href="/llms/templates">`match` narrowing, `if ... as` casts, `class` merging, `ref`, `innerHTML` and `sanitizeHtml`, `await` and `try` blocks, and transitions.</ReadMore>
