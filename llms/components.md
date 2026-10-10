# Components

## File layout

Up to two fences come first, in either order, then the template. Both are optional.

```kay
--- server
const greeting = 'Hello'
---
---
const count = signal(0)
---
p {greeting}
button(onClick={() => count.set(count + 1)}) Clicked {count} times
```

- `---` holds the component script: imports, props, signals, functions. It runs wherever the component renders.
- `--- server` exists on pages and layouts only. It runs on the server for each request and never reaches the browser.
- `--- client` in place of `---` makes the component render in the browser only, generic ones written `--- client <T>`; see [Islands](islands.md#islands).

## Component script

Props are declared once, at the top level, with the `props<T>()` macro. It needs no import, and neither do `signal`, `memo`, `effect` and `onMount` in a script, nor `action` in a server fence: the compiler imports them from `kay` when the file uses them without declaring or importing a name of its own. The rest of `kay`, such as `persisted`, `context` or `navigate`, is imported.

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
- `signal(value)` from `kay` makes state; `signal<T>()` starts as `undefined`. A derived value is a `memo`, or a plain function the template calls: `const shown = () => todos.filter(t => !t.done)`, read as `shown()`. `persisted` and `linked` signals read by name as `signal` ones do; a `selection`, a `resource` or a `socket` is called or read through its members, as in the script.
- `linked(() => board.tiers)` from `kay` is a signal an island edits locally that takes its source's value again whenever that changes: `tiers.set(moved)` shows the edit, and once a refresh or the next page gives a new `board`, `tiers()` reads its tiers, the edit dropped, even when the source comes back to the value it was edited over. It reads a prop of a component inside an island, or of an island marked `persist`, the ones whose props change in place, a prop given unchanged keeping its edit. A top-level island whose props changed on a refresh renders afresh from them, its dialogs and focus lost: one whose state should outlive a refresh, such as an editor, is marked `persist`, so it stays and takes the new props.
- `selection<Key>(initial?)` from `kay` holds one selected string or number key among many rows, or none. It reads as `selected()` and writes as `selected.set(id)`, and `selected.is(row.id)` re-runs only for the rows a change selects or unselects, not every row: `tr(class={{ danger: selected.is(row.id) }})`.
- `memo(fn)` caches a derived value until what it read changes, `effect(fn)` runs once the render is done and again whenever what it read changes, and `onMount`, `onCleanup`, `untrack`, `batch`, `root` and `flush` come from `kay` too. A write applies at once; the effects it touches run together in a microtask, or right away through `flush()`.

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
- A library imports an optional peer with `import()` inside a `try` block, or followed by `.catch`: Bun builds an app without the peer then, and fails on a bare `import()` of a package it cannot find.
- `settings` in `kay.config.ts` replaces a library's settings module with the app's, by the library's name, on the server and in the browser: `settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`, a module default-exporting the library's `Settings`, which may spread the library's defaults to change a few: `export default { ...defaults, tone: 'text-red-500' }`. `kay check` checks it against the defaults it replaces. One process renders with one set of settings: `kay test`, the server and `kay build` all read them from `kay.config.ts`.
- A library linked rather than installed, `"@kaynooo/kayjs-ui": "link:../kayjs-ui"`, works the same, and so does one installed in a `node_modules` above the project, as a workspace hoists it: the app's own `package.json` names it either way.

### Extensions

A library hands the app one value to list in `extensions` in `kay.config.ts`, typed `KayExtension` from `kay/server`, and the app needs no other line:

```ts
// The library's index.ts
import type { KayExtension } from 'kay/server'

export function authPages({ prefix = '/auth' } = {}): KayExtension {
  return { name: '@kaynooo/kayjs-auth', routes: { dir: `${import.meta.dir}/routes`, prefix }, messages: `${import.meta.dir}/messages` }
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
- `kay check` lets links point at its pages; type errors inside its files are the library's own check's.
- Param matchers a library route names come from the app's `src/params` or kay's built-ins.
- Two extensions mounting a page at the same path: the first listed serves it.
- `kay dev` watches the app's files, not `node_modules`: after editing a linked library's pages, restart it.
- `messages` names a directory of catalogs, `<locale>.ts` each, laid under the app's `src/messages` key by key, with or without `i18n`: see [Locales](locales.md).
- `transformPage` rewrites each prerendered page before it is written: see [Page hooks](routing.md#page-hooks).
