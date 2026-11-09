# Islands

A component is an island when its own code needs the browser: an `on*`, `bind:` or `ref` in its template, a browser value of `kay` in its script (a `live` value a module exports included), or a `--- island` or `--- client` fence line; what an island renders is part of it, and nothing a component passes makes it one. It is decided at compile time, from the file and its imports.

## Common tasks

### Make a component interactive

A handler, a `bind:`, a `ref` or a signal makes it an island: it renders on the server and hydrates in the browser.

```kay
---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

### Share state between islands

A signal a `.ts` module exports is one state for every island of the page importing it, which reads it by calling it and writes it with `.set` or by assigning it, `cart = []`:

```ts
// src/cart.ts
import { signal } from 'kay'

export const cart = signal<string[]>([])
```

```kay
---
import { cart } from './cart'

const { name } = props<{ name: string }>()
---
button(onClick={() => cart = [...cart(), name]}) Add {name}
p {cart().length} in the cart
```

### Keep a value across pages and visits

`persisted` keeps it in a cookie the server reads too, so the first paint shows it:

```kay
---
import { persisted } from 'kay'

const theme = persisted('theme', 'light')
---
button(onClick={() => theme = theme() === 'light' ? 'dark' : 'light'}) Theme: {theme()}
```

### Keep a filter in the URL

`{ storage: 'query' }` keeps it as a query param, so a reload or a shared link keeps it:

```kay
---
import { persisted } from 'kay'

const q = persisted('q', '', { storage: 'query' })
---
input(type="search" bind:value={q} aria-label="Search")
```

### Hydrate an island later

`hydrate="visible"` waits until it scrolls near the viewport, `hydrate="idle"` until the browser is idle:

```kay
---
import Comments from './comments.kay'

const { postId } = props<{ postId: number }>()
---
Comments(postId={postId} hydrate="visible")
```

A component that wants one of these wherever it is used, a launcher kept across pages for one, exports `island` from a `--- module` fence; a parent's own `hydrate` or `persist` wins. Only `export const island = ...` in an island's module fence is read, and `kay check` reports any other form of the export, or one on a component that is no island:

```kay
--- module
export const island = { persist: true, hydrate: 'idle' } as const
--- island
const { label } = props<{ label: string }>()
---
button {label}
```

### Animate an element in and out

`transition="fade"` plays the classes `fade-enter-*` and `fade-leave-*` as a block shows and hides it:

```kay
---
import { signal } from 'kay'

const open = signal(false)
---
button(onClick={() => open = !open()}) Toggle
if open()
  p(transition="fade") Saved
```

```css
.fade-enter-active, .fade-leave-active { transition: opacity 200ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
```

### Show a fallback when a widget throws

A `try` block renders its `catch` block when what it renders throws, on the server and in an island:

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

### Hand a value down without props

A context made with `createContext` from `kay`, provided by a component and used by anything it renders:

```ts
// src/theme.ts
import { createContext } from 'kay'

export const Theme = createContext<'light' | 'dark'>('light')
```

```kay
---
import { Theme } from './theme'

Theme.provide('dark')
---
slot
```

```kay
---
import { Theme } from './theme'

const theme = Theme.use()
---
p(class={theme}) Themed
```

### Tie a label or a trigger to its element

`uid()` from `kay` gives an id unique on the page, the same on the server and in the browser:

```kay
---
import { uid, signal } from 'kay'

const id = uid()
const open = signal(false)
---
button(
  aria-controls={id}
  aria-expanded={open()}
  onClick={() => open = !open()}
)
  | Menu
ul(id={id} hidden={!open()})
  slot
```

`randomId(bytes = 16)` from `kay` gives random hex (`2 * bytes` characters) for a name that must not repeat across visits, such as an idempotency key or a tab name; unlike `crypto.randomUUID()` it works on an insecure page (http on a home network). `0` gives `''` and a negative count throws; a browser refuses more than 65,536 bytes. It differs on every call, so draw it in a handler or after mount, never for an id in markup: the server render and the hydration would disagree, and `uid()` above is the id that stays the same on both.

### Read an element's size

`elementSize()` from `kay` gives an element's width and height as reactive values, observed for as long as the island lives:

```kay
---
import { elementSize } from 'kay'

const column = elementSize()
---
.relative.h-full(ref={column.ref})
  svg(width={column.width()} height={column.height()})
```

### Follow a media query

`mediaQuery('(max-width: 40rem)')` from `kay` is a value that follows the query while the island lives, and `reducedMotion()` is the shorthand for `prefers-reduced-motion: reduce`:

```kay
---
import { reducedMotion } from 'kay'

const still = reducedMotion()
---
if still()
  p No animation
```

The server and the island's first render read the fallback, `false` unless given as the second argument, `mediaQuery(query, true)`, or the only one, `reducedMotion(true)`; the browser's answer replaces it once mounted, so hydrating changes nothing, and a change while the page is open reaches the island.

## Reference

### Islands

- A component is interactive when any element in it has an `on*` handler, a `bind:` (on an element or a component) or a `ref`, or when its script uses a value from `kay`, such as `signal`; the rule is at the top.
- `ActionError`, `ActionRedirectError`, `ApiError`, `apiUrl`, `byteCount`, `ctx`, `defer`, `defineUi`, `describeField`, `durationMs`, `escapeHtml`, `formErrors`, `isEmail`, `localPath`, `postedChecked`, `postedValue`, `postedValues`, `publicEnv`, `recipe`, `route`, `s`, `sanitizeHtml`, `trustHtml`, `uid`, `withBase` and `withQuery` from `kay` compute the same on both sides and keep a component static; every other value of `kay` needs the browser (state, effects, lifecycle, browser readings, navigation: `navigate`, `refresh`, `call` and `logFrom` among them), and so does `relativeTime` of `kay/i18n`.
- A namespace or default import of `kay` or `kay/i18n` (`import * as i18n from 'kay/i18n'`) always makes an island, as the compiler cannot tell which names the component reads through it: import the names (`import { formatDate } from 'kay/i18n'`) to keep a component static that only formats.
- An interactive component renders on the server and hydrates in the browser as an island.
- Everything else ships no JavaScript, except the small script swapping pages in on a page posting a form to an action, and elsewhere one line keeping Back right after a reload (see [Navigation](navigation.md#navigation)).
- Interactive components rendered inside an island are part of it.
- A button opens a popover or a dialog with no handler, so the component stays static: `button(popovertarget="menu")` toggles `ul#menu(popover)`, and `button(commandfor="settings" command="show-modal")` opens `dialog#settings`. `command` is `show-modal`, `close`, `request-close`, `show-popover`, `hide-popover`, `toggle-popover` or a `--custom` name the target hears as a `command` event, and `kay check` types it. `popovertarget` needs Chrome and Edge 114, Firefox 125, Safari 17; `commandfor` and `command` Chrome and Edge 135, Firefox 144, Safari 26.2, past the floor below, so an app keeping older browsers uses `popovertarget` or an `onClick`.
- kay's browser code runs on Chrome and Edge 98, Firefox 104 and Safari 16.4 or later; kayjs-ui's popovers, tooltips, toasts and site nav menu need the Popover API, Chrome and Edge 114, Firefox 125, Safari 17, and its popovers, tooltips and site nav lists sit beside their trigger through CSS anchor positioning, Chrome and Edge 129, Firefox 147, Safari 26, so an older browser opens them away from their trigger; its colours use `light-dark()` and its carousel `inert`, which every browser with anchor positioning has. Bun bundles an island's code as written, newer syntax and APIs included, so an app keeping those browsers stays off what they lack, such as `Map.groupBy` or `Promise.withResolvers`.
- `kay build` lists each island under its JavaScript with what makes it one, the first `on*`, `bind:`, `ref`, value from `kay`, `--- island` or `--- client` fence as `onClick, line 4`; `--format json` gives them as `why` and `cause` (`kind`, `name`, `line`) on each island of `built.sizes.islands` (a route's `islands` under `built.routes` only lists their files); `why` stays for tools reading it and `cause` is the data. `kay explain island <file>` says a component's role and cause and the rule, and `kay explain island` lists every island of the project (`--format json` for both).
- `kay check` reads from the types what a static component hands an island, not from how the call looks: a value typed as a function, a symbol, a class instance or an object holding one (a `Column` with a `sortValue` function), or a block with parameters, is the error `island-prop` at the prop, and a value that is data says nothing, an action, a Date, a list a `map` built, a call returning a string, nor does one typed `any` or `unknown`. `--- island` in place of `---` is the fix (`--- island <T>` for a generic one): `kay check --fix` writes it where the value is always a function, and only offers it where the type is a union holding one, as the component may be static on some pages. A page, layout or special page is never an island, so it passes the island data or goes through a component of its own. Rendering throws an `IslandPropsError` naming the prop and the same fix, as no component is made an island for what it passes. `--- static` pins the other way: anything that makes the component an island is the compile error `static-pin`, standing at the `on*`, import or call that does it, and a function it hands an island is `island-prop`. A pin on a page, layout or special page is `island-marker`, as they are never islands, and `--- static` on one says nothing. A `// kay-island` or `// kay-static` comment pins nothing: the fence line does. The editor shows a lens on a component's first line saying whether it is an island and why, and a click on it reveals the `on*`, import or fence that decides it; under `kay dev` the Islands tab of the dev tool shows the same cause on each island, from a `data-why` attribute on its slot that a production build never writes.
- A component the server renders per request inside an otherwise prerendered page, such as a form carrying a fresh token, is a server island instead: see [Server islands](server-islands.md#server-islands).

### Props to an island

- Props a static component passes to an island are serialized for the browser: plain objects and arrays, strings, numbers, booleans, `null` and `undefined`.
- Dates, Maps, Sets, bigints, URLs and RegExps arrive as themselves, and a value referenced twice arrives once.
- They go into the page as JSON in an attribute, quoted with whichever quote it holds fewer of; every page carries them, so pass what the island reads rather than a whole object it picks from.
- A `Snippet` prop (children and `@name` blocks without parameters) crosses; a `Snippet<[...]>` is a function and does not (below). Children and `@name` blocks without parameters pass from any static parent, a page or a layout included: the server renders them with the parent, as static markup the island shows where its template puts `slot` or the prop, and their code never reaches the browser.
- An island among those children is one of its own, hydrating by itself, and keeps its state when the island hides the block and shows it again, or moves it, since the island shows the same nodes each time.
- A block the island did not show on the server, or a client-only island's, travels in its props as markup and is built once shown.
- Text alone, as in `Label Save`, is a string prop like any other.
- The island cannot change what a block renders: one it calls with values takes parameters.
- A function, a `Snippet<[...]>` (a block with parameters or a local `snippet`), a class instance or a symbol cannot be serialized; an action is the exception, going as its URL ([actions](actions-from-islands.md#pass-an-action-to-a-component)).
- A `const` the script or server fence writes out as literals is sent as it is whatever type declares it, so `const columns: Column<Row>[] = [{ key: 'name', sortValue: true }]` passes to a `Table`; a value from an import or a call is checked by its type, and `kay check` names the function field it holds, `columns[].sortValue`.
- Props are written into the page source, so a field named like a secret (`passwordHash`, `token`, `apiKey`, `email`) is reported as `secret-prop`: pick the fields the island shows, or `// kay-allow secret-prop` for a public one.
- Its own props must then be serializable: a function one is the `island-prop` error where it is passed.
- A component whose imports reach no island never renders as one and gets no browser chunk of its own: what its script imports, server code included, reaches the browser only inside an island importing it.
- A page with a `--- server` fence or a layout cannot render as an island: `kay check` rejects a function or a class instance it passes one as `island-prop`, and rendering throws naming the prop; move that part to a component of its own.
- A static component that only islands render, directly or through other such components, renders inline with them, so it passes its interactive children anything; once a page, a layout or a script imports it too, its props to them are serialized again.

### Hydration

- An island hydrates as soon as the page loads, its chunks preloaded; `hydrate="load"` says so, as it is the default.
- `hydrate="idle"` waits until the browser is idle and `hydrate="visible"` until it scrolls near the viewport, neither preloaded (the page does preload the code that waits for them).
- A click, input or change on an island still loading is replayed once it hydrated and its effects ran, an island that never hydrates holding its last 50 events at most, one whose chunk fails to load dropping them, and a field's consecutive inputs or changes counting as one.
- `client: { hydration: { visible: '640px', serverIslands: '200% 0px' } }` in `kay.config.ts` sets how far ahead of the viewport a `visible` island and a deferred server island start loading, as CSS root margins; `'200px'` and `'100% 0px'`, a screen ahead, by default.
- Only an island takes `hydrate`, and only from a static parent.
- For a visitor asking for less data (`Save-Data: on`, `prefers-reduced-data`, `saveData: false` turning it off), an island with no `hydrate` hydrates as `visible` does: at once in view, else once it scrolls near, a click meanwhile replayed. `hydrate="load"`, `idle`, `visible` and `client` go as written, so `hydrate="load"` keeps an island that must work at once, and an island holding a form waits like any other. A deferred server island is fetched only once it nears the viewport, not when the browser is idle, and the `Save-Data` page preloads no chunk of an island that waits, only the entry's, the code waiting for the viewport and the chunks of its `hydrate="load"` and `client` islands (marked `data-load` in the page); a component used both ways on a page keeps its chunks, marked `data-wait` too, and still gets the waiting code preloaded.

Shared and persisted state, transitions, error fallbacks, element size, context and unique ids are in [Islands: state to unique ids](islands-state-to-ids.md).
