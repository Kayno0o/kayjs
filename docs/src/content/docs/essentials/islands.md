---
title: Islands
order: 6
description: Interactive components render on the server and hydrate in the browser, everything else ships no JavaScript bundle.
---
An island is an interactive component. kay renders it on the server, then hydrates it in the browser. Every other component ships no JavaScript.

```kay
---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

A component is an island when its own code needs the browser: an `on*` handler, a `bind:` or a `ref` in its template, a browser value of `kay` such as `signal` in its script, or a `--- island` or `--- client` fence line. The compiler decides it from the file and its imports, and nothing a component passes makes it one.

The helpers that compute the same on both sides do not count: `ActionError`, `ActionRedirectError`, `ApiError`, `apiUrl`, `byteCount`, `ctx`, `defer`, `defineUi`, `describeField`, `durationMs`, `escapeHtml`, `formErrors`, `isEmail`, `localPath`, `postedChecked`, `postedValue`, `postedValues`, `publicEnv`, `recipe`, `route`, `s`, `sanitizeHtml`, `trustHtml`, `uid`, `withBase` and `withQuery` keep a component static.

A namespace or default import of `kay` or `kay/i18n` (`import * as i18n from 'kay/i18n'`) always makes an island, so import the names you use instead.

An island is for what reacts to the user in the browser. A greeting or a stock count that only differs per request needs no JavaScript. Make it a [server island](/essentials/routing#server-islands) instead.

## Signals, memos and effects

Read a signal by calling it, `count()`. Write it by assigning it, `count++` or `open = !open()`, in the template or the script. `memo` derives a value. `effect` runs after the render, and again when a signal it read changes.

```kay
---
import { signal, memo, effect } from 'kay'

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

An effect made with no owner, at the top of a module, after an `await` or in a timer, is never stopped, and an `onCleanup` there is dropped. In development kay logs a warning naming the call, once. A function an effect returns runs as its cleanup, so `effect(() => { const timer = setInterval(poll, 1000); return () => clearInterval(timer) })` needs no `onCleanup`.

## See which components are islands

`kay build` lists every island under the JavaScript it ships. Each line gives the first thing that made it one, such as `onClick, line 4` or `bind:value, line 9`.

A static component that passes an island a function is listed too, as `format passed to Picker, line 8`. That prop may turn it into an island, which the page decides as it renders, and which stops working in 1.95.

`kay check` reads what a component passes an island from its types. A value typed as a function, a symbol, a class instance or an object holding a function (a `Column` with a `sortValue`), or a block with parameters, cannot be sent to the browser: it is the error `island-prop` at that prop, naming the field.

A component the build still promotes to an island for it gets the deprecation `promoted-island` instead, with the same fix. An action, a Date, a list built by `map` or a call returning a string is data and says nothing, nor does a value typed `any` or `unknown`.

`--- island` is the fix, applied by `kay check --fix` where the value is always a function and offered where its type is a union holding one, as the component may be static on some pages. A page, a layout or a special page is never an island: pass the island data, or go through a component of its own. When the check was skipped, rendering throws an `IslandPropsError` naming the prop and the same fix.

Write `--- island` in place of `---` to say it is meant. The component is then an island on every page that renders it, with no promotion to decide. A generic one reads `--- island <T extends Row>`.

Write `--- static` to say it is not. If anything in the component would make it an island, an `onClick` or a `signal`, `kay check` and `kay build` stop with the error `static-pin` at that line, naming what it is. A pinned component is never promoted, so a function it hands an island is `island-prop`. A pin does not change what a page, a layout or a special page is: they are never islands, and `--- island` on one is reported as `island-marker`.

The comments `// kay-island` and `// kay-static` on a line of their own still work for a few minors. `kay upgrade` writes them as the fence lines, and `island-comment` warns of the old form until then.

The editor shows a lens on the first line of a component saying whether it is an island and why. A click on it shows the line that decides it.

`kay build --format json` gives the same as `why` on each island of `built.sizes`, with its `cause` (`kind`, `name` and `line`) as data.

`kay explain island src/components/counter.kay` prints the role of one component, what decides it and the rule. `kay explain island` lists every island of the project. Both take `--format json`.

## Props to an island

A static parent can pass an island objects, arrays, strings, numbers, booleans, dates, maps and sets. kay sends them to the browser.

A `const` written out as literals in the page's script is sent whatever type declares it, so a `Column<Row>[]` of `sortValue: true` passes to a `Table`. A value from an import or a call is checked by its type, and `kay check` names the function field it holds.

They travel in the page as JSON in an attribute. Every byte counts on every page, so pass an island what it reads rather than a whole object it picks from.

Children render on the server with the page. The island shows them where its template has `slot`, and an island among them hydrates on its own.

`src/components/collapsible.kay`:

```kay
---
import { signal } from 'kay'

const { title } = props<{ title: string }>()
const open = signal(false)
---
button(onClick={() => open = !open()}) {title}
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

A function or a class instance cannot be sent. A static component passing one to an island is the error `island-prop`: write `--- island` on it. Until 1.95 the build still promotes such a component on its own, which `promoted-island` reports.

A page or a layout cannot become an island, so `kay check` reports it there. Move that part to a component.

## When to hydrate

An island hydrates as soon as the page loads. Put `hydrate` on its tag, in a static parent, to wait.

```kay
Comments(postId={post.id} hydrate="visible")
```

`hydrate="load"`, the default, hydrates the island as soon as the page loads. `hydrate="visible"` waits until the island scrolls near the viewport. `hydrate="idle"` waits until the browser is idle. A page with such an island, or with a deferred server island, loads the code that does the waiting along with the page, so it is ready sooner.

`client: { hydration: { visible: '640px' } }` in `kay.config.ts` changes how early that is, `200px` before the viewport by default, and `client.hydration.serverIslands` does the same for a deferred server island, a screen ahead by default. Both are CSS root margins.

A click on an island that is still loading is replayed once it hydrates, so the visitor loses nothing.

A visitor who asks for less data (`Save-Data: on` or `prefers-reduced-data`) gets islands that wait by themselves. One with no `hydrate` hydrates at once when it is in view, and once it scrolls near when it is not. Write `hydrate="load"` on an island that must work at once, a form included. `hydrate="idle"`, `hydrate="visible"` and `hydrate="client"` go as written. A deferred server island is fetched only when it nears the viewport. `saveData: false` in the config turns this off.

<ReadMore href="/llms/islands">How many events an island keeps while it loads, and when it drops them.</ReadMore>

## Shared and persisted state

A signal exported from a `.ts` module is one state for every island on the page that imports it. This is `src/cart.ts`.

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

`persisted` keeps its value across pages and visits in a cookie. The server reads the cookie too, so the first paint is right. The cookie lasts a year; pass `{ maxAge: '30d' }` for another time.

A cookie can hold a value your app never offers, after an old release or an edit by hand. Name the values the signal may hold, and anything else reads as the default, on the server and in the browser: `persisted('theme', 'light', { values: ['light', 'dark'] })`. The signal is then typed `'light' | 'dark'`, and a default outside them is a type error.

A param kept in the URL takes `values` too: `persisted('tab', 'site', { storage: 'query', values: ['site', 'logs'] })`; a number or a boolean in `values` is compared with what the page's `query` schema reads, so it needs one.

Pass `{ storage: 'query' }` to keep a string in the page's URL instead, as `?q=...`. A filter then survives a reload and a shared link.

Pass `{ storage: 'local' }` to use localStorage. The server never sees it, so every island reading it renders the default first, then shows the kept value.

Islands that persist the same name share one signal, so a change in one shows in the others at once, and in other tabs of the browser too: through the `storage` event for `local`, a broadcast channel for a cookie. `{ sync: false }` keeps a call's signal on its own.

Derive from a persisted value inside the island. A memo made outside one gives a late-hydrating island the kept value, which its server markup does not hold.

`queryParam<number>('page')` holds one param of the page's [query](/essentials/data-loading), typed by the page's `query` schema. `current.set(n => n + 1)` writes `?page=3`. A write takes the current history entry's place; `queryParam<number>('page', { history: 'push' })` adds an entry for each write instead, so Back and Forward step through the pages and the signal follows.

The address is written at most every 200 ms, so a fast-moving signal such as a slider may trail it. kay writes the last value before the page is left.

<Callout type="note">

Outside a component, write a signal with `cart.set(...)`. A component assigns it, `cart = []`, wherever the signal was made. Both read it by calling it, `{cart().length}`.

</Callout>

## Animate an element in and out

`transition="fade"` on the element a block shows plays the classes `fade-enter-*` and `fade-leave-*` as it comes and goes.

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

<ReadMore href="/llms/islands-state-to-ids#transitions">Which element plays, what does not animate, and the errors for a wrong phase.</ReadMore>

## Hand a value down without props

`createContext(default)` from `kay` makes a value that a component gives to everything it renders, however deep.

```ts
// src/theme.ts
import { createContext } from 'kay'

export const Theme = createContext<'light' | 'dark'>('light')
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

`uid()` from `kay` gives an id unique on the page. It is the same on the server and in the browser, so `for` and `aria-controls` keep matching once the island hydrates. The ids come from the page's address, so every visit to a URL gets the same ones, and a page that shows the same to everyone is compressed once and not again for each visitor.

```kay
---
import { uid, signal } from 'kay'

const id = uid()
const open = signal(false)
---
button(aria-controls={id} aria-expanded={open()} onClick={() => open = !open()}) Details
if open()
  p(id={id}) More about it
```

`randomId(bytes = 16)` from `kay` gives random hex, `2 * bytes` characters long, for a name that must not repeat across visits, such as an idempotency key. Unlike `crypto.randomUUID()` it also works on an insecure page, such as http on a home network. `0` gives an empty string, a negative count throws, and a browser refuses more than 65,536 bytes.

It differs on every call, so draw it in a handler or after mount. An id in markup belongs to `uid()`, which is the same on the server and in the browser.

## Page navigation

A page with an island or a form swaps the next page in without a reload.

An island marked `persist` lives on from page to page. `Player(persist)` in a layout keeps a song playing, and in a browser with `Element.moveBefore` an iframe in it stays loaded. What the next page renders again stays as it is, so a sidebar keeps its scroll, and so does a scrolled panel inside the island, in every browser.

Each swap moves focus to the new page's `autofocus` field, else its `h1`, else its `main`. It also announces the title to screen readers.

A focused element the swap keeps stays focused. When a script made it focusable with `tabindex`, it keeps that tab stop until the focus leaves it, though the next page's markup has none, so the focus does not fall to the body.

Go to a page from code with `navigate`.

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

A path goes where the same `href` would: your `base` and the current locale's prefix are added, `/todos` on a French page going to `/fr/todos`, and a path that already has a locale prefix is left as it is.

`navigate({ query: { sort: 'name', page: null } })` changes the current page's query in place. The scroll and the focus stay, and a null or empty value drops its param. A text field the swap replaces, such as a search box whose island gets the new value, keeps its caret and selection, and the keys typed meanwhile, so a search as you type keeps taking the keys.

To link to the current page with one param changed, use `withQuery`. It works in a server fence, a template and an island, and follows the same rules as `navigate({ query })`.

```kay
---
import { withQuery } from 'kay'
---
a(href={withQuery({ page: 2 })}) Next
```

In an island it follows the address, so the link changes with each `navigate({ query })`, page swap and Back. It keeps the other params, and your `base`, `trailingSlash` and locale prefix are added the way they are to any link.

`navigate('/todos', { scroll: 'keep' })` goes to the page without scrolling to the top, and `{ transition: false }` swaps it without a view transition. A link does the same with `data-keep-scroll` and `data-no-transition`, which an element around several links can carry. The nearest `data-keep-scroll` to the link decides, so `data-keep-scroll="false"` on one link inside a keeping element scrolls to the top.

A page whose first part the server has not sent after 10 seconds (`client.pageTimeout` changes it), for a link or `navigate()`, is loaded by the browser instead, which shows its own progress or error. A view transition that has not finished after 3 seconds is skipped and the page is shown. A link you click during a transition skips it and is followed.

The code a swap loads for a streamed page, or to keep a deferred server island already fetched on screen, is waited for 4.5 seconds at most once the page arrived: past that the streamed page is loaded by the browser, and the island shows its inert copy until fetched again.

Each swap fires a `kay:navigate` event on `document`, with the page's address in `event.detail.url`, for a plain script to set itself up again. A full load fires none.

A page streaming `await` blocks is swapped in as soon as its first part is, each block showing its `pending` branch, so `kay:navigate` fires then, once, and `navigation.status()` is `'idle'` while blocks may still be arriving.

Each block replaces its branch in place as it lands, keeping the focus and the scroll, and its islands hydrate. Another navigation ends the stream, and one that sends nothing for `client.pageTimeout` leaves the pending branches as they are. `kay:navigate-start` fires when a swap begins, and `kay:navigate-error` when it gives up and the browser loads the page in full, with `event.detail.url` and, for the error, `event.detail.error`.

An island can follow a navigation without listening to events. `navigation.status()` is `'loading'` while the next page is fetched, `'swapping'` while it is put in place and `'idle'` otherwise, `navigation.pending()` says whether one is under way, `navigation.to()` is the address being navigated to and `navigation.error()` is an `ApiError` (status 0, since no page answered) for why the last swap gave up. That is enough for a loading bar:

```kay
---
import { navigation } from 'kay'
---
if navigation.pending()
  .top-bar
```

`navigation` answers `status()`, `pending()` and `error()` as every other source an island reads does: see [island sources](/llms/island-sources).

`onBeforeNavigate` asks before a link, `navigate()`, Back or Forward leaves the page, and keeps the page when it returns `false`. `onNavigate` runs after each page is shown. Both get one object, end with the island, and return a function that removes them sooner. A handler that throws is logged and the navigation goes on.

```ts
import { onBeforeNavigate, onNavigate } from 'kay'

onBeforeNavigate(({ url }) => !uploading() || url.pathname.startsWith('/uploads'))
onNavigate(({ url }) => track(url.pathname))
```

What a script appends to `<body>` goes with the next swap, as the next page never renders it. Mark it `data-kay-keep` to keep it through every swap, the same element at the end of the body, such as a live region an announcer fills. The swap never moves it, so a live region is still read. Only a direct child of `<body>` is kept this way, and only one a script added: an element the server renders comes back with the next page.

An `onClick` on a link runs before the page swaps, and `event.preventDefault()` in it keeps the link from being followed. A link with `data-reload` loads its page fully. So does every link to a page setting `reload: true` in its `page`.

A form with `method="get"` swaps the page in place as a link does, with its fields in the query, so a search or a filter keeps your persisted islands, the scroll and the focus. `data-reload` on the form loads the page fully.

### Ask before leaving unsaved changes

`guardLeave` from `kay` asks before the page is left while its function returns true.

```kay
---
import { guardLeave, signal } from 'kay'

const draft = signal('')

guardLeave(() => draft() !== '')
---
textarea(bind:value={draft} aria-label="Draft")
```

Links, `navigate()` and back and forward wait for the answer. A reload or a closed tab gets the browser's own prompt. Pass `{ confirm: to => ... }` to ask with your own dialog, returning a boolean or a promise of one.

### Prefetching

The `prefetch` setting says when a page is fetched before a click: `moderate` on hover (the default), `conservative` on press, `eager` as soon as it can, `false` never. On a page running kay's script, `eager` fetches the links that scroll into view, three at a time; on one without, the browser fetches every link at once.

A link or a container takes its own level with `data-prefetch="eager"`, `"moderate"` or `"conservative"` where kay's script runs, and `data-prefetch="false"` opts out everywhere. The nearest one wins, and none does anything under `prefetch: false`:

```kay
nav(data-prefetch="eager")
  a(href="/pricing") Pricing
```

A link that changes something on GET, such as a logout, takes `data-no-prefetch`.

```kay
a(href="/logout" data-no-prefetch) Sign out
```

### Forms and a full load

A form posting to an action posts without a reload and shows the page the post leads to. A refused post keeps the scroll and the typed values.

With `client: { navigation: false }` in `kay.config.ts`, every page loads fully and only pages with islands ship a script. A form then posts as the browser would, and names its page in a `kay_back` query parameter. A refused post renders that page again with the message, and one that goes through goes back to it.

<ReadMore href="/llms/navigation#navigation">How focus moves on back and forward, the other cases that load a page fully, and how a refused post focuses its field.</ReadMore>

## Browser-only code

kay's browser code runs on Chrome and Edge 98, Firefox 104 and Safari 16.4 or later. The build ships an island's code as written, so keep it off newer APIs such as `Map.groupBy` if you support those browsers.

kayjs-ui's popovers and site nav menu need Chrome and Edge 114, Firefox 125 or Safari 17. They sit beside their trigger through CSS anchor positioning, in Chrome and Edge 129, Firefox 147 and Safari 26. An older browser opens them away from the trigger.

`window`, `document` and `localStorage` do not exist on the server. Read them in `onMount` or `effect`, which run in the browser only.

```kay
---
import { signal, onMount } from 'kay'

const width = signal(0)

onMount(() => {
  width = window.innerWidth
})
---
p Window is {width()}px wide
```

A component that cannot render on the server at all, such as one wrapping a map library, starts its script fence with `--- client`. It renders in the browser only.

```kay
--- client
import { onMount } from 'kay'
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map
```

The server sends an empty slot for it, which shifts the layout when the map appears. Give it a fallback to show in the meantime: an `@fallback` block at the root of the component's template for every use, or one written under a use, `Map(center={center} hydrate="client")`, for that use alone. The browser replaces it when the island renders.

A component's own fallback is static markup: it cannot read the script's values, but it can use the script's imports, and `kay check` reports a value or prop it reads.

```kay
--- client
import { onMount } from 'kay'
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map

@fallback
  .map.animate-pulse
```

`watch(source, (next, previous) => ...)` from `kay` runs whenever `source` changes, but not on its first read. You need no variable holding the old value.

`debounced(source, delay)` gives the value once it has stopped changing for `delay`, a duration such as `'300ms'`. `watch(debounced(typed, '300ms'), lookUp)` looks a name up when the user pauses typing.

`every(interval, run)` runs `run` on a timer while the island lives, `interval` being a duration such as `'1s'`. `every('1s', () => now = Date.now())` ticks a clock. The timer pauses while the tab is hidden and runs once as it shows again; pass `{ background: true }` to keep it running. An interval of zero, a negative one or one that is not a duration throws.

`listen(window, 'keydown', event => ...)` listens to an event of `window` or `document`. It removes the listener when the island ends. Call it with an arrow function or read the target as `event.currentTarget`, as the callback has no `this`. An `effect()` or `onCleanup()` inside the callback belongs to the island and builds up with every event, as in an element's handler, so keep them out of it.

`kay check` reports the `unowned-effect` lint for such a call, and for one in a timer or after an `await`; in development the same call with no owner at all logs a warning.

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

## Following a log

A log or a chat should stay at its bottom while the reader is there, and keep what they are reading in place when older items load above. `followLog` from `kay` does both for the element that scrolls.

```kay
---
import { followLog } from 'kay'

let list: HTMLElement | undefined

followLog(() => list)
---
ol(ref={element => list = element} style="height: 20rem; overflow-y: auto")
  for line of lines()
    li {line}
```

The list starts at its bottom. When an item is added, a line grows or the list is resized, the list scrolls down if the reader was at the bottom. If the reader scrolled up, the first item they can see stays where it is, even when items are added above it. It does nothing on the server.

`followLog` returns `{ toBottom }`. Call `toBottom()` when the reader sends a message from higher up, and the list takes them back to its bottom and follows again. A list hidden and then shown again, as in a panel the reader reopens, shows its bottom.

<ReadMore href="/llms/navigation#follow-a-log">The `threshold` and `items` options.</ReadMore>

## Reading an element's size

A drawing that depends on an element's size, such as a road winding down a column, needs its width and height as values. `elementSize` from `kay` makes them, with no `ResizeObserver` to create and disconnect.

```kay
---
import { elementSize } from 'kay'

const column = elementSize()
---
.relative.h-full(ref={column.ref})
  svg(width={column.width()} height={column.height()})
```

`width()` and `height()` read the element's content box in pixels and change as it is resized. They are 0 on the server and until the browser has measured the element. An element that appears later, inside an `if` for instance, is measured as soon as it does.

<ReadMore href="/llms/islands-state-to-ids#element-size">Keeping the element too, and what the values are before the first measure.</ReadMore>

## Following a media query

`mediaQuery` from `kay` gives whether a CSS media query matches, as a value that changes when the visitor's setting does. `reducedMotion()` is the shorthand for `prefers-reduced-motion: reduce`, so an island that animates stops when the visitor asks for less motion, even while the page is open.

```kay
---
import { reducedMotion } from 'kay'

const still = reducedMotion()
---
if still()
  p No animation
```

The server renders the fallback, `false` unless you pass another, as in `mediaQuery('(max-width: 40rem)', true)`. The island starts from it too and takes the browser's answer once mounted.

## A page kay does not serve

A page bundled by something else, such as an HTML file `Bun.serve` imports, can render `.kay` components too. List `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, or pass `kay({ root })` from `kay/bun` to `Bun.build`. Then render one with `mount` from `kay` (`kay/mount` is the same function), which returns a function that removes it.

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

A mount renders after what the element already holds. Disposing it removes only its own nodes, so several components can share one element.

<ReadMore href="/llms/islands">The edge cases of props and persisted state, the options of `shortcut`, and the navigation details are in the full islands reference.</ReadMore>
