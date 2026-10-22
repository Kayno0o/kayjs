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

### Draw an icon or a component chosen by a value

An icon import is a record of props, so an `svg` spreading it draws whichever one a lookup, a prop or a row holds; type the lookup `Record<string, typeof Icon>` from any one of the icons:

```kay
---
import type { Component } from 'kay'
import Chip from '../chip.kay'
import Flame from '~icons/tabler/flame'
import Home from '~icons/tabler/home'

const ICONS: Record<string, typeof Flame> = { home: Home, flame: Flame }
const VIEWS: Record<string, Component<{ title: string }>> = { chip: Chip }
const { key } = props<{ key: string }>()
const View = VIEWS.chip!
---
svg.size-4({...ICONS[key]})
View(title="Picked")
```

A component held in a value has a form too: a capitalised name as the tag, whether a prop, a script `const`, a server value or a loop item (`for Card of cards`), typed `Component<Props>` from `kay`. Choosing it by a key is a lookup into a record of components, as above; `match` does the same when each case passes different props.

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

### Repeat a block within one file

A `snippet` names markup for the lines after it, and `{name(args)}` renders it, where a component would need a file of its own:

```kay
snippet feature(title: string, text: string)
  article
    h3 {title}
    p {text}
.grid
  {feature('Fast', 'Built on Bun')}
  {feature('Small', 'Under 10 KB')}
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
import type { Snippet } from 'kay'

const { title, actions } = props<{ title: string, actions?: Snippet }>()
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

### Write prose as Markdown

A `markdown` line with indented lines under it renders them as Markdown, at build time, so no Markdown parser reaches the browser or runs per request. `{expr}` holes keep their meaning and stay text, whatever Markdown or HTML characters they hold, and a link is checked and given its `base` and locale as a template link is:

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

- It stands for the template lines Markdown renders to (`h1`, `p` with `#[a ...]` inline, `ul`, `table`, `pre`), so it works in a page, a layout, an island and under `if` or `for`.
- Components are written as in a collection's Markdown (`<Callout type="warn">`, JSON props) and must be imported in the script.
- Raw HTML in it is the template's own: `<span class="x">` is an element, and its `class` reaches the page's inlined rules.
- `\{` is a literal brace. A hole sits anywhere in the text, in a link's URL, or in a code block.
- A problem inside it is reported on the `markdown` line, except a hole's own, which is reported where it is written. `kay fmt` leaves its lines as written, trailing spaces included.

### Write HTML and convert it

HTML from Tailwind UI, Flowbite, a designer or an LLM becomes a template with `kay fmt --from-html page.html` (or stdin), which prints it formatted; paste the result in a `.kay` file and keep the dynamic parts to write by hand:

```sh
echo '<div class="rounded-md md:w-[200px]"><a href="/terms">Terms</a></div>' | kay fmt --from-html
```

```kay
.rounded-md.md:w-[200px]
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
| `for item of list` | A list, its rows matched across renders by `item.id`, else by the item itself; `key={item.slug}` names another key. A row keeps its key (an id or the item), so in an island a new copy of the item redraws what reads the rest of it, never what reads the key alone; in development, a part drawn again in place of the focused element warns in the console. A row that changes place is moved in place where the browser has `Element.moveBefore` (Chrome 133, Firefox 144), so an iframe in it stays loaded, a video keeps playing and the focus stays in it. `else` right after it renders when the list is empty. Rows of plain objects with no `id`, edited immutably (`rows.set(rows().filter(...))`, `{ ...row, text }`), keep their nodes, fields and focus: a copy no key matches takes the unmatched row left in its place between the rows around it, so an edit, a removal or an insertion needs no id of your own; a removal and an edit in the same gap pair the first unmatched row with the copy, and a list of fresh objects reuses the rows by position, so give such rows an `id` when each must start afresh. |
| `for item, i of list key={i}` | Rows matched by position: leave `key={i}` out for rows of objects, which `for row of rows()` already follows through edits, removals and insertions. |
| `slot` | Where a layout or wrapper renders its children; the lines under it render when it gets none. |
| `slot name` | Where a component renders its `name` block prop, the lines under it when the prop is not given. |
| `slot name(a, b)` | The same for a block taking parameters, called with these arguments. |
| `@name` | Directly under a component: passes the indented block as its `name` prop. |
| `@name(a, b)` | The same, as a function of its parameters the component calls. |
| `head` | At the top level: its `title`, `meta`, `link`, `style`, `script` and `base` children go in the document head, and `html` sets the attributes of `<html>`. |
| `await value` / `then name` / `catch error` | Renders the indented block under `await` until `value` settles, or `then` again with each part of an async iterable; see [Streaming](rendering.md#streaming). |
| `try` / `catch error` | Renders the `catch` block instead when the `try` block throws, or when an `await` inside with no `catch` of its own rejects; see [Error fallbacks](islands-state-to-ids.md#error-fallbacks). |
| `error title` / `error` | Inside `form(action={add})`: `p.error` with the message a refused post gave `title`, or the form's own, which the field or the form is described by; nothing otherwise. See [Actions](actions.md). |
| `pending` | Inside `form(action={add})`: its indented block shows only while that form posts, until the page a redirect leads to is in, hidden in the server render, after the answer, after a refused post and with JavaScript off, with no script of its own. The block is a `slot` laid out as its contents, unhidden by the runtime, which announces its text outside the form; in an island it shows as well while a call of the form's action is in flight and while its `onSubmit` awaits a promise. Outside a form posting to an action it is an error. See [Actions](actions.md#show-that-a-form-is-posting). |
| `const name = value` | Names a value for the lines after it at its indentation and their children, computed once per render of its block; in an island it follows what it reads as a memo does, redrawing only what reads it. `const { a, b } = value` destructures. A name the template already sees, `let` and reassignment are errors. |
| `snippet name(a, b)` | Declares a function returning the indented lines, called `{name(x, y)}` below it; see [Snippets](templates-elements-slots-snippets.md#snippets). |

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

Elements, slots and snippets are in [Template lines: elements, slots and snippets](templates-elements-slots-snippets.md).
