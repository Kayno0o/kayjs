# Template lines

## Common tasks

### Show a block only when a condition holds

`if`, `else if` and `else` render the first block whose condition is true:

```kay
---
const { stock } = props<{ stock: number }>()
---
if stock === 0
  p Sold out
else if stock < 5
  p Only {stock} left
else
  p In stock
```

### Render a list

`for item of list` renders its block once per item, and its `else` renders when the list is empty:

```kay
---
const { names } = props<{ names: string[] }>()
---
ul
  for name of names
    li {name}
  else
    li Nobody yet
```

### Pick a block by a value

`match` renders the block of the first `when` listing a value equal to it, else the `else` block:

```kay
---
const { status } = props<{ status: 'draft' | 'live' | 'archived' }>()
---
match status
  when 'draft'
    p Not published
  when 'live', 'archived'
    p Published
```

### Set classes from a condition

A `.class` shorthand and a `class={...}` object merge into one `class`:

```kay
---
const { done } = props<{ done: boolean }>()
---
li.todo(class={{ done }}) Buy milk
```

### Bind an input to a signal

`bind:value` reads and writes a signal both ways:

```kay
---
const name = signal('')
---
input(type="text" bind:value={name} placeholder="Your name")
p Hello {name()}
```

### Name a value used several times

`const` in a template names a value for the lines after it, computed once per render of its block:

```kay
---
const { products } = props<{ products: { id: number, cents: number }[] }>()
---
for product of products
  const price = (product.cents / 100).toFixed(2)
  li(title={price}) {price}
```

### Put an element inside text

`#[tag inline]` writes an element in the middle of a sentence, and `tag: child` nests one on the same line:

```kay
p Read #[a(href="/terms") the terms] first
li: a(href="/") Home
```

### Let a parent fill a part of a component

A `slot name` renders the `name` block the parent passes with `@name`, and a plain `slot` its other children:

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

```kay
---
import Card from './card.kay'
---
Card(title="Todos")
  @actions
    a(href="/new") New
  p Body text
```

### Render markup a user wrote

`sanitizeHtml` keeps basic formatting and links and drops the rest, so `innerHTML` accepts its result:

```kay
---
import { sanitizeHtml } from 'kay'

const { comment } = props<{ comment: string }>()
---
div(innerHTML={sanitizeHtml(comment)})
```

### Write HTML and convert it

HTML from Tailwind UI, Flowbite, a designer or an LLM becomes a template with `kay fmt --from-html page.html` (or stdin), which prints it formatted; paste the result in a `.kay` file and keep the dynamic parts to write by hand:

```sh
echo '<div class="rounded-md px-3.5"><a href="/terms">Terms</a></div>' | kay fmt --from-html
```

```kay
.rounded-md(class="px-3.5")
  a(href="/terms") Terms
```

An agent may write the markup as HTML and convert it rather than learn the indentation rules; see [kay fmt](check-and-tools.md).

## Reference

### Template lines

Each line is one of the following; deeper indentation nests children under the line above.

| Line | Meaning |
| --- | --- |
| `tag.class#id(attributes) text` | An element. Each part is optional, but the line starts with a tag, `.` or `#`. |
| `.card` | A `div`: a line starting with `.` or `#` has an implied `div`. |
| `Card(title="x")` | A component: a capitalised tag, imported in the script. A prop, a server value or a loop item holding a component works as the tag too. |
| `\| text {expr}` | A text line, also the way to put a lone `{expr}` on its own line. Consecutive text lines are joined with a line break. |
| `// note` | A comment. Lines indented under it are commented out too. |
| `if cond` / `else if cond` / `else` | Conditional rendering. |
| `if user() as u` | Binds the truthy value to `u` for the children. A last `as` outside brackets followed by a lowercase name aliases the whole condition, whatever operators it holds: `if a && b as u` binds `a && b`. A capitalized name or any other type stays a cast: `as Row`, `as string`, `as const`, `as Box<T>`. |
| `match value` / `when a, b` / `else` | Renders the block of the first `when` listing a value equal (`===`) to `value`, else the `else` block, else nothing. Only `when` lines and a last `else` sit under `match`. `value` is read once, and `kay check` narrows it in each block as a TypeScript `switch` does: `match shape.kind` types `shape` per `when`, and a value its type cannot hold is an error. A `match` with no `else` over a finite union that leaves members out is the `incomplete-match` lint, naming them. |
| `for item of list` | A list, its rows matched across renders by `item.id`, else by the item itself; `key={item.slug}` names another key. A row keeps its key (an id or the item), so in an island a new copy of the item redraws what reads the rest of it, never what reads the key alone; in development, a part drawn again in place of the focused element warns in the console. `else` right after it renders when the list is empty. Rows of plain objects with no `id`, edited immutably (`rows.set(rows().filter(...))`, `{ ...row, text }`), keep their nodes, fields and focus: a copy no key matches takes the unmatched row left in its place between the rows around it, so an edit, a removal or an insertion needs no id of your own; a removal and an edit in the same gap pair the first unmatched row with the copy, and a list of fresh objects reuses the rows by position, so give such rows an `id` when each must start afresh. |
| `for item, i of list key={i}` | Rows matched by position: leave `key={i}` out for rows of objects, which `for row of rows()` already follows through edits, removals and insertions. |
| `slot` | Where a layout or wrapper renders its children; the lines under it render when it gets none. |
| `slot name` | Where a component renders its `name` block prop, the lines under it when the prop is not given. |
| `slot name(a, b)` | The same for a block taking parameters, called with these arguments. |
| `@name` | Directly under a component: passes the indented block as its `name` prop. |
| `@name(a, b)` | The same, as a function of its parameters the component calls. |
| `head` | At the top level: its `title`, `meta`, `link`, `style`, `script` and `base` children go in the document head, and `html` sets the attributes of `<html>`. |
| `await value` / `then name` / `catch error` | Renders the indented block under `await` until `value` settles, or `then` again with each part of an async iterable; see [Streaming](rendering.md#streaming). |
| `try` / `catch error` | Renders the `catch` block instead when the `try` block throws; see [Error fallbacks](islands.md#error-fallbacks). |
| `error title` / `error` | Inside `form(action={add})`: `p.error` with the message a refused post gave `title`, or the form's own, which the field or the form is described by; nothing otherwise. See [Actions](actions.md). |
| `const name = value` | Names a value for the lines after it at its indentation and their children, computed once per render of its block; in an island it follows what it reads as a memo does, redrawing only what reads it. `const { a, b } = value` destructures. A name the template already sees, `let` and reassignment are errors. |

```kay
---
import type { Todo } from './todo'
import TodoItem from './todo-item.kay'

const { todos } = props<{ todos: Todo[] }>()
const filter = signal('')
const selected = signal<Todo>()
const shown = memo(() => todos.filter(todo => todo.title.includes(filter())))
---
section.todo-list
  input(type="search" bind:value={filter} placeholder="Filter")
  ul
    for todo, i of shown()
      TodoItem(
        todo={todo}
        index={i}
        onToggle={id => selected.set(todos.find(t => t.id === id))}
      )
    else
      li.empty Nothing matches
  if selected() as todo
    p Selected #[strong {todo.title}]
```

A value a row reads several times is named once in it:

```kay
---
import type { Product } from './product'

const { products } = props<{ products: Product[] }>()
---
for product of products
  const price = (product.cents / 100).toFixed(2)
  const low = product.stock < product.threshold
  li.product(class={{ low }})
    span.price(title={price}) {price}
    if low
      span.badge {product.stock}
```

### Elements

- Classes: `.class` takes Tailwind names, `:`, `/`, `@` and `!` included: `div.md:flex.w-1/2.hover:underline`.
- A class holding `.` or `[` goes in `class="..."`.
- `class={...}` takes a string, an array or a `{ name: boolean }` object, and merges with the `.class` shorthand and with the `class` of a `{...spread}`.
- A component gets what merges as one string, so its `class?: string` prop holds; an expression alone reaches it as written.
- An element has one `class` attribute and one id.
- Attributes are separated by spaces, inside one pair of parentheses that may span lines: `a(href="/x" target="_blank")`.
- A value is a quoted string or `{expression}`.
- A name alone is a boolean attribute.
- A boolean bound to an attribute, `disabled={busy}`, writes it or leaves it out, but an `aria-*` one renders `"true"` or `"false"`, as ARIA states read: `aria-expanded={open}`.
- `null` and `undefined` leave any attribute out.
- `{...obj}` spreads.
- On an element, a spread sets attributes only, as it often carries data such as a record's fields: a key that is no attribute name, a handler given as text in any case (`ONCLICK: '...'`) and `srcdoc` are left out, on the server and in an island alike.
- A name the browser refuses to set, such as `@click`, is written by the server only.
- A handler given as a function still attaches.
- A spread sets `innerHTML` only when its value is a `SafeHtml`, which `sanitizeHtml`, `trustHtml` and an icon import return, and drops any other value, with a warning in development: `svg({...icon})` draws, `div({...record})` ignores a `record.innerHTML` that is a plain string.
- A tag held in a value renders only when it is an element name, `img src=x onerror=...` throwing, and takes its props as a spread does.
- Events are camelCase handlers: `onClick={save}`, `onInput={e => name.set(e.currentTarget.value)}`.
- A lowercase `onclick` or `on:click` attaches nothing, and kay reports it.
- A handler is read when the event fires, so one a prop, a signal or a loop item holds stays current: `button(onClick={onPress})`.
- `bind:value={signal}` on `input`, `textarea` and `select`, and `bind:checked={signal}` on a checkbox, read and write a signal both ways.
- On `type="number"` and `type="range"` the signal holds a `number`, and keeps its last one while the input is empty.
- `ref={el => ...}` receives the DOM element.
- `innerHTML` renders its value as markup, unescaped, and so does an `iframe`'s `srcdoc`.
- Written out, `innerHTML="<b>hi</b>"` or `innerHTML={'<b>hi</b>'}`, it is the app's own.
- Bound to a computed string, a template literal with values in it included, `kay check` and the editor report it unless the value is a `SafeHtml`, which `sanitizeHtml(markup)` and `trustHtml(markup)` from `kay` return.
- `sanitizeHtml` is for markup a user wrote: it keeps `p`, `br`, `hr`, `b`, `strong`, `i`, `em`, `u`, `s`, `del`, `ins`, `small`, `sub`, `sup`, `code`, `pre`, `blockquote`, `h1` to `h6`, `ul`, `ol`, `li` and `a`, balanced and without attributes, a link's `href` kept when it is an http(s), `mailto:` or site URL and given `rel="nofollow ugc"`.
- It drops other tags, keeping their text, and `script`, `style`, `iframe`, `svg` and comments whole, and gives the same result on the server and in an island.
- A second argument keeps more: `sanitizeHtml(html, { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'] } })` keeps images and tables, a URL, such as an `href`, a `src`, a `poster` or each one of a `srcset`, only when it is an http(s), `mailto:` or site URL.
- A tag that runs code, loads another document or takes input, such as `script`, `iframe` or `form`, an `on*`, `style` or `srcdoc` attribute, and attributes for a tag `tags` does not name are refused with an error.
- The options are read once per object, so declare them once outside the function, typed as `SanitizeOptions` from `kay`.
- `trustHtml` vouches for markup the app made, such as its own Markdown renderer's, and changes nothing.
- An icon's markup is already a `SafeHtml`.
- The mark is on the string's value at run time, kept by the process for every user, and only the markup most recently vouched for: call `trustHtml` where the markup is used rather than once for a constant kept for hours, as a spread drops what the process forgot, and in production logs that once.
- A derived string (`safe + '<b>'`, `.slice()`) is unmarked. The mark travels from the server to the browser in island props, action results and event streams, and from nowhere else: a request's input, a cookie, `localStorage` and a `fetch` of your own JSON bring plain strings.
- Only one written as an attribute is checked at build time: a spread never sets `srcdoc`.
- A plain string meant as markup goes through `sanitizeHtml(text)`, for markup a user wrote, or `trustHtml(text)`, for markup the app made, before it reaches `innerHTML`, as an attribute or in a spread.
- Inside `svg` or `math`, where HTML reads a `style` or `script` as markup rather than text, one holds static text or a string literal only, which the compiler reports otherwise.
- A line starting with `{expression}` is text, as `| {expression}` is.
- Inline text follows the tag after one space.
- `\{` and `\#` are a literal brace and hash.
- `#[tag inline]` puts an element inside text: `p Read #[a(href="/terms") the terms] first`.
- `tag: child` nests one element on the same line: `li: a(href="/") Home`.

### Slots

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
    p Nothing here yet
```

A parent fills it like this: the `@actions` block becomes the `actions` prop, which `slot actions` renders, and the other children go to `slot`.

The lines under a `slot` render when it gets nothing to show.

`kay check` reports a `slot name` naming no prop, as a call with the wrong arguments.

```kay
---
import Card from './card.kay'
---
Card(title="Todos")
  @actions
    a(href="/new") New
  p Body text
```

A block taking parameters is passed as a function the component calls, once per row for instance, and its parameters take their types from the prop.

No function reaches the browser, so a static component passing one to an island renders as an island itself, and a layout or a page with a `--- server` fence cannot pass one.

A static component that only islands render is part of them, so it can.

```kay
--- <T extends { id: number }>
import type { JSX } from 'kay'

const { items, row } = props<{
  items: T[]
  row: (item: T, index: number) => JSX.Element
}>()
---
ul
  for item, i of items
    slot row(item, i)
```

```kay
---
import type { Todo } from './todo'
import List from './list.kay'

const { todos } = props<{ todos: Todo[] }>()
---
List(items={todos})
  @row(todo, i)
    li {i + 1}. {todo.title}
```
