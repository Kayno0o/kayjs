---
title: Islands
order: 6
description: Interactive components render on the server and hydrate in the browser, everything else ships no JavaScript.
---

A component is an island when it is interactive: an element has an `on*` handler, a `bind:` or a `ref`, or its script uses `signal`, `memo`, `effect` or another value from `kay`. kay renders it on the server, then hydrates it in the browser. Static components ship nothing.

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count} times
```

## Signals, memos and effects

A signal is read by its name in the template and by calling it in the script, and written by assigning it, `count++` or `open = !open`, in both. `memo` derives a value, `effect` runs once the render is done and again when what it read changes.

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
p {matches.length} results
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

A function, a block with parameters or a class instance cannot be serialized: a component passing one to an island renders as an island itself. A layout or a page with a `--- server` fence cannot, so `kay check` reports it there: move that part to a component.

## When to hydrate

An island hydrates as soon as the page loads. Defer it with `hydrate` on its tag, from a static parent:

```kay
Comments(postId={post.id} hydrate="visible")
```

`hydrate="visible"` waits until it scrolls near the viewport, `hydrate="idle"` until the browser is idle.

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. `src/cart.ts`:

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie the server reads too, so the first paint is right. `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as `?q=...`, so a filter survives a reload and a shared link.

<Callout type="note">

Outside a component, a signal is read by calling it, `cart()`, and written with `cart.set(...)`. A component importing one its module exports as `export const` reads and writes it by name, `{cart}` and `cart = []`, as its own; a prop typed `Signal<T>` from `kay` does too.

</Callout>

## Page navigation

A page with an island or a form swaps the next page in without a reload. An island marked `persist` lives on from page to page, so `Player(persist)` in a layout keeps a song playing. What the next page renders again stays as it is, so a sidebar keeps its scroll. Go to a page from code with `navigate`:

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

`navigate({ query: { sort: 'name', page: null } })` changes the current page's query in place, keeping the scroll and the focus; a null or empty value drops its param.

## Browser-only code

`window`, `document` and `localStorage` do not exist on the server. Read them in `onMount` or `effect`, which run in the browser only:

```kay
---
const width = signal(0)

onMount(() => {
  width.set(window.innerWidth)
})
---
p Window is {width}px wide
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

<Callout type="warning">

Reading a browser global while the component renders throws on the server. `kay check` reports it and the editor offers the fix.

</Callout>

<ReadMore href="/llms/islands">Transitions, error fallbacks with `try`, context, `uid`, `guardLeave` and the navigation details are in the full islands reference.</ReadMore>
