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

Classes take Tailwind names, `:` and `/` included. Attributes sit in one pair of parentheses, separated by spaces: a quoted string, `{expression}`, or a bare name for a boolean attribute. `tag: child` nests one element on the same line:

```kay
li: a(href="/") Home
```

<Callout type="warning">

Every dynamic value sits in braces: `a(href={url})`, never `a(href=url)`. A static value is a quoted string.

</Callout>

## Text and expressions

Text follows the tag after one space. `{}` holds any expression, escaped for HTML. A `|` line is a text line, for a lone expression or for text on its own:

```kay
p Hello {user.name}, you have {messages.length} messages
| {summary}
```

`#[tag text]` puts an element inside text, and `\{` is a literal brace:

```kay
p Read #[a(href="/docs") the docs] first
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

`if value as name` binds the truthy value for the children. A `for` matches its rows by `item.id`, else by the item itself. When your items have neither, name a key: `for post of posts key={post.slug}`.

A `const` line names a value for the lines after it and their children, so a row computes it once however often it reads it:

```kay
for product of products
  const price = (product.cents / 100).toFixed(2)
  const { name, stock } = product
  li(title={price}) {name}: {price}
    if stock < 3
      span.badge Only {stock} left
```

In an island it follows what it reads, as a `memo` does, and redraws only what reads it. A name the template already sees, `let` and reassigning it are errors.

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

`bind:value` and `bind:checked` read and write a signal both ways. A lowercase `onclick` attaches nothing, and `kay check` reports it.

## Comments and slots

`// note` is a comment, and so is everything indented under it. `slot` is where a layout or wrapper component renders its children:

```kay
// not rendered
main
  slot
```

See [Components](/essentials/components) for named slots.

<ReadMore href="/llms/templates">The full template reference covers `class` merging, `ref`, `innerHTML` and `sanitizeHtml`, `await` and `try` blocks and transitions.</ReadMore>
