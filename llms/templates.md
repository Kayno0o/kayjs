# Template lines

Each line is one of the following; deeper indentation nests children under the line above.

| Line | Meaning |
| --- | --- |
| `tag.class#id(attributes) text` | An element. Each part is optional, but the line starts with a tag, `.` or `#`. |
| `.card` | A `div`: a line starting with `.` or `#` has an implied `div`. |
| `Card(title="x")` | A component: a capitalised tag, imported in the script. A prop, a server value or a loop item holding a component works as the tag too. |
| `\| text {expr}` | A text line, also the way to put a lone `{expr}` on its own line. Consecutive text lines are joined with a line break. |
| `// note` | A comment. Lines indented under it are commented out too. |
| `if cond` / `else if cond` / `else` | Conditional rendering. |
| `if user() as u` | Binds the truthy value to `u` for the children. |
| `for item of list` | A list, its rows matched across renders by `item.id`, else by the item itself; `key={item.slug}` names another key. A row keeps its key, so in an island a new copy of the item redraws what reads the rest of it, never what reads the key alone; in development, a part drawn again in place of the focused element warns in the console. `else` right after it renders when the list is empty. |
| `for item, i of list key={i}` | Rows matched by position. |
| `slot` | Where a layout or wrapper renders its children. |
| `@name` | Directly under a component: passes the indented block as its `name` prop. |
| `@name(a, b)` | The same, as a function of its parameters the component calls. |
| `head` | At the top level: its `title`, `meta`, `link`, `style`, `script` and `base` children go in the document head. |
| `await value` / `then name` / `catch error` | Renders the indented block under `await` until `value` settles; see [Streaming](rendering.md#streaming). |
| `try` / `catch error` | Renders the `catch` block instead when the `try` block throws; see [Error fallbacks](islands.md#error-fallbacks). |

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
    for todo, i of shown
      TodoItem(
        todo={todo}
        index={i}
        onToggle={id => selected.set(todos.find(t => t.id === id))}
      )
    else
      li.empty Nothing matches
  if selected as todo
    p Selected #[strong {todo.title}]
```

## Elements

- Classes: `.class` takes Tailwind names, `:`, `/`, `@` and `!` included: `div.md:flex.w-1/2.hover:underline`. A class holding `.` or `[` goes in `class="..."`.
- `class={...}` takes a string, an array or a `{ name: boolean }` object, and merges with the `.class` shorthand and with the `class` of a `{...spread}`. A component gets what merges as one string, so its `class?: string` prop holds; an expression alone reaches it as written. An element has one `class` attribute and one id.
- Attributes are separated by spaces, inside one pair of parentheses that may span lines: `a(href="/x" target="_blank")`. A value is a quoted string or `{expression}`. A name alone is a boolean attribute. A boolean bound to an attribute, `disabled={busy}`, writes it or leaves it out, but an `aria-*` one renders `"true"` or `"false"`, as ARIA states read: `aria-expanded={open}`; `null` and `undefined` leave any attribute out. `{...obj}` spreads.
- Events are camelCase handlers: `onClick={save}`, `onInput={e => name.set(e.currentTarget.value)}`. A lowercase `onclick` or `on:click` attaches nothing, and kay reports it. A handler is read when the event fires, so one a prop, a signal or a loop item holds stays current: `button(onClick={onPress})`.
- `bind:value={signal}` on `input`, `textarea` and `select`, and `bind:checked={signal}` on a checkbox, read and write a signal both ways. On `type="number"` and `type="range"` the signal holds a `number`, and keeps its last one while the input is empty.
- `ref={el => ...}` receives the DOM element.
- `innerHTML` renders its value as markup, unescaped, and so does an `iframe`'s `srcdoc`. Written out, `innerHTML="<b>hi</b>"` or `innerHTML={'<b>hi</b>'}`, it is the app's own; bound to a computed string, a template literal with values in it included, `kay check` and the editor report it unless the value is a `SafeHtml`, which `sanitizeHtml(markup)` and `trustHtml(markup)` from `kay` return. `sanitizeHtml` is for markup a user wrote: it keeps `p`, `br`, `hr`, `b`, `strong`, `i`, `em`, `u`, `s`, `del`, `ins`, `small`, `sub`, `sup`, `code`, `pre`, `blockquote`, `h1` to `h6`, `ul`, `ol`, `li` and `a`, balanced and without attributes, a link's `href` kept when it is an http(s), `mailto:` or site URL and given `rel="nofollow ugc"`; it drops other tags, keeping their text, and `script`, `style`, `iframe`, `svg` and comments whole, and gives the same result on the server and in an island. A second argument keeps more: `sanitizeHtml(html, { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'] } })` keeps images and tables, a URL, such as an `href`, a `src`, a `poster` or each one of a `srcset`, only when it is an http(s), `mailto:` or site URL; a tag that runs code, loads another document or takes input, such as `script`, `iframe` or `form`, an `on*`, `style` or `srcdoc` attribute, and attributes for a tag `tags` does not name are refused with an error. The options are read once per object, so declare them once outside the function. `trustHtml` vouches for markup the app made, such as its own Markdown renderer's, and changes nothing. An icon's markup is already a `SafeHtml`. Only an `innerHTML` or `srcdoc` written as an attribute is checked, not one a spread of props carries.
- Inline text follows the tag after one space. `\{` and `\#` are a literal brace and hash.
- `#[tag inline]` puts an element inside text: `p Read #[a(href="/docs") the docs] first`.
- `tag: child` nests one element on the same line: `li: a(href="/") Home`.

## Slots

```kay
---
import type { JSX } from 'kay'

const { title, actions } = props<{ title: string, actions?: JSX.Element }>()
---
article.card
  header
    h2 {title}
    | {actions}
  slot
```

A parent fills it like this: the `@actions` block becomes the `actions` prop and the other children go to `slot`.

```kay
---
import Card from './card.kay'
---
Card(title="Todos")
  @actions
    a(href="/new") New
  p Body text
```

A block taking parameters is passed as a function the component calls, once per row for instance, and its parameters take their types from the prop. No function reaches the browser, so a static component passing one to an island renders as an island itself, and a layout or a page with a `--- server` fence cannot pass one. A static component that only islands render is part of them, so it can.

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
    | {row(item, i)}
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
