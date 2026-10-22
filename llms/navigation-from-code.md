# Navigating from code and pages kay does not serve

## Common tasks

### Go to a page from code

`navigate` from `kay` goes to a page as a link would, swapping it in place:

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

### Render a component on a page kay does not serve

With `"kay/bun"` listed under `[serve.static] plugins` in `bunfig.toml`, `mount` from `kay/mount` renders one into an element and returns what disposes it:

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

## Reference

### Navigating from code

- `navigate('/todos/1')`, imported from `kay`, goes to a page as a link would, `{ replace: true }` taking the current history entry's place, `{ scroll: 'keep' }` leaving the window scrolled where it is instead of going to the top, `{ transition: false }` swapping without a view transition; another site's page loads, so a `?next=` param goes through `localPath()` as a redirect's does, and a `javascript:` URL throws, as it would run in the page; `mailto:`, `tel:` and other schemes go to the browser as a link would. A link or `navigate()` that a redirect takes to another site loads that page fully rather than swapping it in.
- `navigate({ query: { sort: 'name', page: null } })` goes to the current page with those params set and a null, undefined or empty one dropped, the others and the path kept and the hash left out, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place.
- `refresh()` from `kay` runs the current page's loads again and shows what they return, keeping the scroll, the focus and every island whose props did not change, as a call to an action does by itself once it went through.
- An island calls `refresh()` once something else changed what the page shows, or polls with it, `every('3s', refresh, { while: () => issuing })`.
- A `refresh()`, including the one an action's call or a live value ends in, never cancels a link, `navigate()` or Back in flight: it waits for the swap, then runs again only when the swap left the URL it was asked for, since the new page is as recent as its answer. An island polling an action needs no `{ refresh: false }` to keep links working.
- A page the server has not fully sent after 10 seconds, for a link or `navigate()` but not a `refresh()`, is loaded by the browser instead, which shows its own progress or error; a view transition not finished after 3 seconds is skipped, the swap committing as it would have, and a link clicked during a transition skips it and is followed.
- `navigate` and `refresh` do nothing on the server. `navigate()` resolves to `false` when a leave guard was declined and the page stayed, `true` otherwise.
- `shortcut(keys, handler, options?)` from `kay`, called in an island's script, runs `handler(event)` on a keydown, for as long as the island lives, and does nothing on the server; `keys` may be a function returning the string or null, following the signals it reads. `keys` joins modifiers (`mod`, `ctrl`, `meta`, `alt`, `shift`) and one key with `+`: `mod+s`, `shift+?`, `/`, `escape`, `arrowup`, `space`. The modifiers must match exactly, except that `shift` is ignored for a symbol key such as `?`, `space` and `shift+space` are two bindings, and a symbol typed with AltGr, as `@`, matches without `ctrl` or `alt`.
- A shortcut binds the whole page; `on: element` or `on: () => element`, the function form reading a `ref` variable once the island mounted, scopes it to that element (an `on` holding no element, as a `ref` variable still undefined, binds nothing), which gets `aria-keyshortcuts` while the island lives.
- A shortcut with `mod`, `ctrl`, `meta` or `alt` fires while a text field, select or `contenteditable` element has the focus; a bare key (`/`, `?`, `g`) does not, unless `{ inputs: true }`. `escape` and the function keys fire there too, and a bare `enter` or `space` is left to a focused button or link.
- It cancels the browser's default (`mod+s` saving the page) unless `{ preventDefault: false }`, and skips a press that is part of an IME composition, a held key unless `{ repeat: true }`, and an event something already handled (`defaultPrevented`), so of two bindings on one key the innermost one, an element's before the page's, wins.
- A letter or digit matches the character typed, else the physical key (`event.code`), so `mod+s` still works on a Cyrillic layout or with Option held on a Mac. An unknown modifier or an empty key throws.
- `followLog(container, options?)` from `kay`, called in an island's script, watches the element that scrolls (an element, or a function returning it once the island mounted, as `() => list` for a `ref` variable) for as long as the island lives, and does nothing on the server. It starts the list at its bottom; after each change inside it (an item appended or prepended, a line's text growing, the list resized) it scrolls to the bottom while the reader was within `threshold` pixels of it (32 by default), else it moves the scroll so the first item showing keeps its place on screen. The items are the container's direct children, or the elements `items: 'li.turn'` selects. A reader who scrolls up stops being followed until they come back to the bottom.
- `guardLeave(() => dirty())` from `kay`, called in an island's script, asks before the page is left while the function returns true, for as long as the island lives.
- Under a guard, a link of the app, `navigate()` and going back or forward wait for the answer, a refused back or forward returning the URL and its history entry to the page, scroll and islands as they were.
- A reload, closing the tab or a link loading fully gets the browser's own prompt, listened for only while a guard holds changes, so the page stays in the back-forward cache otherwise.
- `{ confirm: to => ... }` replaces the default `window.confirm` with the app's own question, returning a boolean or a promise of one, `to` being the URL left for.
- With several guards holding changes, one asks, once.
- A form posting to an action, `refresh()` and an island's own `history.replaceState` are no leave.
- An island writing history keeps `history.state`, which holds kay's place in it.

### Full loads and prefetching

- The page loads only a small listener up front; the code doing the swap is fetched once a visitor points at or presses a link of the app, or an island calls `navigate()` or `refresh()`. A page with speculation rules (the default) also fetches the small code prefetching its links, along with the first link a visitor points at, presses or focuses, which it handles at once.
- The code posting and checking forms is fetched once a form takes focus or is submitted.
- A link clicked before the code arrived is swapped once it has, and if it cannot load, the link and the form load pages fully as without JavaScript.
- A link or a form with `data-reload`, or inside an element with it, loads the next page fully.
- So do a link with `target` or `download`, one to another site, `/api` and `/_kay` paths, and modified clicks.
- A page in another locale, or one built against another client build, loads fully too, as does a page setting `reload: true` in its `page` or its layout's, and one whose cross-origin isolation differs from the current page's, which a document cannot change in place.
- Such a page still swaps itself in place: a link to it with another query, `navigate({ query })` and `refresh()` on it.
- The swap prefetches as the speculation rules would, on the timing the `prefetch` setting gives (see [Project setup](project.md#project-setup)), and replaces them, so each page is fetched once: a hovered link's page is kept for 30 seconds and taken as the link is followed.
- `data-no-prefetch` still opts a link out.
- A visitor asking for less data (`Save-Data: on`) gets a lighter site with no setting: the image route answers the next width down of the ladder (see [Images](images.md#responsive-images)), font preloads, speculation rules and any other `rel="preload" as="font"` link leave the page, its fonts show only when cached (`font-display: optional`), and the swap prefetches nothing. In the browser, `prefers-reduced-data: reduce` and `navigator.connection.saveData` stop the swap's prefetch alone, as no media query can drop a preload.
- Pages say `Vary: Save-Data`, so a cache or CDN keeps the two copies apart; a prerendered page is served to that visitor from its plain HTML, not the compressed copies the build wrote, its head changed on the way out. A static export has no header to read: the prefetch and the islands' wait still follow the browser, but the preloads stay.
- Islands wait too: those with no `hydrate` hydrate once they scroll near, and the page preloads none of their chunks when the request says `Save-Data` (see [Islands](islands.md#hydration)).
- `saveData: false` in `kay.config.ts` or `pages()` gives everyone the same page and image, with no `Vary`.
- A link, or one inside an element, with `data-keep-scroll` swaps without scrolling to the top, and with `data-no-transition` without a view transition, as `navigate()`'s `scroll: 'keep'` and `transition: false` do; going back still restores the position saved, and a hash in the URL is not scrolled to while the scroll is kept. The nearest `data-keep-scroll` to the link decides, so `data-keep-scroll="false"` on a link, or on an element between it and a keeping one, scrolls to the top as a plain link does.
- A stylesheet holding `@view-transition { navigation: auto; }` animates the swap where the browser has view transitions, as it animates full loads, the rule standing at the top level or inside an `@media` or `@supports` that holds.
- A visitor asking for reduced motion (`prefers-reduced-motion: reduce`) gets no animation from the swap whatever the stylesheet says; a full load animates for them unless the rule sits in `@media (prefers-reduced-motion: no-preference)`, as the one `kay new` writes does.
- `navigation: false` in `kay.config.ts` or `pages()` turns it off: pages load fully, and only pages with islands ship a script.
- Under `kay dev`, a page with navigation off still refreshes without a reload when only markup changed, as [Project setup](project.md#project-setup) describes.

### A page kay does not serve

- A page another server or tool bundles, such as an HTML file `Bun.serve` imports, renders `.kay` components too.
- The plugin `kay` from `kay/bun` compiles them, for the browser in a browser build: list `"kay/bun"` under `[serve.static] plugins` in `bunfig.toml`, which `Bun.serve` reads from the directory it starts in, or pass `kay({ root })` to `Bun.build`'s `plugins`, `root` being where `.kay/` goes, the working directory by default.
- `mount(Component, element, props)` from `kay/mount` renders one into an element, as an island renders but with no server markup to hydrate, and returns what disposes it, ending its effects and removing only the nodes it rendered, so several components mounted into one element are disposed one at a time and the rest of the element stays as it was.
- `props` may be left out for a component taking none.
- A signal a `.ts` module exports reaches every component mounted from that module's bundle, so a module feeding signals from a WebSocket keeps them current.
- Imports of `.kay` files are typed through `.kay/types` as in a kay project, which `kay check` writes, with the tsconfig settings of [Project setup](project.md#project-setup).
