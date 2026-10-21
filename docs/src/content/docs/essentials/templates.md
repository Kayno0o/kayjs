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

When a variable has the name of the attribute, write the name alone in braces: `{title}` is `title={title}`. It works on elements and on components, and it keeps its place among spreads, so a later one overrides it.

```kay
---
const { title, href } = props<{ title: string, href: string }>()
---
a({title} {href}) Read more
```

Only a bare name fits the shorthand. A member such as `post.title`, a call, a name with a dash and a reserved word such as `class` are reported, with the written-out form to use.

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

## Prose as Markdown

A page with a lot of prose, such as an about page or legal text, is easier to write as Markdown than as one text line per paragraph. Put the lines under a `markdown` line:

```kay
---
import Callout from '../components/callout.kay'

const { name } = props<{ name: string }>()
---
article
  markdown
    # Hello {name}

    Read the [terms](/terms) or **ask**.

    <Callout type="warn">
    Mind the gap.
    </Callout>
```

kay turns the Markdown into the same elements you would have written, while it builds. Nothing parses Markdown in the browser or when a request comes in, and the block works the same in a page, a layout and an island.

`{expr}` works as everywhere else. Its value is text, so Markdown or HTML characters in it are shown, not interpreted. Write `\{` for a literal brace.

A link is a template link: `kay check` tests it, and it gets the `base` and the locale of the page. A component is written like in a collection's Markdown, with JSON props, and imported in the script. A problem is reported on the `markdown` line, except a problem inside a `{expr}`, which is reported where you wrote it. `kay fmt` leaves the lines as they are.

## Links to other sites

A link to another site opens in a new tab, and a link inside yours stays in the same one. kay adds `target="_blank" rel="noopener"` to an `a` whose `href` is on another origin, in templates, in islands, in a `markdown` block, in `markdownHtml` and in the Markdown of a collection's entries or `renderMarkdown`. The server compares with the origin you set as `site`, an island with the page's own origin. Without a `site`, every absolute `http` or `https` link counts as another site.

A path, a `#hash`, `mailto:` and `tel:` are left alone, and so is a link that writes its own `target`, even an empty one. A link writing its own `rel` keeps it, and only gets the `target`. To keep every link in the same tab, set `links: { outside: 'same-tab' }` in `kay.config.ts`.

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

A row that moves keeps its focus, its playing video and its loaded iframe in a browser that has `Element.moveBefore`.

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

## Reuse a block in one file

A `snippet` names a block of markup for the file that declares it. Declare it with parameters, then call it in braces like a function.

```kay
snippet feature(title: string, text: string)
  article
    h3 {title}
    p {text}
.grid
  {feature('Fast', 'Built on Bun')}
  {feature('Small', 'Under 10 KB')}
```

The parameters are TypeScript parameters, so types, destructuring and defaults all work. `kay check` types each call like any other call.

A snippet reads the signals, constants and loop variables around it, so it needs no parameter for them. It can also call itself, which suits a tree.

Like a `const`, a snippet is seen by the lines below it. Use it above its declaration or outside the block that declares it, and `kay check` reports an unknown name.

To hand a snippet to a component, pass it as a function prop. The component renders it with `slot row(item, i)`.

```kay
---
import List from '../components/list.kay'
---
snippet item(name: string, i: number)
  li {i + 1}. {name}
List(items={['Milk', 'Eggs']} row={item})
```

A snippet is for markup used in one file. Markup used by several files is a component.

<ReadMore href="/llms/templates#snippets">How a snippet is scoped, what a name clash reports, and what an argument that reads a signal redraws.</ReadMore>

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

On a component, `bind:open={open}` binds a prop typed `Bindable<boolean>` to a signal: see [Components](/essentials/components).

### Open a popover or a dialog with no script

A button can open a popover or a dialog on its own, so the component stays static and ships no JavaScript. `popovertarget` toggles a popover, and `commandfor` with `command` also opens a dialog.

```kay
button(popovertarget="menu") Menu
ul#menu(popover)
  li: a(href="/account") Account

button(commandfor="settings" command="show-modal") Settings
dialog#settings
  button(commandfor="settings" command="close") Close
```

`command` is `show-modal`, `close`, `request-close`, `show-popover`, `hide-popover` or `toggle-popover`, or a name starting with two hyphens, such as `--rotate-left`, which the target hears as a `command` event. `kay check` reports any other value.

`popovertarget` works in Chrome and Edge 114, Firefox 125 and Safari 17. `commandfor` and `command` need Chrome and Edge 135, Firefox 144 and Safari 26.2, newer than kay's [browser floor](/essentials/islands#browser-only-code), so keep `popovertarget` or an `onClick` where older browsers matter.

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
