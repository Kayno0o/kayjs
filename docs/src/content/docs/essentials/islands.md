---
title: Islands
order: 6
description: Interactive components render on the server and hydrate in the browser, everything else ships no JavaScript bundle.
---

A component is an island when it is interactive: it has an `on*` handler, a `bind:`, a `ref`, or a script using `signal` or another value from `kay`. kay renders it on the server, then hydrates it in the browser. Static components ship nothing.

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

An island is for what reacts to the user in the browser. What only has to differ per request, such as a greeting or a stock count inside a prerendered page, needs no JavaScript: make it a [server island](/essentials/routing#server-islands), rendered on the server for each request.

## Signals, memos and effects

A signal is read by calling it, `count()`, and written by assigning it, `count++` or `open = !open()`, in the template as in the script. `memo` derives a value, `effect` runs after the render and again when a signal it read changes.

```kay
---
const names = ['Ada', 'Grace']
const query = signal('')
const matches = memo(() => names.filter(n => n.includes(query())))

effect(() => {
  document.title = `${matches().length} results`
})
---
input(bind:value={query} aria-label="Search")
p {matches().length} results
```

## Props to an island

Props a static parent passes are serialized for the browser: objects, arrays, strings, numbers, booleans, dates, maps and sets.

Children render on the server with the page, and the island shows them where its template has `slot`. An island among them hydrates on its own.

`src/components/collapsible.kay`:

```kay
---
const { title } = props<{ title: string }>()
const open = signal(false)
---
button(onClick={() => open.set(!open())}) {title}
if open()
  slot
```

`src/routes/index.kay`:

```kay
---
import Collapsible from '../components/collapsible.kay'
import Counter from '../components/counter.kay'
---
Collapsible(title="Details")
  p Rendered on the server, shown by the island.
  Counter
```

A function or a class instance cannot be serialized: a component passing one to an island becomes an island itself. A page or a layout with a `--- server` fence cannot, so `kay check` reports it: move that part to a component.

## When to hydrate

An island hydrates as soon as the page loads. Defer it with `hydrate` on its tag, from a static parent:

```kay
Comments(postId={post.id} hydrate="visible")
```

`hydrate="visible"` waits until it scrolls near the viewport, `hydrate="idle"` until the browser is idle. A click on an island still loading is replayed once it hydrates.

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. `src/cart.ts`:

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie the server reads too, so the first paint is right. `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as `?q=...`, so a filter survives a reload and a shared link. `{ storage: 'local' }` keeps it in localStorage, which the server never sees: every island reading it renders the default as it hydrates, then shows the kept value. Derive from it inside the island: a memo made outside one hands an island hydrating later the kept value, which its server markup does not hold.

`const current = queryParam<number>('page')` holds one param of the page's [query](/essentials/data-loading), typed as the page's `query` schema types it: `current.set(n => n + 1)` writes `?page=3`.

<Callout type="note">

Outside a component, a signal is written with `cart.set(...)`. A component writes any signal it holds in a `const`, an import or a `Signal<T>` prop by assigning it, `cart = []`, wherever the signal was made. Both read it by calling it, `{cart().length}`.

</Callout>

## Page navigation

A page with an island or a form swaps the next page in without a reload. An island marked `persist` lives on from page to page, so `Player(persist)` in a layout keeps a song playing. What the next page renders again stays as it is, so a sidebar keeps its scroll. Each swap focuses the new page's `autofocus` field, else its `h1`, else its `main`, and announces its title to screen readers; going back or forward skips the `autofocus` field, and keeps the focus where it is between entries of one path that differ by their query alone.

Go to a page from code with `navigate`:

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

`navigate({ query: { sort: 'name', page: null } })` changes the current page's query in place, keeping the scroll and the focus; a null or empty value drops its param.

A link with `data-reload` loads its page fully. So does every link to a page setting `reload: true` in its `page`. A page's own CSP sources and headers are set the same way, under `security` (see [Security headers](/llms/production#security-headers)).

## Browser-only code

kay's browser code runs on Chrome and Edge 98, Firefox 104 and Safari 16.4 or later, and kayjs-ui's popovers on Chrome and Edge 114, Firefox 125 and Safari 17. kayjs-ui places its popovers, tooltips and site nav lists beside their trigger through CSS anchor positioning, in Chrome and Edge 129, Firefox 147 and Safari 26: an older browser opens them away from their trigger. Its colours use `light-dark()` and its carousel `inert`, which every browser with anchor positioning has. The build ships an island's code as written, so code meant for those browsers stays off newer APIs such as `Map.groupBy`.

`window`, `document` and `localStorage` do not exist on the server. Read them in `onMount` or `effect`, which run in the browser only:

```kay
---
const width = signal(0)

onMount(() => {
  width.set(window.innerWidth)
})
---
p Window is {width()}px wide
```

A component that cannot render on the server at all, such as one wrapping a map library, starts its script fence with `--- client`. It renders in the browser only:

```kay
--- client
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map
```

`watch(source, (next, previous) => ...)` from `kay` runs whenever `source` changes, but not on its first read, so you need no variable of your own holding the old value. `debounced(source, ms)` gives `source`'s value once it has stopped changing for `ms` milliseconds: `watch(debounced(typed, 300), lookUp)` looks a name up when the user pauses typing.

`every(ms, run)` from `kay` runs `run` on a timer while the island lives: `every(1000, () => now = Date.now())` ticks a clock. `listen(window, 'keydown', event => ...)` listens to an event of `window` or `document` and removes the listener when the island ends.

<Callout type="warning">

Reading a browser global while the component renders throws on the server. `kay check` reports it.

</Callout>

## Keyboard shortcuts

`shortcut` from `kay` runs a function when keys are pressed, for as long as the island lives. `mod` is Cmd on macOS and Ctrl elsewhere, and `on` scopes the shortcut to one element, read once the island mounted:

```kay
---
import { shortcut } from 'kay'

let form: HTMLFormElement | undefined

function save(): void {
  form?.requestSubmit()
}

shortcut('mod+s', save, { on: () => form })
---
form(ref={element => form = element} onSubmit={event => event.preventDefault()})
  input(aria-label="Title")
```

Without `on` the shortcut binds the whole page. It cancels the browser's own action for the key, ignores IME composition and a held key, and does nothing on the server. A shortcut with `mod`, `ctrl`, `meta` or `alt` fires in a text field too, a bare key such as `/` or `arrowdown` only with `{ inputs: true }`, `escape` and the function keys aside. Of two bindings on one key the innermost wins. An element-scoped shortcut sets `aria-keyshortcuts` on its element.

## A page kay does not serve

A page bundled by something else, such as an HTML file `Bun.serve` imports, renders `.kay` components too. List `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, or pass `kay({ root })` from `kay/bun` to `Bun.build`, then render one with `mount` from `kay/mount`, which returns what disposes it:

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

A mount renders after what the element already holds, and disposing it removes only the nodes it rendered, so several components mounted into one element are disposed one at a time.

<ReadMore href="/llms/islands">Transitions, error fallbacks with `try`, context, `uid`, `guardLeave`, the options of `shortcut`, the edge cases of props and persisted state, and the navigation details are in the full islands reference.</ReadMore>
