# Template lines: elements, slots and snippets

## Common tasks

- Write a template line, bind a value or branch with `if`, `for` and `await`: the tasks of [Template lines](templates.md#common-tasks).

## Reference

### Elements

- Classes: `.class` takes Tailwind names, `:`, `/`, `@`, `!` and `*` included: `div.md:flex.w-1/2.hover:underline.*:p-2`.
- A `.` between two digits stays in the class, `div.gap-1.5`, unless letters follow the digits: `div.col-2.2xl:flex` has `col-2` and `2xl:flex`.
- A balanced `[...]` stays in the class, `div.w-[calc(100%-2rem)].[&>svg]:size-4`, and so does a `(...)` right after a `-`, Tailwind's variable form, `div.bg-(--brand)/50`.
- Nothing inside such a group ends the class, a `#`, `.`, `(` or `,` included, but it must close before any space: write a space in a Tailwind value as `_`, or `kay check` reports the unclosed group. A quote in a group hides a bracket, `.content-['[']`, unless a letter or digit comes right before it: that is an apostrophe.
- A static `class="..."` may run over several lines when its opening quote ends a line: its words join with single spaces, and merge with the shorthand as one string.
- `kay fmt` moves an element's shorthand into a `class` attribute inside the parentheses when its classes make the line, with its tag, id and attributes, longer than 120 characters: the attributes go one to a line, and the class value is filled into lines when it is too long for one. An element is left as written when its other attributes make the line long (more than 80 characters beside its classes), with a `class={...}`, a spread before its `class`, attributes already over lines or inside a text.
- `class={...}` takes a string, an array or a `{ name: boolean }` object, and merges with the `.class` shorthand and with the `class` of a `{...spread}`, and with Tailwind a later class of a merge (a shorthand beside a `class`, an expression, a spread, a component's `class` prop) wins over an earlier one setting the same property ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).
- A component gets what merges as one string, so its `class?: string` prop holds; an expression alone reaches it as written.
- An element has one `class` attribute and one id.
- Attributes are separated by spaces, inside one pair of parentheses that may span lines: `a(href="/x" target="_blank")`.
- A value is a quoted string or `{expression}`.
- A name alone is a boolean attribute.
- `{title}` alone in the list is `title={title}`, on elements and components, and keeps its place among spreads. Only a bare name fits: `{post.title}`, `{x()}`, `{aria-label}` and `{class}` (a reserved word) are errors naming the written-out form. `kay fmt` keeps it as written.
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
- `bind:name={signal}` on a component binds a prop typed `Bindable<T>` ([Components](components.md#bind-a-prop-to-the-parents-signal)).
- `bind:value={signal}` on `input`, `textarea` and `select`, and `bind:checked={signal}` on a checkbox, read and write a signal both ways.
- On `type="number"` and `type="range"` the signal holds a `number`, and keeps its last one while the input is empty.
- `bind:group={signal}` on `input(type="radio")` holds the checked one's `value`, and on `input(type="checkbox")` an array of the checked values; write the `type` out.
- `bind:open={signal}` on `details` follows its toggling, on `dialog` its closing: `true` opens it non-modal, `false` closes it, a modal one too.
- `bind:files={signal}` on `input(type="file")` holds the picked `FileList`, `null` clears it.
- `bind:` next to a spread sets the value after the spread's; write a `type` or `value` on the element, as one only a spread brings is not seen.
- `style:color={value}` sets one property of the `style`, `style:--gap={gap()}` a custom one, left out while the value is `null`, `undefined` or `false`; on an element only.
- `onSubmit|preventDefault={save}` calls the event method first, `|stopPropagation` likewise, and the two chain; on an element only, so a form posts natively without JavaScript.
- `ref={el => ...}` receives the DOM element, and may return a cleanup.
- A function prop that is no handler, `class` or `style` (a slot or a formatter passed to a plain element) writes no attribute on the server either, as in the browser. Only what a component, an element or an island rendered counts as markup in `{}`: an object with a `t` string from JSON, such as a database column, renders nothing, like any other object.
- `innerHTML` renders its value as markup, unescaped, and so does an `iframe`'s `srcdoc`.
- Written out, `innerHTML="<b>hi</b>"` or `innerHTML={'<b>hi</b>'}`, it is the app's own, and so is a project file imported as text, `import waves from '../public/waves.svg' with { type: 'text' }` then `innerHTML={waves}`; a package's file, a derived string and a name a `for`, `snippet`, alias or `const` of the template rebinds are not.
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
import type { Snippet } from 'kay'

const { title, actions } = props<{ title: string, actions?: Snippet }>()
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

A prop taking markup is typed `Snippet` from `kay`: `Snippet` for the children and a block with no parameters, `Snippet<[Item, number]>` for markup the component calls with values, once per row for instance. `@name(a, b)`, a local `snippet` passed as `name={feature}` and `slot name(a, b)` all use it, a fill with other parameters is a `kay check` error, and `slot name` on a prop that is no `Snippet` is reported at the name.

No function reaches the browser, so a static component passing one to an island renders as an island itself, and a layout or a page with a `--- server` fence cannot pass one.

A static component that only islands render is part of them, so it can.

```kay
--- <T extends { id: number }>
import type { Snippet } from 'kay'

const { items, row } = props<{
  items: T[]
  row: Snippet<[item: T, index: number]>
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

### Snippets

- `snippet name(parameters)` and the lines under it declare a function returning what they render, as a `@row(item)` block does; the parameters are a function's, types, destructuring, defaults and rest included, and the brackets may be left out for none.
- `{name(args)}` renders it anywhere below, as a text line or in the text of an element, and `kay check` types the call as any call.
- It reads the signals, script consts, template `const`s and loop variables around it, so it needs no parameter for them.
- A signal read in the snippet updates there in place; one read in an argument, `{feature(title())}`, draws that call again.
- A loop row passed as the argument, `{show(row)}` under `for row of rows()`, is such a read when a new copy of the row replaces the old one, as a game snapshot each tick does: the call is drawn again and its nodes are new. A component, `Show(row={row})`, writes only the attributes that changed to the same nodes, so make per-row markup a component when it should keep its nodes, a CSS transition included.
- It is scoped as a template `const` is: the lines after it at its indentation and their children see it, its own lines included, so it can call itself for a tree, and a later snippet can call an earlier one; an `@name` block after it among a component's children does not see it. Above its declaration or outside its block the name is unknown, and `kay check` reports it.
- A name another snippet, an import, a script const, a prop or a loop variable already holds is reported at the snippet, and assigning one is refused.
- It can hold components, a bare `slot` of the component declaring it, `if`, `for`, `await`, `match` and other snippets, and is a plain function, so `List(row={feature})` passes it where a prop takes a function, which the component renders with `slot row(item, i)`.
- An `error` line in a snippet reads the form around the snippet's declaration, so declare a snippet repeating a form field inside that form.
- A static component passing one to an island renders as an island itself, as it does for a `@row(item)` block.
- Markup used by several files is a component; a snippet is for one file.
