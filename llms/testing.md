# Testing

## Common tasks

### Run the tests

`kay test [bun test arguments]` (the `test` script `kay new` writes) runs `bun test` with each file in modules of its own and `kay/test/preload` loaded, so a project needs no `bunfig.toml` and no flag: `kay test tests/cart.test.ts`, `kay test --watch`, `kay test --changed`. A failure is reported at the line of the `.kay` file.

### Test a page

`testSite()` from `kay/test` serves the project in the test process, `site.visit(path)` GETs a page, and `page.text(selector)` reads what a visitor reads:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('greets the visitor', async () => {
  const page = await site.visit('/')

  expect(page.text('h1')).toBe('Welcome')
})
```

### Test a refused form

`site.submit(action, fields, { from })` posts a form without JavaScript and reads the page a refused post renders:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { add } from '../src/routes/index.kay'

const site = await testSite()

it('shows why a todo was refused', async () => {
  const page = await site.submit(add, { title: '' }, { from: '/' })

  expect(page.text()).toContain('Write a title')
})
```

### Test an action as an island calls it

`site.call(action, input)` resolves with the result, and `site.refusal(action, input)` expects the call refused:

```ts
const refused = await site.refusal(add, { title: '' })

expect(refused.status).toBe(422)
expect(refused.errors).toEqual({ title: 'Write a title' })
```

### Test as a signed-in user

`locals` stands in for the app's `derive`, and `use` takes the plugins the server entry uses before the pages:

```ts
const site = await testSite({
  locals: () => ({ user: { id: 1, admin: true } }),
})
```

`headers` gives every request of the site a header, and `site.as(cookie | headers)` is the same site with more of them, a string being a `Cookie` header such as `await auth.sessionCookie(userId)` returns, so a test does not repeat `{ headers: { cookie } }` on each call:

```ts
const asAdmin = site.as(await auth.sessionCookie(admin.id))

expect((await asAdmin.visit('/admin')).status).toBe(200)
```

kayjs-auth's `await auth.signInAs(site, { email, username })` signs a test site in as a member, made when none exists, with no form round trip; `auth.signOut(site)` signs it out, and a second `signInAs` switches member (see [kayjs-auth](../packages/auth/llms/hardening-and-testing.md)).

### Check a page's metadata

A visit reads the title, meta tags, canonical link, JSON-LD and links without a regex:

```ts
const page = await site.visit('/pricing')

expect(page.title()).toBe('Pricing | Example')
expect(page.meta('description')).toBe('What it costs')
expect(page.canonical()).toBe('https://example.com/pricing')
expect(page.find('a[aria-current="page"]')[0]?.attributes.href).toBe('/pricing')
```

### Test an API route

`site.fetch(path, init)` sends any request with the cookies so far and resolves with the response as it is:

```ts
const response = await site.fetch('/api/health')

expect(response.status).toBe(200)
```

`site.api(module, path, options)` calls a route of a module under `src/api` as `call()` does from an island, typed from the route (the method, `params`, `query` and `body`, a wrong one failing to compile), and resolves with `{ ok, status, headers, body }`, the refusal of a 4xx included, `body` typed once `ok` is checked:

```ts
import notes from '../src/api/notes'

const created = await site.api(notes, '/', { method: 'post', body: { title: 'first' } })

if (created.ok)
  expect(created.body.title).toBe('first')

expect(await site.api(notes, '/:id', { method: 'patch', params: { id: 9 }, body: { title: 'x' } })).toMatchObject({ ok: false, status: 404 })
```

### Run the jobs an action enqueued

`site.runJobs()` runs every job whose time has come and resolves with how many ran:

```ts
await site.submit(signUp, { name: 'Ada', email: 'ada@example.com' }, { from: '/' })

expect(await site.runJobs()).toBe(1)
```

A mail an action enqueues is waited for by kayjs-mail's `outbox`, which runs the site's queues until it is there: `await outbox.waitFor(address, { site })` resolves with the newest mail to that address, and `outbox.token(mail, '/auth/verify-email')` reads the token of its link ([kayjs-mail](../packages/mail/llms/contact-form-and-testing.md#testing)).

### Test a websocket route

`site.socket(module, path, options)` opens the route as an island does, and `next()` resolves with the oldest message not read yet:

```ts
import chat from '../src/api/chat'

const room = site.socket(chat, '/:room', { params: { room: 'general' } })

room.send({ text: 'hello' })

expect(await room.next()).toEqual({ room: 'general', from: 'anonymous', text: 'hello' })
room.close()
```

`site.socketRefusal(module, path, options)` sends a real upgrade and resolves with the refusal, such as a guard's 401 or the 403 of a cross-site `origin`, and fails when the route accepted it:

```ts
const refused = await site.socketRefusal(chat, '/:room', { params: { room: 'general' }, headers: { origin: 'https://evil.test' } })

expect(refused.status).toBe(403)
```

### Reset or seed content

A test never writes into the project's `src/content`: a folder collection moves to a copy under `.kay/scratch` as its first save, delete or CMS screen reaches it, and the site reads it from there. `site.content.reset()` puts everything back (folders read from the project, loaders on their own source), `site.content.reset({ posts: [{ slug: 'a', data: { title: 'A' }, body: '...' }] })` or `site.content.seed('posts', entries)` makes a collection hold exactly those entries (`locale` for a localized one), and `site.content.write('posts', 'broken.json', text)` writes a raw file in the copy, for an entry that does not parse. A loaded collection's seed lives in memory: its loader's `load`, `get` and `count` read it, and `save` and `remove` (where declared) change it, never the source. A file written straight into `src/content` is read only until the copy is made.

### Test a component's handlers

`mountComponent(file, props)` renders one component built for the browser into `document`, and `settle()` lets effects land before the DOM is read. The first `mountComponent` of a file registers happy-dom's DOM, `@happy-dom/global-registrator` installed as a dev dependency (20.14.6, or 21.0.3 and later); a file that mounts nothing never loads it.

```ts
import { expect, it } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

it('opens its panel on a click', async () => {
  const { root, unmount } = await mountComponent('src/components/toggle.kay', { label: 'Menu' })

  root.querySelector('button')!.click()
  await settle()

  expect(root.querySelector('.panel')?.textContent).toBe('Open')
  unmount()
})
```

## Reference

### Test site

`kay/test` serves the project's pages and actions inside the test process, with no server and no browser; its islands are built for the browser as a check, never loaded:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { add } from '../src/routes/index.kay'

const site = await testSite({
  locals: () => ({ user: { id: 1, admin: true } }),
})

it('shows why a todo was refused', async () => {
  const page = await site.submit(add, { title: '' }, { from: '/' })

  expect(page.html).toContain('Write a title')
})
```

- `site.visit(path)` GETs a page and follows redirects, stopping at one to another site.
- A project setting no `site`, nor `SITE_URL` or `ORIGIN`, is served as `http://localhost`, so a page reading `siteUrl()` or `siteOrigin()` renders as it does in production.
- `site.submit(action, fields, { from })` posts a form without JavaScript, as multipart with any `File` among its fields, and follows it back to its page, or reads the page a refused post renders.
- `from` may be a page `visit` or `submit` resolved with instead of a path: the post goes where its form posts, from the URL the browser shows it at.
- So `site.submit(add, fields, { from: refused })` posts again from the page a refused post answered, as a visitor fixing the form does.
- A post to an action with `minTime` goes through as if its form had been open long enough, with a page or without, so a test of something else needs no waiting.
- A page older than `maxAge` is still refused as expired.
- A post or a call to an action with `proofOfWork` carries a solved challenge, unless `headers` gives its own `x-kay-work`, `''` for none.
- A test of the minimum itself says how long the form was open: `site.submit(contact, fields, { from: '/', openedFor: 0 })` posts as soon as the page loaded and `openedFor: '2d'` two days after.
- `visit.stamp(action)` reads the stamp the visit's form for `action` rendered with, and `{ from: visit, stamp }` posts it as it is, so a test checking that the refused page keeps the stamp its form rendered with compares `refused.stamp(contact)` to `page.stamp(contact)`; a `stamp` such as `'forged'`, or a `kay_since` among the fields, is posted as given and wins over `openedFor` and the clock.
- Both `visit` and `submit` resolve with `{ url, status, headers, html }`, which also reads the page as a crawler does (see below).
- `site.call(action, input)` calls an action as an island does, `input` its typed input or a `FormData`, left out for an action with no input or only optional fields: `site.call(signOut)`.
- `{ from: '/orgs/acme' }` names the page a call is made on, for an action reading its params.
- `site.call` resolves with the action's result, throws `ActionError` when it fails and `ActionRedirectError` with `location` when it redirects, the path under the site's `base` when it has one.
- A handler returning an async iterable gives every value once its stream ended, `[1, 2, 3]`, and throws when the stream failed.
- `site.refusal(action, input)` makes the same call expecting it refused: it resolves with the `ActionError`, `data` typed from the handler, and fails the test when the call went through.
- `await site.refusal(add, { title: '' })` reads `{ status: 422, errors: { title: 'Write a title' } }`.
- `site.mcp.tools()` lists the tools of an app with `mcp: true`, each `{ name, description, inputSchema }`, and `site.mcp.call('add_note', { title: 'Milk' })` calls one as an agent does, through the cookies of the site so far and the `headers` given, `{ headers: { authorization: 'Bearer token' } }`: it resolves with `{ isError, text, data, status }`, `isError` set when the app refused the call, `data` the answer when it is an object, `status` 401 when a guard asks for a sign-in; a protocol error, such as an unknown tool, throws.

### Reading a page

- A visit reads its page without a regex: `page.title()`, `page.meta(key)`, `page.canonical()`, `page.jsonLd()`, `page.links()`, `page.find(selector)` and `page.text(selector)`.
- `page.meta(key)` is the `content` of the `meta` whose `name` or `property` is `key`, such as `description` or `og:image`.
- `page.jsonLd()` is each thing the JSON-LD scripts describe, parsed, the items of a `@graph` one by one.
- `page.links()` is every `a`'s `href` in page order.
- `page.find(selector)` is every element a CSS selector matches, as `{ tag, attributes, text, html }`, `html` the markup inside as the page wrote it and `''` for an element that holds none, an element a browser closes by itself, as `<p>one<p>two`, ending where the browser would: `expect(page.find('a[aria-current="page"]')[0]?.attributes.href).toBe('/pricing')`, `expect(page.find('a.logo')[0]?.html).toStartWith('<svg')`.
- `page.text(selector)` is the text a visitor reads in the first element a selector matches, or in the whole body without one, scripts, styles and templates left out, or `undefined` when nothing matches.
- `page.settled` is the page as a visitor ends up seeing it, for one whose `await` blocks stream: each block's last part put in place of its pending markup and the swap script left out, read with the same `title`, `find` and `text`, and an `html` without the streamed templates; `page.text()` and `page.html` keep the pending markup and the templates, `expect(page.settled.text('.score')).toBe('42')`, no browser needed.
- Assert on text through `text` or `find`, never on `page.html`: an island's markup holds hydration markers between the parts of an interpolated text, so `p Thanks, {name}!` renders `Thanks, <!--[-->Ada<!--]-->!`, and `expect(page.text('.success')).toBe('Thanks, Ada!')` is what passes.
- Text and attributes come decoded, `&amp;` read as `&`, text with each run of whitespace one space and trimmed, sibling blocks (`li`, `p`, `div`, table cells, headings, `br`) kept apart by a space as a visitor reads them and inline elements (`b`, `span`, `a`) joined, and what the page lacks reads `undefined`.
- `site.sitemap()` resolves with the URLs `/sitemap.xml` lists, or the sitemap at another path, failing when it does not answer 200.

### Requests, jobs, sockets and sessions

- `testSite({ headers })` and `site.as(cookie | headers)` set headers every method sends, a call's own header of the same name winning, and a `cookie` header goes with the cookies kept so far, the one it names itself winning; `as` shares the site's cookies and server, leaves the site it came from as it is, and stacks cookies by name, the newer winning.
- `persistedCookie(name, value)` from `kay/test` is the `Cookie` value a `persisted(name, initial)` signal kept in a cookie holds, so a test sets one by name without knowing how kay encodes it: `site.as(persistedCookie('scheme', 'light')).visit('/')` renders with `light` on the first render, where `scheme=light` reads as the default.
- A `cookie` header a site or `as` gives is sent on every request, so it beats a cookie the jar deleted or rotated: use the site itself, not `as`, to follow a session's cookie as the app changes it.
- A default `origin` never replaces the one `call` and `submit` send, and `site.api` sends `accept: application/json` and a JSON body's `content-type` unless the site or the call names them (`site.mcp` always sends its protocol's two); `site.as(cookie).open(path)` opens the browser with that cookie unless `cookies` is given.
- `site.api(module, path, options)` takes `method` (GET unless named), `params`, `query`, `body` and `headers`, a body with a file going as a form, and resolves with `{ ok, status, headers, body }` for any status, the body parsed as `call()` reads an answer; a param is encoded as one segment, and an empty one or a dot segment throws a `TypeError`.
- `site.socketRefusal(module, path, options)` sends the upgrade to the site's server (at the root of its port, as `open` is, whatever the base), keeps the cookies the refusal sets, gives up after 5 seconds, which it starts as `socket` does, and resolves with the response of a refused one; an accepted upgrade is closed and fails the test naming the route. A socket the app closes after accepting is `socket()`'s `status()`.
- `site.fetch(path, init)` sends any request, an API route's included, with the cookies so far, and resolves with the response as it is, redirects not followed.
- `site.runJobs()` runs every job the app's queues hold whose time has come, those the jobs enqueue included, and resolves with how many ran: an action enqueues, the test runs the jobs, then checks what they did. It also waits for a `queue.enqueue()` or kayjs-mail `send`/`enqueue` the app started and left unawaited, but not for one a timer or other delay has not started yet.
- Queues keep their jobs in memory under `bun test` unless one names a store, and `files` its files, each `testSite` in a store of its own unless its options name one.
- `site.socket(module, path, options)` opens a websocket route and `site.stream(module, path, options)` reads an event stream as an island does, the options taking `headers` too.
- Both keep every message in `received` and resolve `next()` with the oldest one not read yet, waiting for one if need be; a stream's `finished()` resolves with all its values once it ended.
- `site.socket` starts the site on a free port the first time, which `site.close()` stops.
- A test site is closed once the tests ran (after each file with `--isolate` or `--parallel`, else after the run) with its pages, sockets, streams and server, so no test file closes it in an `afterAll`; `site.close()` stays for a test that wants it sooner and may be called twice.
- Cookies a response sets go with the next request and read as `site.cookies`, each only to the paths its `Path` covers.
- A site with a `base` in kay.config.ts is served under it with no option: `visit`, `submit`, `fetch` and `call`'s `from` take a path with the base (`/blog/about`, the base itself `/blog` or `/blog/`) or without it (`/about`), and a path starting with the base is taken as given, so a route starting like it is `/blog/blog/hello`.
- Under a base `visit` and `submit` resolve with `url` as the browser shows it (`/blog/about`), a redirect to a base-prefixed `Location` is followed with the cookies kept, a cookie with `Path=/blog` goes to every page and one with `Path=/other` to none, and `site.mcp` and `site.call` need nothing: `testSite({ base: '/blog' })` serves a config without one under it.
- `site.open()` serves the site at the root of its port, as no proxy takes a base off.
- `use` takes the plugins the server entry uses before the pages, in order, so an app on `session()` signs in through `site.submit` and stays signed in: `testSite({ use: [sessions] })`.
- `locals` stands in for the app's Elysia `derive`, called with each request, after those plugins.
- A site made at the top of a test file, as `const site = await testSite()` is, sends each test's requests as a client of its own, so a rate limit counts the posts of one test only: a test posting until it is refused needs no other to run first, and none after it is refused.
- One made inside a test or a `beforeAll` is one client throughout.
- A request carrying the header the app's `proxy` setting names still comes from the address it gives.

### Mounting a component

- `mountComponent(file, props)` from `kay/test` renders one component built for the browser, as an island renders, into `document`, and resolves with `{ root, unmount }` once its effects ran: for what handlers and effects do, such as a dialog opening on a click.
- `file` is the `.kay` file relative to the project, since importing it through the preload gives its server build.
- On a French site (a `lang` or locale of `fr`) it writes the non-breaking spaces an island does, once `document.documentElement.lang` is `fr`; the other client defines (`KAY_BROWSER`, `KAY_STATIC_EXPORT`) are left out.
- Props may be functions, and the component runs on a kay of its own, so a signal of the test reaches it through a callback rather than as a prop.
- A library's settings apply as `kay.config.ts` sets them.
- A component may `call()` or `resource()` a route of an API module, the project's or an extension's: it is bundled as in the browser, knowing the module only by where it is served, so the call goes out as `fetch` (stub it in the test).
- Each mount runs the component's modules afresh, as a page load does, so module state, a persisted signal read from storage included, does not carry over from an earlier mount: set localStorage, then mount.
- A test reading `document` before its first mount imports `kay/test/dom`, which registers the DOM at once; listed after `kay/test/preload` under `[test] preload`, it registers it for every file.
- It shims the popover API happy-dom lacks: `showPopover`, `hidePopover` and `togglePopover` fire `toggle` as a browser does, and `matches(':popover-open')` reads whether one is shown.
- It leaves `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal` and `WebSocket` as Bun's, and `FormData` is Bun's class that also reads a form element (a file input keeps its file), so a test serving with `Bun.serve` and fetching it works beside the DOM.
- A test may register the DOM itself instead, such as `GlobalRegistrator.register({ url: 'http://localhost/' })` for a document whose cookies the page reads.
- A DOM left registered for the rest of the run does not reach `testSite`, whose app runs on Bun's own `Request`, `Response` and the rest, so a file mounting components and one visiting pages share one `bun test` run, as long as `kay/test/preload` comes before any preload registering a DOM.
- A function the test stubbed, such as `fetch`, stays its stub there, and a streamed page under a DOM is read through `visit`, `site.fetch` handing back a body read later.
- A `persisted(key, initial, { storage: 'local' })` signal keeps its value encoded as island props are, not as JSON: `writePersisted(key, value)` and `readPersisted(key)` from `kay/test` set one before a mount and read one back, `undefined` when none was kept.
- After an interaction, `await settle()` lets effects land before the DOM is read.

### Helpers for a test of its own

- `cookieJar()` from `kay/test` keeps a browser's cookies for a test driving an Elysia app or a handler of its own rather than `testSite`, which keeps its own as `site.cookies`.
- `jar.send(handle, request)` sends the cookies kept so far through `handle`, such as `app.handle`, keeps those the response sets and drops those it expires; `jar.header()` is the `cookie` header it sends, `''` when it holds none, and `jar.cookies` the `Bun.CookieMap`.
- `solveWork(challenge)` from `kay/test` solves a proof-of-work challenge, such as one `workChallenge()` signs, as kay's script does, for a test posting a form field by hand, or `undefined` for text that is no challenge.
- `scratchDir(prefix)` from `kay/test` makes a fresh directory under the project's `.kay/scratch` and resolves with its absolute path: inside the project, so a file written there imports the project's packages, and under `.kay`, which no build or check reads, so another test file building beside it never meets it.
- `scratchDir(prefix, root)` puts it under another project's `.kay/scratch`; the test removes the directory once done with it.
- `overrideEnv(env, { MEDIA_DIR: dir })` from `kay/test` gives a `defineEnv` value other variables, `undefined` unsetting an optional one, until `restore()` or the end of a `using`, never `process.env`; only an `env.X` read at call time sees it, not a value copied at import, a value given is not checked against the schema, restores run in reverse order, tests running at once share the one `env`, and `publicEnv` is read apart.

```ts
import { expect } from 'bun:test'
import { cookieJar } from 'kay/test'
import { app } from './app'

const jar = cookieJar()

await jar.send(app.handle, new Request('http://localhost/sign-in', { method: 'POST' }))
expect(jar.cookies.has('session')).toBe(true)
```


### Databases and setup

A database per test file, its seed and the session store under `bun test` are in [Test databases and setup](testing-setup.md).
