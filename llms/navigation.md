# Navigation and pages kay does not serve

## Common tasks

### Keep an island playing across pages

`persist` keeps it, its state and its element, when the next page renders it too:

```kay
---
import Player from './player.kay'
---
main
  slot
Player(persist)
```

### Go to a page from code

`navigate` from `kay` goes to a page as a link would, swapping it in place:

```kay
---
import { navigate } from 'kay'
---
button(onClick={() => navigate('/todos')}) Todos
```

### Ask before leaving unsaved changes

`guardLeave` from `kay` asks before the page is left while its function returns true:

```kay
---
import { guardLeave } from 'kay'

const draft = signal('')

guardLeave(() => draft() !== '')
---
textarea(bind:value={draft} aria-label="Draft")
```

### Bind a keyboard shortcut

`shortcut` from `kay` runs a function when keys are pressed, for as long as the island lives. `mod` is Cmd on macOS and Ctrl elsewhere:

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

### Render a component on a page kay does not serve

With `"kay/bun"` listed under `[serve.static] plugins` in `bunfig.toml`, `mount` from `kay/mount` renders one into an element and returns what disposes it:

```ts
import { mount } from 'kay/mount'
import Panel from './panel.kay'

const dispose = mount(Panel, document.querySelector('#panel')!, { title: 'Tickets' })
```

## Reference

### Navigation

- A page shipping kay's script, one with an island or a form posting to an action, swaps the next page in place: a link to another page of the app fetches it and puts its body and head in this one, without a reload, and the islands of the new page hydrate.
- Without JavaScript, or before the script loads, links and forms load pages as they always did.
- A page without kay's script carries one line of it instead: loaded afresh, as by a reload, Back or Forward to an entry an earlier swap made loads that entry's page, which Chrome would otherwise leave on screen; an entry the app pushed itself is left to the app.
- The body is morphed rather than replaced: an element the next page renders again, in the same place with the same tag, `id` and `class`, stays the same element and takes the next page's attributes and children, so a layout's sidebar keeps where it was scrolled to and its links' `aria-current` moves, with nothing to mark.
- A form field shows the value the next page renders, as on a page loaded afresh, and a popover or a dialog left open closes.
- The element holding the new page's `h1`, such as a main column scrolling on its own, goes back to the top as the window does.
- Islands are never morphed: one is kept only when marked `persist` or, on a refresh, unchanged; every other one is ended and the next page's hydrates afresh.
- Outside the body's content, one rule holds for the head's elements, the attributes of `<html>` and those of `<body>`: what the server served changes as the next page serves it, and what a script changed or added since stays as the script left it. A theme toggle's `meta[name="theme-color"]`, a tag a loader added to the head and a class a script put on `<body>` live on through every swap, a meta a script changed or added standing in for the next page's meta of that name and media, while a head tag the page left served alone goes with it. The server writes `<body>` bare, so its attributes are always a script's. A change an inline head script makes before kay's script runs counts as served. A served head tag a script removed comes back with the next page serving it, and a `<style>` an island injects itself outlives the island.
- A swap fires `kay:navigate` on `document` once the new page is in place and its islands are hydrating, with `event.detail.url` the page's address, so a plain script (an analytics tag, a lightbox) can set itself up again; a full load fires none.
- The swap moves focus to the new page's `autofocus` element, else its `h1`, else its `main`, and announces its title to screen readers; a heading or a `main` takes `tabindex="-1"` only until it loses the focus.
- Going back or forward does too, past the `autofocus` element the visitor already left, the focus moving without scrolling away from the restored position; between entries of one path that only their query tells apart, the focus stays where it was, as following a query param leaves it.
- Going back or forward, or reloading, restores where each page was scrolled to, and a link to `#section` scrolls there.
- A page streaming `await` blocks is swapped in once they all arrived.
- `aria-busy="true"` sits on `html` while a page loads.
- A link to the page being rendered gets `aria-current="page"`, which screen readers announce and a stylesheet can light up, `aria-[current=page]:font-bold` with Tailwind: an `a` whose `href` is a path of the site, a trailing slash or not, and holds no query or fragment.
- A link writing its own `aria-current` keeps it, and one an island renders is left to it. A link marked with `section`, `a(href="/docs" section)`, or `section={isDocs}` for a boolean that decides it, also gets `aria-current="true"` on the pages below it (`/docs/guide`, not `/docs-old`), which a stylesheet lights up with `aria-[current=true]:font-bold`; the attribute is never written out, the site's home (`/` or a locale's own) is never marked that way, and it holds under `base`, `trailingSlash` and a locale prefix. A link not marked `section`, such as a pagination `prev` or a breadcrumb's parent, is lit on its own page only.
- A link whose `href` leaves the site gets `target="_blank" rel="noopener"`: in a template, an island, `renderMarkdown` and a collection's Markdown body, an absolute `http(s)` URL of another origin or one starting `//`, compared with the `site` origin on the server (with no `site`, any absolute `http(s)` link) and `location.origin` in an island. A relative or root-relative path, `#hash`, `mailto:`, `tel:` and a same-origin absolute link stay in the same tab, as does a link writing its own `target` (an empty one too, and a `target={expr}` even when it gives `undefined`: spread `{...cond ? { target: '_blank' } : {}}` instead); one writing its own `rel` keeps it. `links: { outside: 'same-tab' }` in `kay.config.ts` or `pages()` writes none. The swap never follows a link with a `target`, so it never meets one. `markdownHtml` (a user's text, server and island) does the same with `rel="nofollow ugc noopener"`.

### Islands kept across pages

- An island marked `persist` lives on from page to page, its state and its element kept, when the next page renders it too: `Player(persist)` in a layout keeps a song playing.
- A browser with `Element.moveBefore` (Chrome 133, Firefox 144) moves it in place, so an iframe in it stays loaded, a video keeps playing and the focus stays in it; elsewhere it is taken out and put back, and the swap gives the focus and the selection back; a popover open in it closes either way. The scroll of every element inside it, nested ones and horizontal scroll too, is kept either way.
- A bare `persist` matches the same component on the next page; `persist="left"` names one use, for two uses of a component to be told apart.
- Only an island takes `persist`, and only from a static parent.
- The props the next page gives a kept island reach it as a component inside an island gets new props: what reads them in the template or an effect shows the new values, while a value the script computed from them once keeps the old one.
- The element focused inside an island a swap keeps, marked `persist` or unchanged on a refresh, stays focused, a text field, `textarea` or `contenteditable` with its caret and selection, so a field whose every key shows a draft or refreshes the page keeps taking the keys.
- A text field or `textarea` the swap replaces on a query `navigate()`, a refresh or a redirect, such as a field of an island hydrated afresh for its new `value` prop, gets the focus back with the caret and selection of the old one (kept within the new text, at its end when the caret was at the end), so a search as you type keeps taking the keys; on a query `navigate()` or a refresh, keys typed in it while the page was fetched are kept, and its `input` event fires again so the island asks for them.
- A swap to a new page still moves the focus to its heading.

### Forms posting in place

- A form posting to an action posts without a reload, then shows the page the post leads to, as the browser would: `failed()` and `succeeded()` of an action read as after a full post.
- A post going back to the same page, or refused and rendering it again, keeps the scroll position and the focused field.
- A refused post moves focus to the form's first field marked `aria-invalid`, which a screen reader reads with the message describing it (see [Actions](actions.md)).
- With no field marked, the message describing the form itself is announced and the control that posted it, such as a submit button, is focused again.
- A refused post focusing its field reveals it as `focusInvalid` does.
- An island calling an action moves no focus: what it shows on an `ActionError` is its own to focus.
- `focusInvalid(root)` from `kay` does that once its writes rendered: it runs the effects they left pending, as `flush()` does, then focuses the first field marked `aria-invalid="true"` under `root`, the whole document without one, that takes focus, such as one on a tab the write just showed, and resolves to whether one did, so the island needs no `requestAnimationFrame`.
- `markInvalid(element, by, invalid)` from `kay` marks a field `aria-invalid="true"` for `by`, any value naming the source, while `invalid`, and takes the mark off once no source holds it, kay's own mark of a refused field included, leaving one the page wrote before any source; a form field marking the control its parent writes calls it from an effect, so the field stays invalid while either it or the action refuses it.
- A field inside `hidden="until-found"` or a closed `details` is revealed first, as find-in-page reveals it, unless it is disabled or inert: innermost first, each `details` opens and each such element gets a bubbling `beforematch`, where a tab list shows its panel, then loses `hidden`.
- Revealing stops where a listener hides that element again, shows it itself, takes it out or opens a `details` above it, the rest left as it is.
- While it posts, the form has `aria-busy="true"` and a second submit does nothing; it has it too while an `onSubmit` of the island's returns a promise, and a second submit meanwhile is dropped, its handler not run.
- A post the server received, only its answer lost (the connection dropped once the body had gone), is never posted again by the browser: the page loads afresh, the action having run once. A post that never went out is left to the browser, as before.
- A file upload's progress, from 0 to 1, is the form's `--kay-progress` custom property and the value of each `progress` inside it.
- Before posting, the browser checks the form against the action's schema, with the message the server would give, the schema's `error` option when set: the length, pattern, `email` and `uuid` formats and bounds of each field, numbers, booleans and list sizes.
- A refused field shows the browser's own bubble, cleared as it is edited.
- Files, hidden fields, missing required fields and the forms of an `await` block are left to the server.
- A form with `novalidate` written in the template, or a button with `formnovalidate`, skips the check.
- kay sets `novalidate` itself on the other forms posting to an action, so the constraints a `field` writes for a visit without JavaScript give way to this check, and checks those the template wrote itself after it.
- An island's `onSubmit` calling `event.preventDefault()` keeps kay from posting at all (see [Actions](actions.md)).

### Follow a log

`followLog` from `kay` keeps a scrolling list at its bottom while the reader is there, and the first item showing in place when items load above. The options are `threshold` (pixels from the bottom that still count as there, 32) and `items` (a selector for the items, the container's direct children by default):

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

### Navigating from code

- `navigate('/todos/1')`, imported from `kay`, goes to a page as a link would, `{ replace: true }` taking the current history entry's place, `{ scroll: 'keep' }` leaving the window scrolled where it is instead of going to the top, `{ transition: false }` swapping without a view transition; another site's page loads, so a `?next=` param goes through `localPath()` as a redirect's does, and a `javascript:` URL throws, as it would run in the page; `mailto:`, `tel:` and other schemes go to the browser as a link would. A link or `navigate()` that a redirect takes to another site loads that page fully rather than swapping it in.
- `navigate({ query: { sort: 'name', page: null } })` goes to the current page with those params set and a null, undefined or empty one dropped, the others and the path kept and the hash left out, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place.
- `refresh()` from `kay` runs the current page's loads again and shows what they return, keeping the scroll, the focus and every island whose props did not change, as a call to an action does by itself once it went through.
- An island calls `refresh()` once something else changed what the page shows, or polls with it, `every('3s', refresh, { while: () => issuing })`.
- `navigate` and `refresh` do nothing on the server.
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
