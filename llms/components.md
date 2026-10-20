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

### Keep state that changes

A signal holds it, read by calling it and written by assigning it, in the template as in the script; a memo derives a value from it:

```kay
---
const count = signal(0)
const double = memo(() => count() * 2)
---
button(onClick={() => count++}) Clicked {count()} times, {double()} doubled
```

### Let a child write the parent's state

The parent hands the signal itself, by name, and the child types the prop `Signal<T>`, which it reads by calling and writes by assigning, `src/toggle.kay`:

```kay
---
import type { Signal } from 'kay'

const { open } = props<{ open: Signal<boolean> }>()
---
button(onClick={() => open = !open()}) {open() ? 'Hide' : 'Show'}
```

```kay
---
import Toggle from './toggle.kay'

const open = signal(false)
---
Toggle(open={open})
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

- `props`, `signal`, `memo`, `effect`, `onMount` and `onCleanup` need no import in a script, nor `action` in a server fence: the compiler imports them from `kay` when the file uses them without declaring or importing a name of its own.
- The translation `t` of `kay/i18n` needs no import either, in a template or any fence.
- That is the rule: a name needs no import when it is what a component is written with, `props`, the reactive primitives, a server fence's `action` and `t`; everything else is imported, from `kay` for what pages, components, guards and routes are written with (`persisted`, `context`, `navigate`, `s`, `guard`, `localPath`, `publicEnv`), from `kay/server` for what sets up and runs the server (`defineConfig`, `defineEnv`, `session`, `queue`, `files`), from a topic's own entry for that topic's helpers (`kay/i18n`, `kay/cache`, `kay/content`, `kay/seo`, `kay/image`), components such as `T` included.
- In a `.ts` module nothing is added, so `action` is imported there.

### Props

- Props are declared once, at the top level, with the `props<T>()` macro.
- Destructure one level deep and read nested fields as `todo.title`. `const all = props<T>()` also works and reads as `all.todo`.
- Defaults go in the destructuring. A default applies only to an `undefined` prop (`null` stays `null`), and runs only then, once per component, the first time the prop is read.
- Props stay reactive: the compiler turns each destructured name into a live read.
- Props are read-only.
- A prop holding an action is typed `Action<never, unknown>`, or `NoInputAction<unknown>` for one without input; see [Pass an action to a component](actions-from-islands.md#pass-an-action-to-a-component).
- A prop holding a component is typed `Component<Props>` from `kay` and drawn by its capitalised name, one holding an icon with `svg({...icon})`; see [Draw an icon or a component chosen by a value](templates.md#draw-an-icon-or-a-component-chosen-by-a-value).
- A page has no props: its data comes from its `--- server` fence.
- A prop is a plain name in the template, `{title}`, not `{title()}`, unless its type is a signal.

### Signals

- `signal(value)` from `kay` makes state; `signal<T>()` starts as `undefined`.
- A signal or a memo is read by calling it, `count()`, in the template as in the script.
- In the template, one named bare where its value goes, `{count}` or `if count > 1`, is an error, `uncalled-signal`, which `kay check --fix` calls.
- Named bare where it is handed on, as a component's prop, `Toggle(open={open})`, or a function's argument, it passes the signal itself; an argument or prop typed `unknown` or `any`, `String(count)`, is `uncalled-signal`: call it there, or write `count as Signal<number>` to hand it on on purpose.
- `bind:value={query}` and `.set`, `count.set(c => c * 2)`, take the signal itself too.
- A signal is written by assigning it, in the template and the script alike: `count = 0` compiles to `count.set(0)`.
- `count += step` and `count++` compile to an updater, `count.set((c) => c + step)`, so an effect writing it does not track it.
- `.set` stays for an updater of your own, `count.set(c => c * 2)`.
- Assigning works on any signal a `const` or an import holds, wherever it was made: the script's own, a module's, a re-export, one a function returns or a destructuring gives, and a prop the props type, inline or a script `interface` or `type`, writes as `Signal<T>` from `kay`.
- `kay check` reports assigning a memo, or a `const` or an import holding no signal, at its name; a `const` plainly holding none, `const n = 1` or `const seen = new Set()`, is a compile error.
- Assigning writes any signal the compiler sees made: a `const`, an import, a `let` or `var` the script sets to `signal(...)`, a prop typed `Signal<T>`. A signal read from an object's property, `box.count`, or a `let` set from a function's result is written with `.set`: assigning it replaces the property or variable, and `kay check` reports `Type 'number' is not assignable to type 'Signal<number>'`.
- A prop typed `Signal<T>` or `Memo<T>` from `kay` takes the signal a parent hands by name, `Toggle(open={open})`; one typed `T` takes its value, `Toggle(open={open()})`, kept current.
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
- `durationMs('3s')` from `kay` is the milliseconds a duration written with its unit stands for, `'250ms'` 250 and `'2m'` 120000, for a timer of your own: a bare number throws, as it would read as seconds elsewhere, and a text that is no duration gives `NaN`.
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
