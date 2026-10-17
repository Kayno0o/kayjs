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

A component is an island when it has an `on*` handler, a `bind:` or a `ref`, or when its script uses a value from `kay`, such as `signal`. The helpers `uid`, `describeField`, `sanitizeHtml` and `trustHtml` do not count: a component using only them stays static.

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

### Effects outside a component

An effect made while a component renders stops with the component. Code that runs elsewhere, such as a module that keeps a subscription, has no component to stop it. Wrap it in `root`, which gives it an owner of its own.

```ts
import { effect, onCleanup, root } from 'kay'

const stop = root((dispose) => {
  effect(() => {
    const timer = setInterval(poll, count())

    onCleanup(() => clearInterval(timer))
  })

  return dispose
})
```

The effect and its cleanups live until `stop()` is called, and `root` returns what its function returns.

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

`hydrate="load"`, the default, hydrates the island as soon as the page loads. `hydrate="visible"` waits until the island scrolls near the viewport. `hydrate="idle"` waits until the browser is idle.

A click on an island that is still loading is replayed once it hydrates, so the visitor loses nothing.

<ReadMore href="/llms/islands">How many events an island keeps while it loads, and when it drops them.</ReadMore>

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. This is `src/cart.ts`.

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie. The server reads the cookie too, so the first paint is right. The cookie lasts a year; pass `{ maxAge: '30d' }` for another time.

Pass `{ storage: 'query' }` to keep a string in the page's URL instead, as `?q=...`. A filter then survives a reload and a shared link.

Pass `{ storage: 'local' }` to use localStorage. The server never sees it, so every island reading it renders the default first, then shows the kept value.

Derive from a persisted value inside the island. A memo made outside one gives a late-hydrating island the kept value, which its server markup does not hold.

`queryParam<number>('page')` holds one param of the page's [query](/essentials/data-loading), typed by the page's `query` schema. `current.set(n => n + 1)` writes `?page=3`.

The address is written at most every 200 ms, so a fast-moving signal such as a slider may trail it. kay writes the last value before the page is left.

<Callout type="note">

Outside a component, write a signal with `cart.set(...)`. A component assigns it, `cart = []`, wherever the signal was made. Both read it by calling it, `{cart().length}`.

</Callout>

## Animate an element in and out

`transition="fade"` on the element a block shows plays the classes `fade-enter-*` and `fade-leave-*` as it comes and goes.

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

It works on the element of an `if` branch, a `for` row, a `try`'s `catch` or an `await` block. A leaving element stays until its transition ends.

Utility classes need no stylesheet. Give each phase its classes: `li(transition:enter="transition duration-200" transition:enter-from="opacity-0" transition:leave="transition duration-150" transition:leave-to="opacity-0")`.

To share them, export a preset typed `TransitionClasses` from `kay`, and pass it as `li(transition={fade})`.

```ts
import type { TransitionClasses } from 'kay'

export const fade: TransitionClasses = {
  enter: 'transition duration-200',
  enterFrom: 'opacity-0',
  leave: 'transition duration-150',
  leaveTo: 'opacity-0',
}
```

Visitors who ask for reduced motion see no animation. The server leaves the attributes out of the markup.

<ReadMore href="/llms/islands#transitions">Which element plays, what does not animate, and the errors for a wrong phase.</ReadMore>

## Hand a value down without props

`context(default)` from `kay` makes a value that a component gives to everything it renders, however deep.

```ts
// src/theme.ts
import { context } from 'kay'

export const Theme = context<'light' | 'dark'>('light')
```

A component provides it in its script.

```kay
---
import { Theme } from './theme'

Theme.provide('dark')
---
slot
```

Anything it renders reads it with `Theme.use()`. Without a provider above, `use()` gives the default.

```kay
---
import { Theme } from './theme'

const theme = Theme.use()
---
p(class={theme}) Themed
```

`use()` reads while the component renders, so read it once in the script. Provide a signal to share a value that changes.

An island reads nothing its page's static components provide. Provide inside the island instead.

## Tie a label to its control

`uid()` from `kay` gives an id unique on the page. It is the same on the server and in the browser, so `for` and `aria-controls` keep matching once the island hydrates.

```kay
---
import { uid } from 'kay'

const id = uid()
const open = signal(false)
---
button(aria-controls={id} aria-expanded={open()} onClick={() => open = !open()}) Details
if open()
  p(id={id}) More about it
```

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

`navigate('/todos', { scroll: 'keep' })` goes to the page without scrolling to the top, and `{ transition: false }` swaps it without a view transition. A link does the same with `data-keep-scroll` and `data-no-transition`, which an element around several links can carry.

A link with `data-reload` loads its page fully. So does every link to a page setting `reload: true` in its `page`.

### Ask before leaving unsaved changes

`guardLeave` from `kay` asks before the page is left while its function returns true.

```kay
---
import { guardLeave } from 'kay'

const draft = signal('')

guardLeave(() => draft() !== '')
---
textarea(bind:value={draft} aria-label="Draft")
```

Links, `navigate()` and back and forward wait for the answer. A reload or a closed tab gets the browser's own prompt. Pass `{ confirm: to => ... }` to ask with your own dialog, returning a boolean or a promise of one.

### Prefetching

The `prefetch` setting says when a page is fetched before a click: `moderate` on hover (the default), `conservative` on press, `eager` as soon as it can, `false` never.

A link that changes something on GET, such as a logout, takes `data-no-prefetch`.

```kay
a(href="/logout" data-no-prefetch) Sign out
```

### Forms and a full load

A form posting to an action posts without a reload and shows the page the post leads to. A refused post keeps the scroll and the typed values.

With `navigation: false` in `kay.config.ts`, every page loads fully and only pages with islands ship a script. A form then posts as the browser would, and names its page in a `kay_back` query parameter. A refused post renders that page again with the message, and one that goes through goes back to it.

<ReadMore href="/llms/navigation#navigation">How focus moves on back and forward, the other cases that load a page fully, and how a refused post focuses its field.</ReadMore>

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

`debounced(source, delay)` gives the value once it has stopped changing for `delay`, a duration such as `'300ms'`. `watch(debounced(typed, '300ms'), lookUp)` looks a name up when the user pauses typing.

`every(interval, run)` runs `run` on a timer while the island lives, `interval` being a duration such as `'1s'`. `every('1s', () => now = Date.now())` ticks a clock.

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

<ReadMore href="/llms/navigation">Which keys fire in a text field, how Shift and AltGr match, and the other options of `shortcut`.</ReadMore>

## A page kay does not serve

A page bundled by something else, such as an HTML file `Bun.serve` imports, can render `.kay` components too. List `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, or pass `kay({ root })` from `kay/bun` to `Bun.build`. Then render one with `mount` from `kay/mount`, which returns a function that removes it.

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

A mount renders after what the element already holds. Disposing it removes only its own nodes, so several components can share one element.

<ReadMore href="/llms/islands">The edge cases of props and persisted state, the options of `shortcut`, and the navigation details are in the full islands reference.</ReadMore>
