---
title: Islands
order: 6
description: Interactive components render on the server and hydrate in the browser, everything else ships no JavaScript bundle.
---

An island is an interactive component. kay renders it on the server, then hydrates it in the browser. Every other component ships no JavaScript.

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

A component is an island when it has an `on*` handler, a `bind:` or a `ref`, or when its script uses a value from `kay`, such as `signal`. The helpers `uid`, `sanitizeHtml` and `trustHtml` do not count: a component using only them stays static.

An island is for what reacts to the user in the browser. A greeting or a stock count that only differs per request needs no JavaScript. Make it a [server island](/essentials/routing#server-islands) instead.

## Signals, memos and effects

Read a signal by calling it, `count()`. Write it by assigning it, `count++` or `open = !open()`, in the template or the script. `memo` derives a value. `effect` runs after the render, and again when a signal it read changes.

```kay
---
const names = ['Ada', 'Grace']
const query = signal('')
const matches = memo(() => names.filter(n => n.includes(query())))

effect(() => {
  localStorage.setItem('matches', String(matches().length))
})
---
input(bind:value={query} aria-label="Search")
p {matches().length} results
```

## See which components are islands

`kay build` lists every island under the JavaScript it ships. Each line gives the first thing that made it one, such as `onClick, line 4` or `bind:value, line 9`.

A static component that passes an island a function is listed too, as `format passed to Picker, line 8`. That prop may turn it into an island, which the page decides as it renders.

`kay build --format json` gives the same as `why` on each island of `built.sizes`, and on each route's `islands`.

## Props to an island

A static parent can pass an island objects, arrays, strings, numbers, booleans, dates, maps and sets. kay sends them to the browser.

Children render on the server with the page. The island shows them where its template has `slot`, and an island among them hydrates on its own.

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

A function or a class instance cannot be sent. A component passing one to an island becomes an island itself.

A page or a layout cannot become an island, so `kay check` reports it there. Move that part to a component.

## When to hydrate

An island hydrates as soon as the page loads. Put `hydrate` on its tag, in a static parent, to wait.

```kay
Comments(postId={post.id} hydrate="visible")
```

`hydrate="visible"` waits until the island scrolls near the viewport. `hydrate="idle"` waits until the browser is idle.

A click on an island that is still loading is replayed once it hydrates, so the visitor loses nothing.

<ReadMore href="/llms/islands">How many events an island keeps while it loads, and when it drops them.</ReadMore>

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. This is `src/cart.ts`.

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie. The server reads the cookie too, so the first paint is right.

Pass `{ storage: 'query' }` to keep a string in the page's URL instead, as `?q=...`. A filter then survives a reload and a shared link.

Pass `{ storage: 'local' }` to use localStorage. The server never sees it, so every island reading it renders the default first, then shows the kept value.

Derive from a persisted value inside the island. A memo made outside one gives a late-hydrating island the kept value, which its server markup does not hold.

`queryParam<number>('page')` holds one param of the page's [query](/essentials/data-loading), typed by the page's `query` schema. `current.set(n => n + 1)` writes `?page=3`.

The address is written at most every 200 ms, so a fast-moving signal such as a slider may trail it. kay writes the last value before the page is left.

<Callout type="note">

Outside a component, write a signal with `cart.set(...)`. A component assigns it, `cart = []`, wherever the signal was made. Both read it by calling it, `{cart().length}`.

</Callout>

## Page navigation

A page with an island or a form swaps the next page in without a reload.

An island marked `persist` lives on from page to page. `Player(persist)` in a layout keeps a song playing. What the next page renders again stays as it is, so a sidebar keeps its scroll.

Each swap moves focus to the new page's `autofocus` field, else its `h1`, else its `main`. It also announces the title to screen readers.

Go to a page from code with `navigate`.

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

`navigate({ query: { sort: 'name', page: null } })` changes the current page's query in place. The scroll and the focus stay, and a null or empty value drops its param.

A link with `data-reload` loads its page fully. So does every link to a page setting `reload: true` in its `page`.

<ReadMore href="/llms/islands#navigation">How focus moves on back and forward, and the other cases that load a page fully.</ReadMore>

## Browser-only code

kay's browser code runs on Chrome and Edge 98, Firefox 104 and Safari 16.4 or later. The build ships an island's code as written, so keep it off newer APIs such as `Map.groupBy` if you support those browsers.

kayjs-ui's popovers need Chrome and Edge 114, Firefox 125 or Safari 17. They sit beside their trigger through CSS anchor positioning, in Chrome and Edge 129, Firefox 147 and Safari 26. An older browser opens them away from the trigger.

`window`, `document` and `localStorage` do not exist on the server. Read them in `onMount` or `effect`, which run in the browser only.

```kay
---
const width = signal(0)

onMount(() => {
  width.set(window.innerWidth)
})
---
p Window is {width()}px wide
```

A component that cannot render on the server at all, such as one wrapping a map library, starts its script fence with `--- client`. It renders in the browser only.

```kay
--- client
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map
```

`watch(source, (next, previous) => ...)` from `kay` runs whenever `source` changes, but not on its first read. You need no variable holding the old value.

`debounced(source, ms)` gives the value once it has stopped changing for `ms` milliseconds. `watch(debounced(typed, 300), lookUp)` looks a name up when the user pauses typing.

`every(ms, run)` runs `run` on a timer while the island lives. `every(1000, () => now = Date.now())` ticks a clock.

`listen(window, 'keydown', event => ...)` listens to an event of `window` or `document`. It removes the listener when the island ends.

<Callout type="warning">

Reading a browser global while the component renders throws on the server. `kay check` reports it.

</Callout>

## Keyboard shortcuts

`shortcut` from `kay` runs a function when keys are pressed, for as long as the island lives. `mod` is Cmd on macOS and Ctrl elsewhere. `on` scopes the shortcut to one element.

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

Without `on` the shortcut binds the whole page. It cancels the browser's own action for the key and does nothing on the server.

A shortcut with `mod`, `ctrl`, `meta` or `alt` also fires in a text field. A bare key such as `/` fires there only with `{ inputs: true }`. Of two bindings on one key, the innermost wins.

<ReadMore href="/llms/islands">Which keys fire in a text field, how Shift and AltGr match, and the other options of `shortcut`.</ReadMore>

## A page kay does not serve

A page bundled by something else, such as an HTML file `Bun.serve` imports, can render `.kay` components too. List `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, or pass `kay({ root })` from `kay/bun` to `Bun.build`. Then render one with `mount` from `kay/mount`, which returns a function that removes it.

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

A mount renders after what the element already holds. Disposing it removes only its own nodes, so several components can share one element.

<ReadMore href="/llms/islands">Transitions, error fallbacks with `try`, context, `uid`, `guardLeave`, the options of `shortcut`, the edge cases of props and persisted state, and the navigation details are in the full islands reference.</ReadMore>
