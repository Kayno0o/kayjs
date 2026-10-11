# Components

## File layout

Up to two fences come first, in either order, then the template. Both are optional.

```kay
--- server
const greeting = 'Hello'
--- script
const count = signal(0)
---
p {greeting}
button(onClick={() => count++}) Clicked {count} times
```

- `---` holds the component script: imports, props, signals, functions. It runs wherever the component renders.
- `--- server` exists on pages and layouts only. It runs on the server for each request and never reaches the browser.
- `--- client` in place of `---` makes the component render in the browser only, generic ones written `--- client <T>`; see [Islands](islands.md#islands).
- A fence ends on a `---` line, or on a `--- server`, `--- client` or `--- script` line, which opens the next fence. `--- script` is `---` spelled out, for a script that follows another fence.

## Component script

Props are declared once, at the top level, with the `props<T>()` macro. It needs no import, and neither do `signal`, `memo`, `effect` and `onMount` in a script, nor `action` in a server fence: the compiler imports them from `kay` when the file uses them without declaring or importing a name of its own, and the translation `t` of `kay/i18n` in a template or any fence alike. The rest of `kay`, such as `persisted`, `context` or `navigate`, is imported.

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

- Destructure one level deep and read nested fields as `todo.title`; give defaults in the destructuring. A default applies only to an `undefined` prop (`null` stays `null`) and runs only then, once per component, the first time the prop is read. `const all = props<T>()` also works and reads as `all.todo`.
- Props stay reactive: the compiler turns each destructured name into a live read. They are read-only.
- Imports, `type` and `interface` declarations are module level, except a type taking the `typeof` a name the script declares, which stays inside the component. Both fences may import the same name; the server fence's copy is dropped. A fence holds TypeScript only: markup goes in the template, and JSX in a fence is reported.
- `signal(value)` from `kay` makes state; `signal<T>()` starts as `undefined`. A derived value is a `memo`, or a plain function the template calls: `const shown = () => todos.filter(t => !t.done)`, read as `shown()`. `persisted`, `queryParam` and `linked` signals read by name as `signal` ones do; a `selection`, a `resource` or a `socket` is called or read through its members, as in the script.
- A signal is written by assigning it, in the template and the script alike: `count = 0` compiles to `count.set(0)`, `count += step` and `count++` to an updater, `count.set((c) => c + step)`, so an effect writing it does not track it. `.set` stays for an updater of your own, `count.set(c => c * 2)`. A memo cannot be written, and assigning an import or a constant kay cannot tell is a signal is an error.
- Every signal kay sees made reads and writes by name: the script's own, one a `.ts` module exports as `export const accent = signal(...)` (or `persisted`, `queryParam`, `linked`, `memo`), and a prop the props type, inline or a script `interface` or `type`, writes as `Signal<T>` or `Memo<T>` from `kay`: `const { open } = props<{ open: Signal<boolean> }>()`, then `button(onClick={() => open = !open}) {open}`. A parent hands it the signal under a name of its own, `const openState = open`, then `Toggle(open={openState})`, since `open={open}` gives the value. Any other signal, one a module re-exports or a function returns, is called, `accent()`.
- `linked(() => board.tiers)` from `kay` is a signal an island edits locally that takes its source's value again whenever that changes: `tiers.set(moved)` shows the edit, and once a refresh or the next page gives a new `board`, `tiers()` reads its tiers, the edit dropped, even when the source comes back to the value it was edited over. It reads a prop of a component inside an island, or of an island marked `persist`, the ones whose props change in place, a prop given unchanged keeping its edit. A top-level island whose props changed on a refresh renders afresh from them, its dialogs and focus lost: one whose state should outlive a refresh, such as an editor, is marked `persist`, so it stays and takes the new props.
- `selection<Key>(initial?)` from `kay` holds one selected string or number key among many rows, or none. It reads as `selected()` and writes as `selected.set(id)`, and `selected.is(row.id)` re-runs only for the rows a change selects or unselects, not every row: `tr(class={{ danger: selected.is(row.id) }})`.
- `memo(fn)` caches a derived value until what it read changes, `effect(fn)` runs once the render is done and again whenever what it read changes, and `onMount`, `onCleanup`, `untrack`, `batch`, `root` and `flush` come from `kay` too. `every(ms, run, { while })` from `kay` runs `run` every `ms` milliseconds while the island lives, and while `while`, read as an effect reads, holds: the timer starts and stops as it turns, never on the server, and a tick is skipped while the promise the last run returned is pending. `every(3000, refresh, { while: () => issuing })` polls the page, `every(1000, () => now = Date.now())` ticks a clock. `listen(window, 'keydown', event => ...)` from `kay` listens to an event of `window`, `document` or any other target while the island lives, the handler typed by the target's events and the fourth argument passed to `addEventListener`; it never runs on the server, where the compiler keeps `window` unread, so a `.ts` module writes `listen(() => window, ...)`, and a target read from a signal or a ref, `listen(() => panel, 'scroll', ...)`, listens to its new value as it changes, none while it is undefined. A write applies at once; the effects it touches run together in a microtask, or right away through `flush()`.

### Generic components

Type parameters on the script fence line make a component generic, written as TypeScript writes them; each use infers them from its props, islands included:

```kay
--- <T extends { id: number }>
const { items, show } = props<{ items: T[], show: (item: T) => string }>()
---
ul
  for item of items
    li {show(item)}
```

`List(items={todos} show={todo => todo.title})` types `todo` as one of `todos`, and `kay fmt` writes the line `--- <T ...>`. A page has no props, so it takes no type parameters.

### Glob imports

`import.meta.glob` imports every file a pattern matches, as Vite's does, in a component script, a server fence or a TypeScript module:

```kay
---
import type { Component } from 'kay'

const cards = import.meta.glob<Component>('../cards/*.kay', { eager: true, import: 'default' })
---
for Card of Object.values(cards)
  Card
```

- It gives a record of the files by their path as the pattern writes it, `'../cards/one.kay'`, sorted. With `eager: true` each value is the file's module, imported along with the importer; without, a function importing it, `() => Promise<module>`, a chunk of its own in the browser. `import: 'default'` gives that export of each instead of the module, and `T` types what each gives, `unknown` by default.
- A pattern starts with `./` or `../`, from the importer, or `/`, from the project's root, and its keys start the same way. A list of patterns adds up their files, one starting with `!` leaving its own out: `['./demos/*.kay', '!./demos/draft.kay']`. `node_modules` is only searched by a pattern naming it, and the importer never matches itself.
- The build expands the call, so its patterns and options are written in it: a pattern built at run time, or another option, is a build error. The stylesheets of the components it imports reach the page as a static import's do.
- `kay dev` restarts when a matching file is added or removed, so the record follows with nothing to rerun.
- A server run from source outside `kay dev` registers kay's loader in `pages()`: the entry, and what it imports before calling it, has no `import.meta.glob` there, nor imports a `.kay` file. `kay dev` and `kay build --compile` have them everywhere.

## Component libraries

A package can ship `.kay` components, which the app installing it compiles as its own: on the server, in islands, and in `kay build --compile` and `--static`.

Publishing one:

- Ship the `.kay` sources, list `kay` under `peerDependencies`, and import from `kay`, so the app's one copy of kay, and its registered types, serve the library too.
- Give each component a specifier in the exports map, `"exports": { "./*.kay": "./src/*.kay", ".": "./src/index.ts" }`, imported as `import Button from '@kaynooo/kayjs-ui/button.kay'`. Without an exports map a component is imported by its path in the package.
- Settings the app may replace, such as theme classes or an icon resolver, live in one module named in package.json, `"kay": { "settings": "./src/settings.ts" }`, which default-exports the settings and which the library's components import. Define the defaults in a module of their own, `./src/defaults.ts`, re-exported by the settings module, `export { default } from './defaults'`, and export the `Settings` type and the defaults from there for apps to extend: the app's module takes the place of the settings module, so anything read through it is the app's.

Using one:

- Install it and import its components; `kay check`, the editor, auto-import and go-to-definition included, types them through `.kay/types/kay-packages.d.ts`, and needs no change to `tsconfig.json`.
- Only the components the app's imports reach ship: an island of the library the app never imports adds nothing to its bundles, unless a module re-exporting every component, such as a barrel `index.ts`, is imported.
- The classes in their templates and in the library scripts they import, default theme classes included, reach `.kay/classes.txt` with the app's own, so Tailwind builds them with no `@source` line.
- `kay check` reports a type error inside a library component the app uses once, at the component's own line; one the app never imports reports nothing. Errors inside the library's own `.ts` modules are the library's, as `skipLibCheck` leaves a declaration file's, so an optional peer the app has not installed reports nothing there, while the app's own calls into those modules are checked.
- A library logs with `logFrom('my-library')` from `kay` rather than `console`, so its lines follow the app's `log` setting, text, JSON or the app's function, headed by the request being answered (see [Request logs](production.md#request-logs)).
- A library imports an optional peer with `import()` inside a `try` block, or followed by `.catch`: Bun builds an app without the peer then, and fails on a bare `import()` of a package it cannot find.
- `settings` in `kay.config.ts` replaces a library's settings module with the app's, by the library's name, on the server and in the browser: `settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`, a module default-exporting the library's `Settings`, which may spread the library's defaults to change a few: `export default { ...defaults, tone: 'text-red-500' }`. `kay check` checks it against the defaults it replaces. One process renders with one set of settings: `kay test`, the server and `kay build` all read them from `kay.config.ts`.
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

```ts
// The app's kay.config.ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
```

- `routes` lays a directory of the library's `.kay` pages, layouts, guards and special pages over the app's `src/routes` at `prefix`, the root by default: `routes/login.kay` serves `/auth/login`, its server fence, load and actions included, as if it were `src/routes/auth/login.kay`.
- A file of the app at the same path replaces the library's: `src/routes/auth/login.kay` serves `/auth/login` in its place, and the library's other pages stay.
- Layouts, guards, `_404.kay` and `_error.kay` resolve per URL directory across both trees, the app's file winning at a level both have one: the app's root layout wraps a library page, and a library `_layout.kay` wraps its pages, an app page replacing one of them included, unless the app has its own `_layout.kay` in `src/routes/auth`.
- Its islands and stylesheets are bundled with the app's, and `kay build --compile` and `--static` carry its pages; a static export refuses a library page taking an action, as it refuses the app's, unless the app replaces it.
- `kay check` lets links point at its pages; type errors inside an installed library's files are the library's own check's. An extension listed by a path beside the app or through a link, as a library's own example or fixture app lists it, is checked as the app's own, by `kay check` and in the editor: its pages and the components they reach, their route params typed.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `api` lays a directory of API modules over the app's `src/api` at `prefix` the same way: `api/session.ts` serves `/api/auth/session` unless the app has `src/api/auth/session.ts`, the app's `_guard.ts` files run before the library's, and the server, the executable, `testSite`, the OpenAPI document and an island importing one, typed in `kay check`, see them as the app's own. A static export refuses them as it refuses the app's.
- `config` lies under the app's `kay.config.ts`, read by every command as if the app wrote it: objects merge key by key, arrays join with the extension's items first, and any other value the app sets wins, as does a later extension's over an earlier one's. A library needing Bun plugins for its files lists them in `config.plugins`, loading a native addon such as Tailwind's inside the plugin's `setup` rather than at import, since `kay build --compile` carries the library's module in the executable, tags every page carries in `config.head`, a CSP source in `config.security.csp`.
- `server` hands kay an Elysia plugin that `pages()` uses before the pages, actions and API modules, so the app's `src/server.ts` needs no `.use(...)` of its own and none at all works: what it decorates, or derives `as: 'scoped'` or `'global'`, reaches their `ctx.locals`, and `kay check` types those locals and lets links point at its routes with no `Register` declaration of the app's, adding to the locals the app registers. A derive with no `as` reaches only the plugin's own routes. Given as a function, `server: async () => (await import('./server')).plugin`, it runs only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on the app's database or its server environment, or one whose module imports `.kay` files: one imported while `kay.config.ts` loads comes before kay compiles any, and resolves to its path. The library types it `KayExtension<typeof plugin>` so its locals reach the app; a static export leaves it out.
- `kay dev` watches the app's files, not `node_modules`: after editing a linked library's pages, restart it.
- `messages` names a directory of catalogs, `<locale>.ts` each, laid under the app's `src/messages` key by key, with or without `i18n`: see [Locales](locales.md).
- `transformPage` rewrites each prerendered page before it is written: see [Page hooks](routing.md#page-hooks).
- `editor` names a `.kay` island, `${import.meta.dir}/editor.kay`, that every page renders last in edit mode, its stylesheets linked after the page's, and carried by `kay build --compile`: see [A CMS editing on the page](content.md#preview-mode).
