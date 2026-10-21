# Components

## Common tasks

### Write a component taking props

Props are declared once, with the `props<T>()` macro, destructured with their defaults:

```kay
---
import type { Todo } from './todo'

const { todo, size = 'md', onToggle } = props<{
  todo: Todo
  size?: 'sm' | 'md'
  onToggle?: (id: number) => void
}>()
---
li(class={size})
  input(
    type="checkbox"
    checked={todo.done}
    onChange={() => onToggle?.(todo.id)}
  )
  span {todo.title}
```

### Let a caller style the parts of a component

`part="head"` on an element, or a component call, lets the caller style it by name: `Card(class={{ root: 'mt-4', head: 'p-6' }})`, or a string for the root. The component declares nothing, see [Style a part of a component](styles-and-assets.md#style-a-part-of-a-component).

### Give a component variants

`const card = recipe({ parts, variants, defaults })` from `kay` holds the classes by part and variant, and the variants become typed props with no declaration: see [Give a component variants](styles-and-assets.md#give-a-component-variants).

### Restyle any component from the app

`src/ui.ts` with `defineUi` sets the parts and variants of any component, a library's included, without touching it: see [Restyle a component from src/ui.ts](styles-and-assets.md#restyle-a-component-from-srcuits).

### Keep state that changes

A signal holds it, read by calling it and written by assigning it, in the template as in the script; a memo derives a value from it:

```kay
---
const count = signal(0)
const double = memo(() => count() * 2)
---
button(onClick={() => count++}) Clicked {count()} times, {double()} doubled
```

### Bind a prop to the parent's signal

A child that writes the parent's state types the prop `Bindable<T>` from `kay`, and reads and assigns it as a plain name, with no call. The parent binds it to a signal with `bind:`, and an assignment in the child writes that signal; with a plain value, `Toggle(open={false})`, the assignment stays in the child until the parent's value changes:

```kay
---
import type { Bindable } from 'kay'

const { open } = props<{ open: Bindable<boolean> }>()
---
button(onClick={() => open = !open}) {open ? 'Hide' : 'Show'}
```

```kay
---
import Toggle from './toggle.kay'

const open = signal(false)
---
Toggle(bind:open={open})
if open()
  p Details
```

### Run code when a value changes

`effect` runs once the render is done, in the browser, and again whenever a signal it read changes:

```kay
---
const query = signal('')

effect(() => {
  localStorage.setItem('query', query())
})
---
input(bind:value={query} aria-label="Search")
```

### React to a change, or to typing once it pauses

`watch` from `kay` runs on each change of what it watches, not on its first read, handed the value before; `debounced` gives a value once it has stopped changing for a while:

```kay
---
import { debounced, watch } from 'kay'

const typed = signal('')
const found = signal<string[]>([])

watch(debounced(typed, '300ms'), async (query) => {
  // Registered before the await: a slower answer to an older query is dropped.
  let stale = false

  onCleanup(() => stale = true)

  const people = query === '' ? [] : await (await fetch(`/api/people?q=${encodeURIComponent(query)}`)).json()

  if (!stale)
    found = people
})
---
input(bind:value={typed} aria-label="Search people")
ul
  for name of found()
    li {name}
```

### Run code on a timer or a window event

`every` and `listen` from `kay` run while the island lives, never on the server:

```kay
---
import { every, listen } from 'kay'

const seconds = signal(0)
const key = signal('')

every('1s', () => seconds++)
listen(window, 'keydown', event => key = event.key)
---
p {seconds()}s on the page, last key {key()}
```

### Read data on the server

A page or a layout reads it in a `--- server` fence, which never reaches the browser, and hands it to the template by name:

```kay
--- server
const greeting = 'Hello'
--- script
const count = signal(0)
---
p {greeting}
button(onClick={() => count++}) Clicked {count()} times
```

### Render every component of a folder

`import.meta.glob` imports every file a pattern matches, as Vite's does:

```kay
---
import type { Component } from 'kay'

const cards = import.meta.glob<Component>('../cards/*.kay', { eager: true, import: 'default' })
---
for Card of Object.values(cards)
  Card
```

### Make a component generic

Type parameters on the script fence line, inferred at each use from its props:

```kay
--- <T extends { id: number }>
const { items, show } = props<{ items: T[], show: (item: T) => string }>()
---
ul
  for item of items
    li {show(item)}
```

## Reference

### File layout

- Up to two fences come first, in either order, then the template. Both are optional.
- `---` holds the component script: imports, props, signals, functions. It runs wherever the component renders.
- `--- server` exists on pages and layouts only. It runs on the server for each request and never reaches the browser.
- `--- client` in place of `---` makes the component render in the browser only, generic ones written `--- client <T>`; see [Islands](islands.md#islands).
- A fence ends on a `---` line, or on a `--- server`, `--- client` or `--- script` line, which opens the next fence.
- `--- script` is `---` spelled out, for a script that follows another fence.
- Imports, `type` and `interface` declarations are module level, except a type taking the `typeof` a name the script declares, which stays inside the component.
- Both fences may import the same name; the server fence's copy is dropped.
- A fence holds TypeScript only: markup goes in the template, and JSX in a fence is reported.

### Imports kay adds

- Every value `kay` exports (`signal`, `persisted`, `navigate`, `s`, `action`, `localPath` and the rest) needs no import in a script or a server fence: the compiler imports it from `kay` when the fence reads it without declaring or importing a name of its own. A name only a template expression reads, such as `route` in a link, is imported too. `route`, `localPath`, `withBase`, `s`, `durationMs` and `refusalMessage` read nothing reactive, so a script using only those keeps the component static. A type is still imported, `import type { Signal } from 'kay'`.
- The translation `t` of `kay/i18n` needs no import either, in a template or any fence. Everything from another entry (`defineConfig` from `kay/server`, `cached` from `kay/cache`, `T` from `kay/i18n`, `collection` from `kay/content`) is imported, and `kay check` names the entry when a name is unknown.
- In a `.ts` module nothing is added, so `action` is imported there. `kay/server` also exports `s`, so a server module (`env.ts`, an API route) imports `defineEnv` and `s` from one path; a module an island also imports takes `s` from `kay`, which has the lighter browser build.

### Props

- Props are declared once, at the top level, with the `props<T>()` macro.
- Destructure one level deep and read nested fields as `todo.title`. `const all = props<T>()` also works and reads as `all.todo`.
- Defaults go in the destructuring. A default applies only to an `undefined` prop (`null` stays `null`), and runs only then, once per component, the first time the prop is read.
- Props stay reactive: the compiler turns each destructured name into a live read.
- Props are read-only.
- A prop holding an action is typed `Action<never, unknown>`, or `NoInputAction<unknown>` for one without input; see [Pass an action to a component](actions-from-islands.md#pass-an-action-to-a-component).
- A prop holding a component is typed `Component<Props>` from `kay` and drawn by its capitalised name, one holding an icon with `svg({...icon})`; see [Draw an icon or a component chosen by a value](templates.md#draw-an-icon-or-a-component-chosen-by-a-value).
- A page has no props: its data comes from its `--- server` fence.
- A prop is a plain name in the template, `{title}`, not `{title()}`.

### Signals

- `signal(value)` from `kay` makes state; `signal<T>()` starts as `undefined`.
- A signal or a memo is read by calling it, `count()`, in the template as in the script.
- In the template, one named bare where its value goes, `{count}` or `if count > 1`, is an error, `uncalled-signal`, which `kay check --fix` calls.
- Named bare as a function's argument it passes the signal itself; an argument typed `unknown` or `any`, `String(count)`, is `uncalled-signal`: call it there, or write `count as Signal<number>` to hand it on on purpose.
- `bind:value={query}` and `.set`, `count.set(c => c * 2)`, take the signal itself too.
- A signal is written by assigning it, in the template and the script alike: `count = 0` compiles to `count.set(0)`.
- `count += step` and `count++` compile to an updater, `count.set((c) => c + step)`, so an effect writing it does not track it.
- `.set` stays for an updater of your own, `count.set(c => c * 2)`.
- Assigning works on any signal a `const` or an import holds, wherever it was made: the script's own, a module's, a re-export, one a function returns or a destructuring gives, and a prop typed `Bindable<T>`.
- `kay check` reports assigning a memo, or a `const` or an import holding no signal, at its name; a `const` plainly holding none, `const n = 1` or `const seen = new Set()`, is a compile error.
- Assigning writes a signal wherever it sits: one a `const`, an import, a `let` or `var` set to `signal(...)` holds, and also one in an object's property or an array element, `box.count = 1`, `list[2]++`, or in a `let` set from a function's result. The compiler cannot tell those from a plain write, so the runtime does: a signal there is written, anything else assigned, and `kay check` types the write by what the target holds, `box.count = 'x'` being a type error for a `Signal<number>`. A function assigned there, a signal included, replaces what was held. A target kay sees holds no signal, a literal or `new Map()`, is assigned as written, and so is a field of `this`, a write beside another write, a `let` written with an `await`, a compound write holding an `await`, and a `let` update whose value is read: use `.set` there.
- `bind:name={signal}` on a component needs a signal and a prop typed `Bindable<T>`; a child hands it on with `bind:name={name}`, through any number of levels. `bind:` on a component makes the parent an island. `...rest` and a props spread hand a `Bindable` prop on whole; a member of `rest` is a value and `bind:` refuses it. `kay check` reports a prop not typed `Bindable`, and a memo or a value that is no signal.
- A prop is always a value: a parent hands a signal's or a memo's value, `Toggle(open={open()})`, kept current through a getter, or binds a `Bindable<T>` prop with `bind:`. A prop typed `Signal<T>` or `Memo<T>` is deprecated (`deprecated-signal-prop`): `kay check --fix --since 1.70` rewrites it, its reads and every tag passing it.
- `persisted`, `queryParam` and `linked` signals read and write as `signal` ones do; a `selection`, a `resource` or a `socket` is called or read through its members.
- `kay check` narrows a signal or memo a template expression calls within that expression: `{error() && error().message}`, with `error` a `signal<Error>()`, checks.
- A write in between, as by a function the expression calls, is not seen by that narrowing.
- Reads inside a function the template writes, a handler or a `.map` callback, run later and are not narrowed at all: copy the value into a `const` in the script, or assert it, `sent()!`.

### Derived values

- A derived value is a `memo`, or a plain function the template calls: `const shown = () => todos.filter(t => !t.done)`, read as `shown()`.
- `memo(fn)` caches a derived value until what it read changes.
- `linked(() => board.tiers)` from `kay` is a signal an island edits locally that takes its source's value again whenever that changes: `tiers.set(moved)` shows the edit, and once a refresh or the next page gives a new `board`, `tiers()` reads its tiers.
- A `linked` signal drops its edit when its source changes, even when the source comes back to the value it was edited over.
- `linked` reads a prop of a component inside an island, or of an island marked `persist`, the ones whose props change in place, a prop given unchanged keeping its edit.
- A top-level island whose props changed on a refresh renders afresh from them, its dialogs and focus lost: one whose state should outlive a refresh, such as an editor, is marked `persist`, so it stays and takes the new props.
- `selection<Key>(initial?)` from `kay` holds one selected string or number key among many rows, or none. It reads as `selected()` and writes as `selected.set(id)`.
- `selected.is(row.id)` re-runs only for the rows a change selects or unselects, not every row: `tr(class={{ danger: selected.is(row.id) }})`.

### Effects and lifecycle

- `effect(fn)` runs once the render is done and again whenever what it read changes.
- `onMount`, `onCleanup`, `untrack`, `batch`, `root` and `flush` come from `kay` too.
- An event handler runs under the owner it was bound in, the enclosing block or component, so an `onCleanup` it registers runs when that goes.
- `root(fn)` runs `fn(dispose)` under an owner of its own, not attached to the one it was called under: the effects and `onCleanup`s created inside live until `dispose()` is called, and `root` returns what `fn` returns. It is for code with no component to stop it, such as a module-level subscription.
- A write applies at once; the effects it touches run together in a microtask, or right away through `flush()`.
- `durationMs('3s')` from `kay` is the milliseconds a duration written with its unit stands for, `'250ms'` 250 and `'2m'` 120000, for a timer of your own: a bare number throws, and a text that is no duration gives `NaN`.
- `every(interval, run, { while })` from `kay` runs `run` every `interval`, a duration such as `'3s'` or `'250ms'`, while the island lives, and while `while`, read as an effect reads, holds: the timer starts and stops as it turns, never on the server.
- `every` skips a tick while the promise the last run returned is pending.
- `every(interval, run, { immediate: true })` runs it as the timer starts too, rather than one interval later.
- `every` pauses while the tab is hidden and runs once as it shows again; `{ background: true }` keeps it running hidden. An interval under 1 ms or over 24 days, or one that is not a number or a duration string (`'3 s'`), throws.
- `every('3s', refresh, { while: () => issuing })` polls the page, `every('1s', () => now = Date.now())` ticks a clock, and a bare number throws.
- `watch(source, (next, previous) => ...)` from `kay` runs on each change of `source`, a signal or a function reading some, not on its first read: no hand-kept previous value to compare against.
- `watch` tracks only `source`, never what its callback reads; a read giving the same value runs nothing, and what the callback registers with `onCleanup` stays until its next run.
- `watch(source, run, { immediate: true })` runs on the first read too, `previous` being `undefined` then.
- The first read is when the island's effects first run, once its render is done: a write the script makes before then is part of it and runs nothing.
- What the callback registers with `onCleanup` before an `await` runs at its next run: a flag set there drops a slower answer to an older value.
- `debounced(source, delay)` from `kay` is a memo giving `source`'s value once it has stopped changing for `delay`, a duration, starting with its value now: `watch(debounced(typed, '300ms'), lookUp)` looks up as the user pauses, with no `setTimeout` kept by hand.
- `debounced` drops its pending value with the island; on the server it keeps its first value. A `debounced` is read by calling it, as a memo is.
- `watch` and `debounced` run nothing while the server renders an island, as `effect` does; at a module's top level they run in the server's process too, as `effect` does there.
- `listen(window, 'keydown', event => ...)` from `kay` listens to an event of `window`, `document` or any other target while the island lives, the handler typed by the target's events and the fourth argument passed to `addEventListener`.
- `listen` never runs on the server, where the compiler keeps `window` unread, so a `.ts` module writes `listen(() => window, ...)`.
- A `listen` target read from a signal or a ref, `listen(() => panel, 'scroll', ...)`, listens to its new value as it changes, none while it is undefined.

### Generic components

- Type parameters on the script fence line make a component generic, written as TypeScript writes them; each use infers them from its props, islands included.
- `List(items={todos} show={todo => todo.title})` types `todo` as one of `todos`.
- `kay fmt` writes the line `--- <T ...>`.
- A page has no props, so it takes no type parameters.

### Glob imports

- `import.meta.glob` works in a component script, a server fence or a TypeScript module.
- It gives a record of the files by their path as the pattern writes it, `'../cards/one.kay'`, sorted.
- With `eager: true` each value is the file's module, imported along with the importer; without, a function importing it, `() => Promise<module>`, a chunk of its own in the browser.
- `import: 'default'` gives that export of each instead of the module, and `T` types what each gives, `unknown` by default.
- A pattern starts with `./` or `../`, from the importer, or `/`, from the project's root, and its keys start the same way.
- A list of patterns adds up their files, one starting with `!` leaving its own out: `['./demos/*.kay', '!./demos/draft.kay']`.
- `node_modules` is only searched by a pattern naming it, and the importer never matches itself.
- The build expands the call, so its patterns and options are written in it: a pattern built at run time, or another option, is a build error.
- The stylesheets of the components it imports reach the page as a static import's do.
- `kay dev` restarts when a matching file is added or removed, so the record follows with nothing to rerun.
- A server run from source outside `kay dev` registers kay's loader in `pages()`: the entry, and what it imports before calling it, has no `import.meta.glob` there, nor imports a `.kay` file. `kay dev` and `kay build --compile` have them everywhere.
