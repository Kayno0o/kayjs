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
