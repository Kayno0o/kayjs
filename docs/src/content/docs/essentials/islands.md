---
title: Islands
order: 6
description: Interactive components render on the server and hydrate in the browser, everything else ships no JavaScript bundle.
---

A component is an island when it is interactive: an element has an `on*` handler, a `bind:` or a `ref`, or its script uses `signal`, `memo`, `effect` or another value from `kay`. kay renders it on the server, then hydrates it in the browser. Static components ship nothing.

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

## Signals, memos and effects

A signal is read by calling it, `count()`, and written by assigning it, `count++` or `open = !open()`, in the template as in the script. `memo` derives a value, `effect` runs once the render is done and again when what it read changes.

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

Children and `@name` blocks render on the server with the page, and the island shows them where its template has `slot` or the prop. An island among them hydrates on its own, and keeps its state when the outer one hides them and shows them again.

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

A function, a block with parameters or a class instance cannot be serialized: a component passing one to an island renders as an island itself. A layout or a page with a `--- server` fence cannot, so `kay check` reports it there: move that part to a component. It looks inside a literal array or object for what cannot be sent, so a generic component still types the literal from its other props. A component whose imports reach no island never renders as one, so it gets no browser chunk of its own: what its script imports, server code included, reaches the browser only inside an island importing it.

## When to hydrate

An island hydrates as soon as the page loads. Defer it with `hydrate` on its tag, from a static parent:

```kay
Comments(postId={post.id} hydrate="visible")
```

`hydrate="visible"` waits until it scrolls near the viewport, `hydrate="idle"` until the browser is idle. A click, input or change on an island still loading is replayed once it hydrated and its effects ran.

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. `src/cart.ts`:

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie the server reads too, so the first paint is right. `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as `?q=...`, so a filter survives a reload and a shared link: it is `queryParam('q')`, below, with `''` as its default, which a write leaves out of the URL. On a page whose `query` schema names the param, the signal reads it as the schema does, typed to match, as in `persisted<number>('page', 1, { storage: 'query' })`, and a param left out reads the schema's default before the value given, so the island and the page's loads agree.

`const current = queryParam<number>('page')` holds one param of the page's [query](/essentials/data-loading), typed and read as the page's `query` schema reads it: `current.set(n => n + 1)` writes `?page=3`, and the schema's default leaves the param out. A value the schema refuses reads as the default.

<Callout type="note">

Outside a component, a signal is written with `cart.set(...)`. A component importing one its module exports as `export const` also writes it by assigning it, `cart = []`, as its own; so does a prop typed `Signal<T>` from `kay`. Both read it by calling it, `{cart().length}`.

</Callout>

## Page navigation

A page with an island or a form swaps the next page in without a reload. An island marked `persist` lives on from page to page, so `Player(persist)` in a layout keeps a song playing, and a field focused inside it keeps its focus through a swap that keeps it, as a refresh does, a text field, `textarea` or `contenteditable` its caret and selection too. What the next page renders again stays as it is, so a sidebar keeps its scroll. In the head and on `<html>` and `<body>`, what the server served changes as the next page serves it, and what a script changed or added stays: a theme toggle's `theme-color`, a tag a loader added, a class put on `<body>`, though a served head tag a script removed comes back with the next page serving it. A page without kay's script still goes Back to a swapped page after a reload, through one line of script, which leaves any entry your app pushed itself to the app. Go to a page from code with `navigate`:

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

`navigate({ query: { sort: 'name', page: null } })` changes the current page's query in place, keeping the scroll and the focus; a null or empty value drops its param.

A link with `data-reload` loads its page fully. So does every link to a page whose `page` sets `reload: true`, and to a page whose cross-origin isolation differs from the current one, since a document cannot change it in place, though a link to that same page with another query, or a refresh, still swaps it:

```kay
--- server
export const page = {
  security: {
    csp: { 'script-src': ['https://cdn.example.com'] },
    headers: { 'cross-origin-embedder-policy': 'require-corp' },
  },
}
---
h1 Emulator
```

`security` adds CSP sources to the site's directives and merges headers over its own, for this page's responses alone, or every page under a layout setting it. It only adds: a page's `'none'` cannot tighten what the site allows, and `'script-src': false` blocks kay's inline scripts, hydration with them. `kay build --static` drops it, and `reload`, as no server sends them.

## Browser-only code

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

`every(ms, run)` from `kay` runs `run` on a timer while the island lives, never on the server, `{ while }` starts and stops it as a condition turns, and `{ immediate: true }` runs it as it starts too: `every(3000, refresh, { while: () => issuing })` polls the page until nothing is issuing, `every(1000, () => now = Date.now())` ticks a clock. `listen(window, 'keydown', event => ...)` listens to an event of `window` or `document` the same way, its handler typed by the target's events and its listener removed when the island ends.

<Callout type="warning">

Reading a browser global while the component renders throws on the server. `kay check` reports it and the editor offers the fix.

</Callout>

## A page kay does not serve

A page bundled by something else, such as an HTML file `Bun.serve` imports, renders `.kay` components too. List `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, or pass `kay({ root })` from `kay/bun` to `Bun.build`, then render one with `mount` from `kay/mount`, which returns what disposes it:

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

<ReadMore href="/llms/islands">Transitions, error fallbacks with `try`, context, `uid`, `guardLeave` and the navigation details are in the full islands reference.</ReadMore>
