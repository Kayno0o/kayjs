# Islands and navigation

## Islands

A component is interactive when any element in it has an `on*` handler, a `bind:` or a `ref`, or when its script uses a value from `kay`, such as `signal`, imported or not, but for `uid`, `sanitizeHtml` and `trustHtml`, which keep it static. An interactive component renders on the server and hydrates in the browser as an island; everything else ships no JavaScript, except the small script swapping pages in on a page posting a form to an action (see [Navigation](#navigation)). Interactive components rendered inside an island are part of it.

Props a static component passes to an island are serialized for the browser: plain objects and arrays, strings, numbers, booleans, `null` and `undefined`, and also Dates, Maps, Sets, bigints, URLs and RegExps, which arrive as themselves, a value referenced twice arriving once. Children and `@name` blocks without parameters pass from any static parent, a page or a layout included: the server renders them with the parent, as static markup the island shows where its template puts `slot` or the prop, and their code never reaches the browser. An island among them is one of its own, hydrating by itself, and keeps its state when the island hides the block and shows it again, or moves it, since the island shows the same nodes each time. A block the island did not show on the server, or a client-only island's, travels in its props as markup and is built once shown. Text alone, as in `Label Save`, is a string prop like any other. The island cannot change what a block renders: one it calls with values takes parameters.

A function, a block with parameters, a class instance or a symbol cannot be serialized. A static component passing one to an island renders as an island itself, decided as it renders, its own props serialized instead, so that a component rendering `Picker(format={shout})` hydrates whole, while one passing only data stays static and ships nothing. Its own props must then be serializable, else the component rendering it renders as an island in turn. A page with a `--- server` fence or a layout cannot render as an island: `kay check` rejects a function or a class instance it passes one, as it does where the compiler cannot see a component passing one, and rendering throws naming the prop; move that part to a component of its own. A static component that only islands render, directly or through other such components, renders inline with them, so it passes its interactive children anything; once a page, a layout or a script imports it too, its props to them are serialized again.

An island hydrates as soon as the page loads, its chunks preloaded. `hydrate="idle"` waits until the browser is idle and `hydrate="visible"` until it scrolls near the viewport, neither preloaded: `Comments(postId={post.id} hydrate="visible")`. Only an island takes `hydrate`, and only from a static parent.

A component the server renders per request inside an otherwise prerendered page, such as a form carrying a fresh token, is a server island instead: see [Server islands](routing.md#server-islands).

### Shared and persisted state

A signal a `.ts` module exports is one state for every island of the page that imports it: `export const cart = signal<Item[]>([])` in `src/cart.ts`, read by a header badge and written by a product's button.

- On the server a module outlives the request, so a value a page's, a layout's or an island's script writes to such a signal while the page renders, as `cart.set(items)` seeding it from props, holds for that request only, and everything rendered after it reads it. A module's `memo` is computed afresh on each read there.
- `persisted('theme', 'light')` from `kay` is a signal that keeps its value across pages and visits in a cookie named `theme`, which the server reads too, so a page rendered for the request shows the kept value from the first paint, and answers with `Vary: Cookie`. A page `kay build` prerendered renders the default, and the island corrects it as it hydrates. The cookie is named as it is given, so it never reuses the name of a cookie the app sets itself.
- `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as the query param `q`, which the server reads too, so a page rendered for `?q=kay` shows it from the first paint. A write takes the current history entry's place, keeping `history.state`, and the default, the value given to `persisted`, leaves the param out. Only a string is kept: `persisted<'site' | 'logs'>('tab', 'site', { storage: 'query' })` types it, but the URL may hold any text, so check it before relying on it.
- `queryParam<number>('page')` from `kay` is a signal holding one query param of the page, read as the page's `query` schema reads `ctx.query` (see routing): a number, a boolean, one of an enum, a list from a repeated param, the schema's `default` when the param is left out. The server writes the schema's rules for its params into the page, which the island reads them by, so an island works on any page and Elysia's `t` never reaches the browser; the server renders the same value from the first paint. A value the rules refuse reads as the default rather than throwing, and a write takes the current history entry's place, a list as the param repeated, the default, `undefined` or blank text leaving the param out. The type argument is the island's to give, defaulting to `string | undefined`; on a page whose schema names no such param, the value is its text.
- `persisted('draft', '', { storage: 'local' })` keeps it in localStorage instead, which the server never sees: the page renders the default and the kept value applies once the islands reading it have hydrated, so it suits what the first paint does not show.
- A persisted value crosses as island props do, Dates, Maps and Sets included. A cookie value over about 3.8 KB encoded is not kept, with a warning; one written by another version of the app, or by hand, that does not decode leaves the default. A value that decodes is not checked against the signal's type, so one whose shape the code relies on is checked before use. The cookie is `SameSite=Lax`, for the site's mount point, kept a year, and `Secure` over https.

### Transitions

`transition="fade"` on the element an `if` branch, a `for` row or an `await` block shows animates it in as the block shows it and out before the block takes it away, as Vue's `<Transition>` does, with CSS alone:

```kay
if open()
  .dialog(transition="fade") Saved
```

```css
.fade-enter-active, .fade-leave-active { transition: opacity 200ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
```

- Entering, the element gets `fade-enter-from` and `fade-enter-active`, then from the next frame `fade-enter-to` in place of `fade-enter-from`, and loses them all once the longest transition or animation they start has run. Leaving goes the same way with `fade-leave-`, then removes the element. The rest of the block changes at once: a row taken out of a `for` stays where it was while it leaves, and a row added plays in where it goes.
- Each phase takes classes of its own too, so Tailwind's utilities need no stylesheet: `li(transition:enter="transition duration-200" transition:enter-from="opacity-0" transition:leave="transition duration-150" transition:leave-to="opacity-0")`. `transition:enter` and `transition:leave` hold for the whole phase, `-from` for its first frame and `-to` after it; they add to the named classes when `transition` names some.
- Elements animating alike share their classes through a preset: a module exports `export const fade: TransitionClasses = { enter: 'transition duration-200', enterFrom: 'opacity-0', leave: 'transition duration-150', leaveTo: 'opacity-0' }`, `TransitionClasses` from `kay`, and `li(transition={fade})` plays it. The `transition:` attributes add to a preset's classes, and Tailwind finds them in the module as it scans the app's files.
- Only the element a block shows plays: the first element of its branch or row, or the root of a component it renders. What renders with the island, or with the first render of a block, shows as it is, and a row moving to another place in the list does not play.
- A visitor asking for reduced motion (`prefers-reduced-motion: reduce`) gets no phase at all: elements come and go at once, as they do in a hidden tab, which draws no frames.
- It plays in islands only, the server leaving the attributes out of the markup. On a component it is an error, as on an unknown phase such as `transition:out`.

### Error fallbacks

A `try` block renders its `catch` block instead when what it renders throws, so one broken widget does not take the page down:

```kay
try
  Chart(points={points})
catch error
  p.error The chart could not be drawn: {(error as Error).message}
```

- It works in any template. On the server, a block that throws renders `catch`, and the error goes to the log and `onError` like any render error, the page answering 200. Without `try`, a render error fails the page as before.
- In an island, a block that throws while it hydrates, or later as a signal it reads changes, renders `catch` in its place, its effects disposed. The error is logged and sent to the server, where `onError` gets it as a `BrowserError` from `kay/server`, with `kind`, the error's own name such as `TypeError`, `message`, `stack`, the page's `url`, its path without query or hash, and `island`, the island's component path, when known. A `kay build --static` export has no server to send it to, so there it is logged only. A block the server rendered `catch` for keeps that markup as it came, since the error stayed on the server.
- `catch` takes the error under a name or none, typed `unknown`. A `try` without `catch` renders nothing when it throws.
- An error no `try` catches in the browser, from an effect, a handler or a promise nobody awaited, is reported the same way; an island whose script throws as it hydrates keeps its server markup, lifeless. The browser sends at most 10 distinct errors per page load, leaving out another origin's scripts, whose details it hides, and the server takes 20 reports a minute per client, refusing another site's and any over 16 KB.

### Context

`context(defaultValue)` makes a value a component hands everything it renders, however deep, without passing it through each one's props:

```ts
// src/theme.ts
import { context } from 'kay'

export const Theme = context<'light' | 'dark'>('light')
```

A component's script calls `Theme.provide('dark')`, and any component it renders, its children and their blocks included, reads `Theme.use()`; a component beside it, or above, reads the nearest value provided above itself, else the default. Provide a signal to share a value that changes. `use()` reads while a component renders: a handler or a timer calls it with nothing above, getting the default, so the script reads it once and keeps it. A layout's provide reaches its page. An island reads nothing the page's static components provide, in the browser as on the server, since it hydrates on its own: provide inside the island.

### Unique ids

`uid()` from `kay` gives a component an id unique on the page, for tying a label to its control or a trigger to its popup, with no `id` prop to pass:

```kay
---
import { uid } from 'kay'

const id = uid()
const open = signal(false)
---
button(
  aria-controls={id}
  aria-expanded={open}
  onClick={() => open.set(!open)}
)
  | Menu
ul(id={id} hidden={!open})
  slot
```

- One per call, made once per component instance as its script runs, rows of a `for` included. An island draws the same ids in the browser as the server wrote, so `for`, `aria-controls` and `id` match once it hydrates.
- Importing `uid` alone keeps a component static; the ids of a page differ from one render to the next, so a test reads them off the markup rather than writing them, and a prerendered page that revalidates gets a new ETag each time.
- A `try` whose block fails on the server draws its `catch` block's ids apart, so the ids after it match the browser's, which keeps the server's markup there.

### Browser-only components

Some components cannot render on the server: a package that touches `window` as it loads, such as CodeMirror or hls.js, or code reading `localStorage` while rendering. Such a component renders in the browser only: the server sends its island as an empty `<slot>`, props included, and the browser renders it there as soon as the page loads, instead of hydrating it. Inside another island it renders nothing on the server and is built in place as its parent hydrates.

- An island importing a package that throws on a browser-only global as it loads renders in the browser only, with nothing to write. Each package is imported once, in a Bun process of its own, and the answer is kept per package version in `.kay/cache`. The server never loads the package: an island's server module carries none of its script.
- A component whose script fence is `--- client` always renders in the browser only, and is an island even without state. Pages, layouts and special pages render on the server, so they cannot be.
- `hydrate="client"` renders one use of an island in the browser only: `Map(center={center} hydrate="client")`.

A browser-only global is one lib.dom declares and Bun lacks: `window`, `document`, `localStorage`, `sessionStorage`, `innerWidth` and the like. `fetch`, `URL`, `WebSocket`, `crypto` and `navigator` exist on the server too and are never reported. `kay check` and the editor report one read while the component renders: at the script's top level, in a `memo` or an array callback such as `.map`, in a function of the script the render calls, or in a template value. Handlers, refs, `effect`, `onMount` and other callbacks run in the browser only and report nothing. The editor offers two fixes: wrap the statement in `effect`, offered for a statement that is a plain call or assignment, since a declaration would take its name out of reach, or turn the fence into `--- client`. `typeof window` while an island renders is reported too: it is `'undefined'` on the server, so the island would render something else in the browser than the markup it hydrates. A global reached through a module of the app or a package is not seen; in development, a server render failing on one names it, the `.kay` line reading it, and the same two fixes.

The other way round, a build refuses a chunk the browser loads that reads `process` or `Bun`: such a chunk throws as it evaluates, so every island in it stays dead and only the console says so. The error names the chunk and the modules whose own source reads it, a `.kay` fence included. This catches a server-only module reaching the browser through what an island imports, directly or through its page's script fence; the fix is to keep that module out of there and pass what it holds as a prop. A read a `typeof` asks about first, as a module written for both sides does, passes: inside the `typeof`, in either branch of an `if` or a `?:` testing it, after an early `return`, or through a flag the module stored that answer in, and so does one in the block of a `try` with a `catch`, which takes the error a missing global throws. A read through `globalThis` is not seen, nor one in a chunk carrying a `process` polyfill of its own, which binds the name. `kay dev` and `kay test` build the same way, so they refuse it too.

An island reaching a builtin a browser lacks, `bun:sqlite` or `async_hooks` through a database library say, is refused with the imports leading there, one line per island: `src/counter.kay -> src/links.ts -> src/db.ts -> bun:sqlite`, cut at the first package since the fix is never inside one. An island bundles all of a module it imports, so a helper beside a database the module opens as it loads brings the database along: move the helper to a module importing none of it.

## Navigation

A page shipping kay's script, one with an island or a form posting to an action, swaps the next page in place: a link to another page of the app fetches it and puts its body and head in this one, without a reload, and the islands of the new page hydrate. Without JavaScript, or before the script loads, links and forms load pages as they always did.

- The body is morphed rather than replaced: an element the next page renders again, in the same place with the same tag, `id` and `class`, stays the same element and takes the next page's attributes and children, so a layout's sidebar keeps where it was scrolled to and its links' `aria-current` moves, with nothing to mark. A form field shows the value the next page renders, as on a page loaded afresh, a popover or a dialog left open closes, and the element holding the new page's `h1`, such as a main column scrolling on its own, goes back to the top as the window does. Islands are never morphed: one is kept only when marked `persist` or, on a refresh, unchanged; every other one is ended and the next page's hydrates afresh.

- An island marked `persist` lives on from page to page, its state and its element kept, when the next page renders it too: `Player(persist)` in a layout keeps a song playing. A bare `persist` matches the same component on the next page; `persist="left"` names one use, for two uses of a component to be told apart. Only an island takes `persist`, and only from a static parent. The props the next page gives it reach it as a component inside an island gets new props: what reads them in the template or an effect shows the new values, while a value the script computed from them once keeps the old one.
- A form posting to an action posts without a reload, then shows the page the post leads to, as the browser would: `ctx.failed` and `ctx.succeeded` read as after a full post, and a post going back to the same page, or refused and rendering it again, keeps the scroll position and the focused field. A refused post moves focus to the form's first field marked `aria-invalid`, which a screen reader reads with the message describing it (see [Actions](actions.md)); with none, the message describing the form itself is announced and the control that posted it, such as a submit button, is focused again. An island calling an action moves no focus: what it shows on an `ActionError` is its own to focus. While it posts, the form has `aria-busy="true"` and a second submit does nothing; a file upload's progress, from 0 to 1, is the form's `--kay-progress` custom property and the value of each `progress` inside it.
- Before posting, the browser checks the form against the action's schema, with the message the server would give, the schema's `error` option when set: the length, pattern, `email` and `uuid` formats and bounds of each field, numbers, booleans and list sizes. A refused field shows the browser's own bubble, cleared as it is edited. Files, hidden fields, missing required fields and the forms of an `await` block are left to the server, and a form with `novalidate` written in the template, or a button with `formnovalidate`, skips the check. kay sets `novalidate` itself on the other forms posting to an action, so the constraints a `field` writes for a visit without JavaScript give way to this check, and checks those the template wrote itself after it; an island's `onSubmit` calling `event.preventDefault()` keeps kay from posting at all (see [Actions](actions.md)).
- `navigate('/todos/1')`, imported from `kay`, goes to a page as a link would, `{ replace: true }` taking the current history entry's place; another site's page loads. `navigate({ query: { sort: 'name', page: null } })` goes to the current page with those params set and a null, undefined or empty one dropped, the others and the path kept and the hash left out, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place. `refresh()` runs the current page's loads again and shows what they return, keeping the scroll, the focus and every island whose props did not change, as a call to an action does by itself once it went through: an island calls it once something else changed what the page shows. Both do nothing on the server.
- `guardLeave(() => dirty())` from `kay`, called in an island's script, asks before the page is left while the function returns true, for as long as the island lives: a link of the app, `navigate()` and going back or forward wait for the answer, a refused back or forward returning the URL and its history entry to the page, scroll and islands as they were; a reload, closing the tab or a link loading fully gets the browser's own prompt, listened for only while a guard holds changes, so the page stays in the back-forward cache otherwise. `{ confirm: to => ... }` replaces the default `window.confirm` with the app's own question, returning a boolean or a promise of one, `to` being the URL left for. With several guards holding changes, one asks, once. A form posting to an action, `refresh()` and an island's own `history.replaceState` are no leave; an island writing history keeps `history.state`, which holds kay's place in it.
- The page loads only a small listener up front; the code doing the swap is fetched once a visitor points at or presses a link of the app, focuses a form, or an island calls `navigate()` or `refresh()`. A link clicked before it arrived is swapped once it has, and if it cannot load, the link and the form load pages fully as without JavaScript.
- A link or a form with `data-reload`, or inside an element with it, loads the next page fully; so do a link with `target` or `download`, one to another site, `/api` and `/_kay` paths, and modified clicks. A page in another locale, or one built against another client build, loads fully too.
- A link to the page being rendered gets `aria-current="page"`, which screen readers announce and a stylesheet can light up, `aria-[current=page]:font-bold` with Tailwind: an `a` whose `href` is a path of the site, a trailing slash or not, and holds no query or fragment. A link writing its own `aria-current` keeps it, and one an island renders is left to it. A section's link lit on the pages below it is still the template's to write.
- The swap moves focus to the new page's `autofocus` element, else its `h1`, and announces its title to screen readers. Going back or forward, or reloading, restores where each page was scrolled to, and a link to `#section` scrolls there. A page streaming `await` blocks is swapped in once they all arrived. `aria-busy="true"` sits on `html` while a page loads.
- The swap prefetches as the speculation rules would, `prefetch` setting when (see [Project setup](project.md#project-setup)), and replaces them, so each page is fetched once: a hovered link's page is kept for 30 seconds and taken as the link is followed. `data-no-prefetch` still opts a link out.
- A stylesheet holding `@view-transition { navigation: auto; }` animates the swap where the browser has view transitions, as it animates full loads, the rule standing at the top level or inside an `@media` or `@supports` that holds. A visitor asking for reduced motion (`prefers-reduced-motion: reduce`) gets no animation from the swap whatever the stylesheet says; a full load animates for them unless the rule sits in `@media (prefers-reduced-motion: no-preference)`, as the one `kay new` writes does.
- `navigation: false` in `kay.config.ts` or `pages()` turns it off: pages load fully, and only pages with islands ship a script. Under `kay dev`, such a page still refreshes without a reload when only markup changed, as [Project setup](project.md#project-setup) describes.
