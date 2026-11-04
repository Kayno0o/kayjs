# Server islands

A component rendered per request inside an otherwise prerendered page ([prerendering](prerendering.md)).

## Common tasks

### Render one part of a prerendered page per request

`server` on a component call renders that component on every request inside the prerendered page:

```kay
--- server
import { issueToken } from '../contact'

export const contact = action(schema, send)
const token = issueToken()
---
Hero
Contact(action={contact} token={token})
```

```kay
---
// src/components/contact.kay
const { action, token } = props<{ action: string, token: string }>()
---
Section(title="Contact")
  p Write to us
  ContactForm(server="defer" action={action} token={token})
```

## Reference

### Server islands

- `server` on a component call renders that component per request inside an otherwise prerendered page: a form carrying a fresh token, a greeting, a stock count.
- The mark is the whole setup.
- A page without params whose template reaches one, directly or through the components it imports, prerenders without a `prerender` key, unless its `page` sets `prerender: false`.
- Each request runs the page's loads again, its server fence included, and renders only the components on the way down to the island, so its props come from the fence as they would on a page rendered whole:

```kay
--- server
import { issueToken } from '../contact'

export const contact = action(schema, send)
const token = issueToken()
---
Hero
Contact(action={contact} token={token})
```

```kay
---
// src/components/contact.kay
const { action, token } = props<{ action: string, token: string }>()
---
Section(title="Contact")
  p Write to us
  ContactForm(server="defer" action={action} token={token})
```

- `server` renders it on every GET and splices it into the prerendered page: it arrives with the page and needs no JavaScript.
- Only the island is rendered and compressed, the rest of the page being deflated once; the page then goes out as gzip, never brotli, with `Cache-Control: private, no-store` and no ETag.
- `server="defer"` serves the page as any prerendered page, brotli and ETag included, and the browser fetches the island a screen before it scrolls into view, or once the page is idle, then hydrates what it brought.
- Until then the page shows the component as the build rendered it, inert and with its forms' field names and actions taken out, so it keeps its place and size and a bot has nothing to post. Pick it for what sits low on the page.
- A page deferring an island ships kay's browser entry; with `navigation: false` and no island the build fails.
- The island's URL is the page's with `?kay_island=N`: fetched by kay, it answers the island alone; visited, as from a link, it answers the page with every island in place, with `X-Robots-Tag: noindex`.
- A browser without JavaScript keeps the inert copy of a deferred island.
- A fetch that times out (10 s), gets no answer or fails with a 5xx, 408 or 429 is retried at 1 s and 3 s; a lost one keeps the inert copy, sets `data-kay-failed` and dispatches `kay:server-island-error` (`detail.error`, `detail.retry()`), a success `kay:server-island`; a page swap aborts it.
- `@failed` under the use (`ContactForm(server="defer")` with an `@failed` block below it) is rendered hidden beside the inert copy and shown on `data-kay-failed`; a control inside it with `data-kay-retry` retries the island with no script, and the block hides again while it loads. A component declares its own with a root `@failed` block, as a `--- client` one declares its `@fallback`; a use's block wins. It is no prop of the component, is rendered without running the script (static markup and imports only, a script value or prop it reads is reported) and an inline `server` refuses it, as it does a server island, a handler or an action form inside it. It is never a prop, even for a component with a `failed` slot prop. Shown, it is a `role="alert"` and a failed retry gives the focus back to its retry control. A deferred island with a block has `<slot data-kay-server><slot inert>copy</slot><slot data-kay-failure hidden>block</slot></slot>`, the copy inert on its own so the block's control clicks.
- `noscript` beside the mark, such as `ContactForm(server="defer" noscript="Show the contact form")`, adds a link with that text leading to the page with every island in place.
- It is off by default: leave it off when what the island does is reachable without it, as an email address beside a contact form.
- A form post rendering the page, refused or coming back with how it went, renders it whole, islands included.
- A page swap (a post back to the same page, a link, Back) keeps a fetched island on screen, inert, while the next page's copy of it is fetched, when that page's inert copy of it is the same as the one it was fetched from: the scroll and the page's height stay, and no inert copy shows in between, and the field that had the focus (by `id`, else `name`, else its place among the controls of its tag) has it again once the fetch lands. An island of its own that was still waiting to hydrate is dropped without a console error. One whose inert copy differs is replaced by the next page's at once.
- What a component on the way to an island provides reaches it; what a layout's or a sibling's render does besides does not run.
- A mark inside an island is reported by `kay check`, as an island renders whole in the browser too.
- `kay build --static` refuses a page holding one, and the offline worker leaves it out of the pages it keeps unless `offline.pages` lists it, warning that it would keep one visitor's render.
