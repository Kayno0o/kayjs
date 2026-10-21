# Islands

## Common tasks

### Make a component interactive

A handler, a `bind:`, a `ref` or a signal makes it an island: it renders on the server and hydrates in the browser.

```kay
---
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
button(onClick={() => cart.set([...cart(), name])}) Add {name}
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

### Animate an element in and out

`transition="fade"` plays the classes `fade-enter-*` and `fade-leave-*` as a block shows and hides it:

```kay
---
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

A `context` from `kay`, provided by a component and used by anything it renders:

```ts
// src/theme.ts
import { context } from 'kay'

export const Theme = context<'light' | 'dark'>('light')
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
import { uid } from 'kay'

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

## Reference

### Islands

- A component is interactive when any element in it has an `on*` handler, a `bind:` or a `ref`, or when its script uses a value from `kay`, such as `signal`, imported or not.
- `uid`, `describeField`, `sanitizeHtml`, `trustHtml` and `defer` from `kay` keep a component static.
- An interactive component renders on the server and hydrates in the browser as an island.
- Everything else ships no JavaScript, except the small script swapping pages in on a page posting a form to an action, and elsewhere one line keeping Back right after a reload (see [Navigation](navigation.md#navigation)).
- Interactive components rendered inside an island are part of it.
- A button opens a popover or a dialog with no handler, so the component stays static: `button(popovertarget="menu")` toggles `ul#menu(popover)`, and `button(commandfor="settings" command="show-modal")` opens `dialog#settings`. `command` is `show-modal`, `close`, `request-close`, `show-popover`, `hide-popover`, `toggle-popover` or a `--custom` name the target hears as a `command` event, and `kay check` types it. `popovertarget` needs Chrome and Edge 114, Firefox 125, Safari 17; `commandfor` and `command` Chrome and Edge 135, Firefox 144, Safari 26.2, past the floor below, so an app keeping older browsers uses `popovertarget` or an `onClick`.
- kay's browser code runs on Chrome and Edge 98, Firefox 104 and Safari 16.4 or later; kayjs-ui's popovers, tooltips, toasts and site nav menu need the Popover API, Chrome and Edge 114, Firefox 125, Safari 17, and its popovers, tooltips and site nav lists sit beside their trigger through CSS anchor positioning, Chrome and Edge 129, Firefox 147, Safari 26, so an older browser opens them away from their trigger; its colours use `light-dark()` and its carousel `inert`, which every browser with anchor positioning has. Bun bundles an island's code as written, newer syntax and APIs included, so an app keeping those browsers stays off what they lack, such as `Map.groupBy` or `Promise.withResolvers`.
- `kay build` lists each island under its JavaScript with what makes it one, the first `on*`, `bind:`, `ref`, value from `kay` or `--- client` fence as `onClick, line 4`, and a static component that may render as one with the prop it passes an island, `format passed to Picker, line 8`, as `static unless it passes an island what only an island sends`; `--format json` gives them as `why` and `promoted` on `built.sizes.islands` and each route's `islands` under `built.routes`.
- A component the server renders per request inside an otherwise prerendered page, such as a form carrying a fresh token, is a server island instead: see [Server islands](prerendering.md#server-islands).

### Props to an island

- Props a static component passes to an island are serialized for the browser: plain objects and arrays, strings, numbers, booleans, `null` and `undefined`.
- Dates, Maps, Sets, bigints, URLs and RegExps arrive as themselves, and a value referenced twice arrives once.
- They go into the page as JSON in an attribute, quoted with whichever quote it holds fewer of; every page carries them, so pass what the island reads rather than a whole object it picks from.
- Children and `@name` blocks without parameters pass from any static parent, a page or a layout included: the server renders them with the parent, as static markup the island shows where its template puts `slot` or the prop, and their code never reaches the browser.
- An island among those children is one of its own, hydrating by itself, and keeps its state when the island hides the block and shows it again, or moves it, since the island shows the same nodes each time.
- A block the island did not show on the server, or a client-only island's, travels in its props as markup and is built once shown.
- Text alone, as in `Label Save`, is a string prop like any other.
- The island cannot change what a block renders: one it calls with values takes parameters.
- A function, a block with parameters, a class instance or a symbol cannot be serialized; an action is the exception, going as its URL ([actions](actions-from-islands.md#pass-an-action-to-a-component)).
- Props are written into the page source, so a field named like a secret (`passwordHash`, `token`, `apiKey`, `email`) is reported as `secret-prop`: pick the fields the island shows, or `// kay-allow secret-prop` for a public one.
- A static component passing one to an island renders as an island itself, decided as it renders, its own props serialized instead: a component rendering `Picker(format={shout})` hydrates whole, while one passing only data stays static and ships nothing.
- Its own props must then be serializable, else the component rendering it renders as an island in turn.
- A component whose imports reach no island never renders as one and gets no browser chunk of its own: what its script imports, server code included, reaches the browser only inside an island importing it.
- A page with a `--- server` fence or a layout cannot render as an island: `kay check` rejects a function or a class instance it passes one, as it does where the compiler cannot see a component passing one, and rendering throws naming the prop; move that part to a component of its own.
- A static component that only islands render, directly or through other such components, renders inline with them, so it passes its interactive children anything; once a page, a layout or a script imports it too, its props to them are serialized again.

### Hydration

- An island hydrates as soon as the page loads, its chunks preloaded; `hydrate="load"` says so, as it is the default.
- `hydrate="idle"` waits until the browser is idle and `hydrate="visible"` until it scrolls near the viewport, neither preloaded (the page does preload the code that waits for them).
- A click, input or change on an island still loading is replayed once it hydrated and its effects ran, an island that never hydrates holding its last 50 events at most, one whose chunk fails to load dropping them, and a field's consecutive inputs or changes counting as one.
- `hydration: { visible: '640px', serverIslands: '200% 0px' }` in `kay.config.ts` sets how far ahead of the viewport a `visible` island and a deferred server island start loading, as CSS root margins; `'200px'` and `'100% 0px'`, a screen ahead, by default.
- Only an island takes `hydrate`, and only from a static parent.
- For a visitor asking for less data (`Save-Data: on`, `prefers-reduced-data`, `saveData: false` turning it off), an island with no `hydrate` hydrates as `visible` does: at once in view, else once it scrolls near, a click meanwhile replayed. `hydrate="load"`, `idle`, `visible` and `client` go as written, so `hydrate="load"` keeps an island that must work at once, and an island holding a form waits like any other. A deferred server island is fetched only once it nears the viewport, not when the browser is idle, and the `Save-Data` page preloads no chunk of an island that waits, only the entry's, the code waiting for the viewport and the chunks of its `hydrate="load"` and `client` islands (marked `data-load` in the page).

### Shared and persisted state

- A signal a `.ts` module exports is one state for every island of the page that imports it: `export const cart = signal<Item[]>([])` in `src/cart.ts`, read by a header badge and written by a product's button.
- On the server a module outlives the request, so a value a page's, a layout's or an island's script writes to such a signal while the page renders, as `cart.set(items)` seeding it from props, holds for that request only, and everything rendered after it reads it.
- A module's `memo` is computed afresh on each read on the server.
- `persisted('theme', 'light')` from `kay` is a signal that keeps its value across pages and visits in a cookie named `theme`, which the server reads too, so a page rendered for the request shows the kept value from the first paint, and answers with `Vary: Cookie`.
- A page `kay build` prerendered renders a `persisted` signal's default, and the island corrects it as it hydrates.
- The cookie is named as it is given, so it never reuses the name of a cookie the app sets itself.
- `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as the query param `q`, which the server reads too, so a page rendered for `?q=kay` shows it from the first paint.
- It is `queryParam('q')` below with the value given as its default: a write takes the current history entry's place, keeping `history.state`, and that value, like the schema's default, leaves the param out.
- It holds a string unless typed otherwise: `persisted<'site' | 'logs'>('tab', 'site', { storage: 'query' })` narrows it, but the URL may hold any text, so check it before relying on it.
- On a page whose `query` schema names the param, it is read as the schema reads it, so `persisted<number>('page', 1, { storage: 'query' })` holds a number, and a param left out reads the schema's default before the value given, as the page's loads do.
- `queryParam<number>('page')` from `kay` is a signal holding one query param of the page, read as the page's `query` schema reads `ctx.query` (see routing): a number, a boolean, one of an enum, a list from a repeated param, the schema's `default` when the param is left out.
- The server writes the schema's rules for its params into the page, which the island reads them by, so an island works on any page and Elysia's `t` never reaches the browser; the server renders the same value from the first paint.
- A value the rules refuse reads as the default rather than throwing.
- A `queryParam` write takes the current history entry's place, a list as the param repeated, the default, `undefined` or blank text leaving the param out.
- A `queryParam`'s URL write trails the signal by at most 200 ms while it changes fast (a slider), all params sharing one throttled write, since browsers refuse too many history writes; the signal is always current, and pending writes land before a page swap, `navigate()`, a reload or the page being hidden.
- The type argument is the island's to give, defaulting to `string | undefined`; on a page whose schema names no such param, the value is its text.
- `persisted('draft', '', { storage: 'local' })` keeps it in localStorage instead, which the server never sees: the page renders the default, and each island reading it hydrates on the default too, then shows the kept value, one hydrating later, once visible or on the next page, included. A memo over it made outside an island holds the kept value by then, so an island hydrating later derives from the signal itself. It suits what the first paint does not show.
- A persisted value crosses as island props do, Dates, Maps and Sets included.
- A cookie value over about 3.8 KB encoded is not kept, with a warning; one written by another version of the app, or by hand, that does not decode leaves the default.
- A value that decodes is not checked against the signal's type, unless the signal names the values it offers: `persisted('theme', 'light', { values: ['light', 'dark'] })` reads a stale or hand-edited cookie holding anything else as the default, on the server and in the browser, for a cookie or `local` storage; the signal is typed as their union, and a default outside them is a type error. Without `values`, a value whose shape the code relies on is checked before use.
- The cookie is `SameSite=Lax`, for the site's mount point, kept a year unless `maxAge` says otherwise (`persisted('theme', 'light', { maxAge: '30d' })`, a `Duration`, cookie storage only), and `Secure` over https.

### Transitions

- `transition="fade"` on the element an `if` branch, a `for` row, a `for`'s `else`, a `try`'s `catch` or an `await` block shows animates it in as the block shows it and out before the block takes it away, as Vue's `<Transition>` does, with CSS alone.
- Entering, the element gets `fade-enter-from` and `fade-enter-active`, then from the next frame `fade-enter-to` in place of `fade-enter-from`, and loses them all once the longest transition or animation they start has run.
- Leaving goes the same way with `fade-leave-`, then removes the element.
- The rest of the block changes at once: a row taken out of a `for` stays where it was while it leaves, and a row added plays in where it goes.
- What leaves stays while what takes its place enters: the last rows of a `for` and its `else`, either way round.
- Each phase takes classes of its own too, so Tailwind's utilities need no stylesheet: `li(transition:enter="transition duration-200" transition:enter-from="opacity-0" transition:leave="transition duration-150" transition:leave-to="opacity-0")`.
- `transition:enter` and `transition:leave` hold for the whole phase, `-from` for its first frame and `-to` after it; they add to the named classes when `transition` names some.
- Elements animating alike share their classes through a preset: a module exports `export const fade: TransitionClasses = { enter: 'transition duration-200', enterFrom: 'opacity-0', leave: 'transition duration-150', leaveTo: 'opacity-0' }`, `TransitionClasses` from `kay`, and `li(transition={fade})` plays it.
- The `transition:` attributes add to a preset's classes, and Tailwind finds them in the module as it scans the app's files.
- Only the element a block shows plays: the first element of its branch or row, or the root of a component it renders.
- What renders with the island, or with the first render of a block, shows as it is, and a row moving to another place in the list does not play.
- A visitor asking for reduced motion (`prefers-reduced-motion: reduce`) gets no phase at all: elements come and go at once, as they do in a hidden tab, which draws no frames.
- It plays in islands only, the server leaving the attributes out of the markup.
- `transition` on a component is an error, as is an unknown phase such as `transition:out`.

### Error fallbacks

- A `try` block renders its `catch` block instead when what it renders throws, so one broken widget does not take the page down. It works in any template.
- On the server, a block that throws renders `catch`, and the error goes to the log and `onError` like any render error, the page answering 200.
- Without `try`, a render error fails the page as before.
- In an island, a block that throws while it hydrates, or later as a signal it reads changes, renders `catch` in its place, its effects disposed.
- The error is logged and sent to the server, where `onError` gets it as a `BrowserError` from `kay/server`, with `kind`, the error's own name such as `TypeError`, `message`, `stack`, the page's `url`, its path without query or hash, and `island`, the island's component path, when known.
- What a browser reports is anyone's text, so its control characters become spaces before it is logged or reaches `onError`, the stack keeping only its line breaks.
- A `kay build --static` export has no server to send it to, so there it is logged only.
- A block the server rendered `catch` for keeps that markup as it came, since the error stayed on the server.
- `catch` takes the error under a name or none, typed `unknown`.
- A `try` without `catch` renders nothing when it throws.
- On the server, what a block that threw set in the page's `head`, an island's title included, goes with it: the page serves the title of an island it rendered, or its own.
- An error no `try` catches in the browser, from an effect, a handler or a promise nobody awaited, is reported the same way.
- An island whose script throws as it hydrates keeps its server markup, lifeless.
- In production the stack arrives mapped: `kay build` keeps the browser build's source maps beside `dist`, pointed at `.kay` lines and never served, and the server maps each frame of a report with them, so `onError` reads `src/routes/cart.kay:12:7` rather than a minified chunk. A frame of a chunk with no map stays as the browser wrote it. An executable made by `kay build --compile` embeds the maps zstd-compressed and reads one when a report first needs it, and a `kay build --static` export has no server.
- The browser sends at most 10 distinct errors per page load, leaving out another origin's scripts, whose details it hides.
- The server takes 20 reports a minute per client, refusing another site's and any over 16 KB.

### Element size

- `elementSize()` from `kay`, called in an island's script, returns `{ ref, width, height }`: pass `ref` to the element as `ref={column.ref}`, and `column.width()` and `column.height()` read its content box in pixels, following every resize.
- Both are 0 on the server and until the browser has measured the element, so the first paint of a size-dependent drawing is empty.
- An element rendered later, as inside an `if`, is observed from then on, the one it replaces dropped; the observer goes with the island.
- Give `ref` to one element: two elements sharing it follow the last, and one removed by an `if` with no `else` stays observed until the island goes.
- To keep the element too, a `ref` calls both: `ref={element => { box = element; size.ref(element) }}`.

### Context

- `context(defaultValue)` from `kay` makes a value a component hands everything it renders, however deep, without passing it through each one's props.
- A component's script calls `Theme.provide('dark')`, and any component it renders, its children and their blocks included, reads `Theme.use()`.
- A component beside the provider, or above it, reads the nearest value provided above itself, else the default.
- Provide a signal to share a value that changes.
- `use()` reads while a component renders: a handler or a timer calls it with nothing above, getting the default, so the script reads it once and keeps it.
- A layout's provide reaches its page.
- An island reads nothing the page's static components provide, in the browser as on the server, since it hydrates on its own: provide inside the island.

### Unique ids

- `uid()` from `kay` gives a component an id unique on the page, for tying a label to its control or a trigger to its popup, with no `id` prop to pass.
- One per call, made once per component instance as its script runs, rows of a `for` included.
- An island draws the same ids in the browser as the server wrote, so `for`, `aria-controls` and `id` match once it hydrates.
- Importing `uid` alone keeps a component static.
- The ids of a page differ from one render to the next, so a test reads them off the markup rather than writing them, and a prerendered page that revalidates gets a new ETag each time.
- A `try` whose block fails on the server draws its `catch` block's ids apart, so the ids after it match the browser's, which keeps the server's markup there.
- `describeField(ids, { required })` from `kay`, called in a component's script, adds `ids` to the `aria-describedby` of the first `input`, `select` or `textarea` the component renders on the server, its slot included, after the field's own ids and a refused field's message, so a form field ties the control its parent writes to its hint and message; a field with a spread keeps it too, and a `hidden`, `submit`, `button`, `reset` or `image` input is skipped whether its `type` is written or an expression; in an island the ids stay as the field turns refused and valid again, kay adding and removing the message alone. `required: true` also writes `aria-required="true"` on that first field, `required: 'all'` on each field the component renders, none overriding an `aria-required` the field writes itself.
- It acts on the server's markup alone: inside an island, the browser keeps such a link itself as the messages change. Importing it keeps a component static.
