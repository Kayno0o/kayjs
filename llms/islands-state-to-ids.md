# Islands: state to unique ids

## Common tasks

- Make a component an island, pass it props or choose when it hydrates: the tasks of [Islands](islands.md#common-tasks).

## Reference

### Shared and persisted state

- A signal a `.ts` module exports is one state for every island of the page that imports it: `export const cart = signal<Item[]>([])` in `src/cart.ts`, read by a header badge and written by a product's button.
- On the server a module outlives the request, so a value a page's, a layout's or an island's script writes to such a signal while the page renders, as `cart.set(items)` seeding it from props, holds for that request only, and everything rendered after it reads it.
- A module's `memo` is computed afresh on each read on the server.
- `persisted('theme', 'light')` from `kay` is a signal that keeps its value across pages and visits in a cookie named `theme`, which the server reads too, so a page rendered for the request shows the kept value from the first paint, and answers with `Vary: Cookie`.
- A page `kay build` prerendered renders a `persisted` signal's default, and the island corrects it as it hydrates.
- The cookie is named as it is given, so it never reuses the name of a cookie the app sets itself.
- `persisted('q', '', { storage: 'query' })` keeps a string in the page's URL instead, as the query param `q`, which the server reads too, so a page rendered for `?q=kay` shows it from the first paint.
- It is `queryParam('q')` below with the value given as its default: a write takes the current history entry's place, keeping `history.state`, and that value, like the schema's default, leaves the param out.
- It holds a string unless typed otherwise: `persisted<'site' | 'logs'>('tab', 'site', { storage: 'query' })` narrows it, but the URL may hold any text, so check it before relying on it.
- On a page whose `query` schema names the param, it is read as the schema reads it, so `persisted<number>('page', 1, { storage: 'query' })` holds a number, and a param left out reads the schema's default before the value given, as the page's loads do.
- `queryParam<number>('page')` from `kay` is a signal holding one query param of the page, read as the page's `query` schema reads `ctx.query` (see routing): a number, a boolean, one of an enum, a list from a repeated param, the schema's `default` when the param is left out.
- The server writes the schema's rules for its params into the page, which the island reads them by, so an island works on any page and Elysia's `t` never reaches the browser; the server renders the same value from the first paint.
- A value the rules refuse reads as the default rather than throwing.
- A `queryParam` write takes the current history entry's place, a list as the param repeated, the default, `undefined` or blank text leaving the param out.
- A `queryParam`'s URL write trails the signal by at most 200 ms while it changes fast (a slider), all params sharing one throttled write, since browsers refuse too many history writes; the signal is always current, and pending writes land before a page swap, `navigate()`, a reload or the page being hidden.
- The type argument is the island's to give, defaulting to `string | undefined`; on a page whose schema names no such param, the value is its text.
- `persisted('draft', '', { storage: 'local' })` keeps it in localStorage instead, which the server never sees: the page renders the default, and each island reading it hydrates on the default too, then shows the kept value, one hydrating later, once visible or on the next page, included. A memo over it made outside an island holds the kept value by then, so an island hydrating later derives from the signal itself. It suits what the first paint does not show.
- A persisted value crosses as island props do, Dates, Maps and Sets included.
- A cookie value over about 3.8 KB encoded is not kept, with a warning; one written by another version of the app, or by hand, that does not decode leaves the default.
- A value that decodes is not checked against the signal's type, unless the signal names the values it offers: `persisted('theme', 'light', { values: ['light', 'dark'] })` reads a stale or hand-edited cookie holding anything else as the default, on the server and in the browser, for a cookie, `local` storage or a `query` param (`{ storage: 'query', values }`, compared with the value the page's `query` schema reads, so numbers and booleans need the schema); the signal is typed as their union, and a default outside them is a type error. Without `values`, a value whose shape the code relies on is checked before use.
- The cookie is `SameSite=Lax`, for the site's mount point, kept a year unless `maxAge` says otherwise (`persisted('theme', 'light', { maxAge: '30d' })`, a `Duration`, cookie storage only), and `Secure` over https.

### Transitions

- `transition="fade"` on the element an `if` branch, a `for` row, a `for`'s `else`, a `try`'s `catch` or an `await` block shows animates it in as the block shows it and out before the block takes it away, as Vue's `<Transition>` does, with CSS alone.
- Entering, the element gets `fade-enter-from` and `fade-enter-active`, then from the next frame `fade-enter-to` in place of `fade-enter-from`, and loses them all once the longest transition or animation they start has run.
- Leaving goes the same way with `fade-leave-`, then removes the element.
- The rest of the block changes at once: a row taken out of a `for` stays where it was while it leaves, and a row added plays in where it goes.
- What leaves stays while what takes its place enters: the last rows of a `for` and its `else`, either way round.
- Each phase takes classes of its own too, so Tailwind's utilities need no stylesheet: `li(transition:enter="transition duration-200" transition:enter-from="opacity-0" transition:leave="transition duration-150" transition:leave-to="opacity-0")`.
- `transition:enter` and `transition:leave` hold for the whole phase, `-from` for its first frame and `-to` after it; they add to the named classes when `transition` names some.
- Elements animating alike share their classes through a preset: a module exports `export const fade: TransitionClasses = { enter: 'transition duration-200', enterFrom: 'opacity-0', leave: 'transition duration-150', leaveTo: 'opacity-0' }`, `TransitionClasses` from `kay`, and `li(transition={fade})` plays it.
- The `transition:` attributes add to a preset's classes, and Tailwind finds them in the module as it scans the app's files.
- Only the element a block shows plays: the first element of its branch or row, or the root of a component it renders.
- What renders with the island, or with the first render of a block, shows as it is, and a row moving to another place in the list does not play.
- A visitor asking for reduced motion (`prefers-reduced-motion: reduce`) gets no phase at all: elements come and go at once, as they do in a hidden tab, which draws no frames.
- It plays in islands only, the server leaving the attributes out of the markup.
- `transition` on a component is an error, as is an unknown phase such as `transition:out`.

### Error fallbacks

- A `try` block renders its `catch` block instead when what it renders throws, so one broken widget does not take the page down. It works in any template.
- On the server, a block that throws renders `catch`, and the error goes to the log and `onError` like any render error, the page answering 200.
- Without `try`, a render error fails the page as before.
- In an island, a block that throws while it hydrates, or later as a signal it reads changes, renders `catch` in its place, its effects disposed.
- The error is logged and sent to the server, where `onError` gets it as a `BrowserError` from `kay/server`, with `kind`, the error's own name such as `TypeError`, `message`, `stack`, the page's `url`, its path without query or hash, and `island`, the island's component path, when known.
- What a browser reports is anyone's text, so its control characters become spaces before it is logged or reaches `onError`, the stack keeping only its line breaks.
- A `kay build --static` export has no server to send it to, so there it is logged only.
- A block the server rendered `catch` for keeps that markup as it came, since the error stayed on the server.
- `catch` takes the error under a name or none, typed `unknown`.
- A `try` without `catch` renders nothing when it throws.
- An `await` block with no `catch` inside a `try` of the same template, a snippet declared in it included, and not in a component the `try` renders, renders the `try`'s `catch` when its value rejects, in place of the block alone and after the page rendered, on the server, in an island and in `renderToString`, the error reported as the `try`'s own is.
- On the server, what a block that threw set in the page's `head`, an island's title included, goes with it: the page serves the title of an island it rendered, or its own.
- An error no `try` catches in the browser, from an effect, a handler or a promise nobody awaited, is reported the same way.
- An island whose script throws as it hydrates keeps its server markup, lifeless.
- In production the stack arrives mapped: `kay build` keeps the browser build's source maps beside `dist`, pointed at `.kay` lines and never served, and the server maps each frame of a report with them, so `onError` reads `src/routes/cart.kay:12:7` rather than a minified chunk. A frame of a chunk with no map stays as the browser wrote it. An executable made by `kay build --compile` embeds the maps zstd-compressed and reads one when a report first needs it, and a `kay build --static` export has no server.
- The browser sends at most 10 distinct errors per page load, leaving out another origin's scripts, whose details it hides.
- The server takes 20 reports a minute per client, refusing another site's and any over 16 KB.

### Element size

- `elementSize()` from `kay`, called in an island's script, returns `{ ref, width, height }`: pass `ref` to the element as `ref={column.ref}`, and `column.width()` and `column.height()` read its content box in pixels, following every resize.
- Both are 0 on the server and until the browser has measured the element, so the first paint of a size-dependent drawing is empty.
- An element rendered later, as inside an `if`, is observed from then on, the one it replaces dropped; the observer goes with the island.
- Give `ref` to one element: two elements sharing it follow the last, and one removed by an `if` with no `else` stays observed until the island goes.
- To keep the element too, a `ref` calls both: `ref={element => { box = element; size.ref(element) }}`.

### Context

- `context(defaultValue)` from `kay` makes a value a component hands everything it renders, however deep, without passing it through each one's props.
- A component's script calls `Theme.provide('dark')`, and any component it renders, its children and their blocks included, reads `Theme.use()`.
- A component beside the provider, or above it, reads the nearest value provided above itself, else the default.
- Provide a signal to share a value that changes.
- `use()` reads while a component renders: a handler or a timer calls it with nothing above, getting the default, so the script reads it once and keeps it.
- A layout's provide reaches its page.
- An island reads nothing the page's static components provide, in the browser as on the server, since it hydrates on its own: provide inside the island.

### Unique ids

- `uid()` from `kay` gives a component an id unique on the page, for tying a label to its control or a trigger to its popup, with no `id` prop to pass.
- One per call, made once per component instance as its script runs, rows of a `for` included.
- An island draws the same ids in the browser as the server wrote, so `for`, `aria-controls` and `id` match once it hydrates.
- Importing `uid` alone keeps a component static.
- The ids of a page differ from one render to the next, so a test reads them off the markup rather than writing them, and a prerendered page that revalidates gets a new ETag each time.
- A `try` whose block fails on the server draws its `catch` block's ids apart, so the ids after it match the browser's, which keeps the server's markup there.
- `describeField(ids, { required })` from `kay`, called in a component's script, adds `ids` to the `aria-describedby` of the first `input`, `select` or `textarea` the component renders on the server, its slot included, after the field's own ids and a refused field's message, so a form field ties the control its parent writes to its hint and message; a field with a spread keeps it too, and a `hidden`, `submit`, `button`, `reset` or `image` input is skipped whether its `type` is written or an expression; in an island the ids stay as the field turns refused and valid again, kay adding and removing the message alone. `required: true` also writes `aria-required="true"` on that first field, `required: 'all'` on each field the component renders, none overriding an `aria-required` the field writes itself.
- It acts on the server's markup alone: inside an island, the browser keeps such a link itself as the messages change. Importing it keeps a component static.
