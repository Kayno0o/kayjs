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

## Comments and slots

`// note` is a comment. `slot` is where a layout or wrapper component renders its children.

```kay
// not rendered
main
  slot
```

See [Components](/essentials/components) for named slots.

<ReadMore href="/llms/templates">`match` narrowing, `if ... as` casts, `class` merging, `ref`, `innerHTML` and `sanitizeHtml`, `await` and `try` blocks, and transitions.</ReadMore>
