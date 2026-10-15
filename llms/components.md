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
  document.title = query() === '' ? 'Search' : `Search: ${query()}`
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

watch(debounced(typed, 300), async (query) => {
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

every(1000, () => seconds++)
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

### Ship components in a package

Ship the `.kay` sources, list `kay` under `peerDependencies`, and give each component a specifier; the app installing it compiles them as its own:

```json
{
  "name": "my-ui",
  "exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" },
  "kay": { "settings": "./src/settings.ts" }
}
```

### Add pages to the app from a library

The library hands the app one value to list in `extensions`, see [Extensions](#extensions):

```ts
// The app's kay.config.ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
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
- The rest of `kay`, such as `persisted`, `context` or `navigate`, is imported.

### Props

- Props are declared once, at the top level, with the `props<T>()` macro.
- Destructure one level deep and read nested fields as `todo.title`. `const all = props<T>()` also works and reads as `all.todo`.
- Defaults go in the destructuring. A default applies only to an `undefined` prop (`null` stays `null`), and runs only then, once per component, the first time the prop is read.
- Props stay reactive: the compiler turns each destructured name into a live read.
- Props are read-only.
- A page has no props: its data comes from its `--- server` fence.
- A prop is a plain name in the template, `{title}`, not `{title()}`, unless its type is a signal.

### Signals

- `signal(value)` from `kay` makes state; `signal<T>()` starts as `undefined`.
- A signal or a memo is read by calling it, `count()`, in the template as in the script.
- In the template, one named bare where its value goes, `{count}` or `if count > 1`, is an error, `uncalled-signal`, which `kay check --fix` calls.
- Named bare where it is handed on, as a component's prop, `Toggle(open={open})`, or a function's argument, it passes the signal itself.
- `bind:value={query}` and `.set`, `count.set(c => c * 2)`, take the signal itself too.
- Before kay 1.41 a bare name handed on passed the value: `kay check` reports such a prop or argument typed for the value, with no fix, and nothing where it takes anything, `String(count)` or `JSON.stringify(count)`: call it there.
- A signal is written by assigning it, in the template and the script alike: `count = 0` compiles to `count.set(0)`.
- `count += step` and `count++` compile to an updater, `count.set((c) => c + step)`, so an effect writing it does not track it.
- `.set` stays for an updater of your own, `count.set(c => c * 2)`.
- Assigning works on any signal a `const` or an import holds, wherever it was made: the script's own, a module's, a re-export, one a function returns or a destructuring gives, and a prop the props type, inline or a script `interface` or `type`, writes as `Signal<T>` from `kay`.
- `kay check` reports assigning a memo, or a `const` or an import holding no signal, at its name; a `const` plainly holding none, `const n = 1` or `const seen = new Set()`, is a compile error.
- A signal held in a `let`, a `var` or an object's property is written with `.set`: assigning it replaces what the variable or property holds.
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
- A write applies at once; the effects it touches run together in a microtask, or right away through `flush()`.
- `every(ms, run, { while })` from `kay` runs `run` every `ms` milliseconds while the island lives, and while `while`, read as an effect reads, holds: the timer starts and stops as it turns, never on the server.
- `every` skips a tick while the promise the last run returned is pending.
- `every(ms, run, { immediate: true })` runs it as the timer starts too, rather than one interval later.
- `every(3000, refresh, { while: () => issuing })` polls the page, `every(1000, () => now = Date.now())` ticks a clock.
- `watch(source, (next, previous) => ...)` from `kay` runs on each change of `source`, a signal or a function reading some, not on its first read: no hand-kept previous value to compare against.
- `watch` tracks only `source`, never what its callback reads; a read giving the same value runs nothing, and what the callback registers with `onCleanup` stays until its next run.
- `watch(source, run, { immediate: true })` runs on the first read too, `previous` being `undefined` then.
- The first read is when the island's effects first run, once its render is done: a write the script makes before then is part of it and runs nothing.
- What the callback registers with `onCleanup` before an `await` runs at its next run: a flag set there drops a slower answer to an older value.
- `debounced(source, ms)` from `kay` is a memo giving `source`'s value once it has stopped changing for `ms` milliseconds, starting with its value now: `watch(debounced(typed, 300), lookUp)` looks up as the user pauses, with no `setTimeout` kept by hand.
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

### Publishing a component library

A package can ship `.kay` components, which the app installing it compiles as its own: on the server, in islands, and in `kay build --compile` and `--static`.

- Ship the `.kay` sources, list `kay` under `peerDependencies`, and import from `kay`, so the app's one copy of kay, and its registered types, serve the library too.
- Give each component a specifier in the exports map, `"exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" }`, imported as `import Button from '@kaynooo/kayjs-ui/button.kay'`. Without an exports map a component is imported by its path in the package.
- Settings the app may replace, such as theme classes or an icon resolver, live in one module named in package.json, `"kay": { "settings": "./src/settings.ts" }`, which default-exports the settings and which the library's components import.
- Define the defaults in a module of their own, `./src/defaults.ts`, re-exported by the settings module, `export { default } from './defaults'`, and export the `Settings` type and the defaults from there for apps to extend: the app's module takes the place of the settings module, so anything read through it is the app's.
- A library logs with `logFrom('my-library')` from `kay` rather than `console`, so its lines follow the app's `log` setting, text, JSON or the app's function, headed by the request being answered (see [Request logs](production.md#request-logs)).
- A library imports an optional peer with `import()` inside a `try` block, or followed by `.catch`: Bun builds an app without the peer then, and fails on a bare `import()` of a package it cannot find.

### Using a component library

- Install it and import its components; `kay check`, the editor, auto-import and go-to-definition included, types them through `.kay/types/kay-packages.d.ts`, and needs no change to `tsconfig.json`.
- Only the components the app's imports reach ship: an island of the library the app never imports adds nothing to its bundles, unless a module re-exporting every component, such as a barrel `index.ts`, is imported.
- The classes in their templates and in the library scripts they import, default theme classes included, reach `.kay/classes.txt` with the app's own, so Tailwind builds them with no `@source` line.
- The app's stylesheets leave out each rule of a library's stylesheets whose selector needs a class nothing names, in `kay dev` and `kay build`, with Tailwind or without: kayjs-ui's theme ships only the components the app renders. A class counts as named when a file of the app (templates, scripts, Markdown, HTML, stylesheets, JSON, YAML, comments included) or a library file it reaches writes it whole. A class put together at runtime (`` `kui-btn-${tone}` ``) or written only in content kept outside the project, such as a CMS body in the database, is not seen: write it whole in any file of the app, a comment in `app.css` say, to keep its rules.
- `kay check` reports a type error inside a library component the app uses once, at the component's own line; one the app never imports reports nothing.
- Errors inside the library's own `.ts` modules are the library's, as `skipLibCheck` leaves a declaration file's, so an optional peer the app has not installed reports nothing there, while the app's own calls into those modules are checked.
- `settings` in `kay.config.ts` replaces a library's settings module with the app's, by the library's name, on the server and in the browser: `settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`, a module default-exporting the library's `Settings`.
- The app's settings module may spread the library's defaults to change a few: `export default { ...defaults, tone: 'text-red-500' }`. `kay check` checks it against the defaults it replaces.
- One process renders with one set of settings: `kay test`, the server and `kay build` all read them from `kay.config.ts`.
- kay's own libraries, `@kaynooo/kayjs-auth`, `@kaynooo/kayjs-ui`, `@kaynooo/kayjs-mail` and `@kaynooo/kayjs-cms`, are released with kay at its version, each peering on kay's minor and on the libraries of that same version: install the ones matching the app's kay, and move them together.
- An app on a `^0.x` range of one of kay's libraries moves it to kay's version by hand, as a caret on 0.x never reaches it.
- A library linked rather than installed, `"@kaynooo/kayjs-ui": "link:../kayjs-ui"`, works the same, and so does one installed in a `node_modules` above the project, as a workspace hoists it: the app's own `package.json` names it either way.

### Extensions

A library hands the app one value to list in `extensions` in `kay.config.ts`, typed `KayExtension` from `kay/server`, and the app needs no other line:

```ts
// The library's index.ts
import type { KayExtension } from 'kay/server'

export function authPages({ prefix = '/auth' } = {}): KayExtension {
  return {
    name: '@kaynooo/kayjs-auth',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix },
    messages: `${import.meta.dir}/messages`,
    config: { head: [{ tag: 'meta', props: { name: 'referrer', content: 'same-origin' } }] },
  }
}
```

- `routes` lays a directory of the library's `.kay` pages, layouts, guards and special pages over the app's `src/routes` at `prefix`, the root by default: `routes/login.kay` serves `/auth/login`, its server fence, load and actions included, as if it were `src/routes/auth/login.kay`.
- A file of the app at the same path replaces the library's: `src/routes/auth/login.kay` serves `/auth/login` in its place, and the library's other pages stay.
- Layouts, guards, `_404.kay` and `_error.kay` resolve per URL directory across both trees, the app's file winning at a level both have one: the app's root layout wraps a library page, and a library `_layout.kay` wraps its pages, an app page replacing one of them included, unless the app has its own `_layout.kay` in `src/routes/auth`.
- Its islands and stylesheets are bundled with the app's, and `kay build --compile` and `--static` carry its pages; a static export refuses a library page taking an action, as it refuses the app's, unless the app replaces it.
- `kay check` lets links point at its pages; type errors inside an installed library's files are the library's own check's.
- An extension listed by a path beside the app or through a link, as a library's own example or fixture app lists it, is checked as the app's own, by `kay check` and in the editor: its pages, its CMS editor and the components they reach, their route params typed, under the app's `tsconfig.json`, so the app sets the compiler options the library is written for; its `.ts` modules stay the library's own check's.
- A path an extension's routes name, a link, a redirect or a `localPath` fallback, is checked only when it goes under its own prefix, `/fr/auth/x` as `/auth/x`: `/` or any other page of the app, which no extension can know, is taken as written, and an extension mounted at the root checks none.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `api` lays a directory of API modules over the app's `src/api` at `prefix` the same way: `api/session.ts` serves `/api/auth/session` unless the app has `src/api/auth/session.ts`, and the app's `_guard.ts` files run before the library's.
- The server, the executable, `testSite`, the OpenAPI document and an island importing one, typed in `kay check`, see an extension's API modules as the app's own. A static export refuses them as it refuses the app's.
- `config` lies under the app's `kay.config.ts`, read by every command as if the app wrote it: objects merge key by key, arrays join with the extension's items first, and any other value the app sets wins, as does a later extension's over an earlier one's.
- A library needing Bun plugins for its files lists them in `config.plugins`, loading a native addon such as Tailwind's inside the plugin's `setup` rather than at import, since `kay build --compile` carries the library's module in the executable.
- Tags every page carries go in `config.head`, a CSP source in `config.security.csp`.
- `server` hands kay an Elysia plugin that `pages()` uses before the pages, actions and API modules, so the app's `src/server.ts` needs no `.use(...)` of its own and none at all works.
- What the `server` plugin decorates, or derives `as: 'scoped'` or `'global'`, reaches their `ctx.locals`, and `kay check` types those locals and lets links point at its routes with no `Register` declaration of the app's, adding to the locals the app registers. A derive with no `as` reaches only the plugin's own routes.
- Given as a function, `server: async () => (await import('./server')).plugin`, it runs only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on the app's database or its server environment, or one whose module imports `.kay` files, as one imported while `kay.config.ts` loads comes before kay compiles any, and resolves to its path.
- The library types it `KayExtension<typeof plugin>` so its locals reach the app; typed a bare `KayExtension`, its plugin adds no locals and no routes to the check, and the app's own stay typed. A static export leaves it out.
- `kay dev` watches the app's files, not `node_modules`: after editing a linked library's pages, restart it.
- `messages` names a directory of catalogs, `<locale>.ts` each, laid under the app's `src/messages` key by key, with or without `i18n`: see [Locales](locales.md).
- `transformPage` rewrites each prerendered page before it is written: see [Page hooks](routing.md#page-hooks).
- `editor` names a `.kay` island, `${import.meta.dir}/editor.kay`, that every page renders last in edit mode but the pages its own `routes` serve, its stylesheets linked after the page's, and carried by `kay build --compile`: see [A CMS editing on the page](content.md#preview-mode).
