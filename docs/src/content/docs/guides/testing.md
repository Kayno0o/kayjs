---
title: Testing
order: 8
description: Test pages and actions in-process with kay/test, and drive a real browser when you need one.
---

`kay/test` serves your pages and actions inside the test process, with no server and no browser. `kay new` writes a first test and a `test` script. Run them with `bun run test`, which is `kay test`: it runs `bun test` with each file isolated and kay's preload loaded, so you write no flag, and a failure points at the line of the `.kay` file. Its arguments go on to `bun test`, as in `kay test --watch` or `kay test tests/cart.test.ts`.

It does build your islands for the browser, so a test fails when one cannot be built. See [Islands that fail the browser build](#islands-that-fail-the-browser-build).

## Rendering a page

`testSite()` gives a site. `visit` GETs a page and follows redirects. It resolves with `{ url, status, headers, html }`. The site is closed once the tests ran, so a test file never closes it.

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('lists the books', async () => {
  const page = await site.visit('/')

  expect(page.status).toBe(200)
  expect(page.title()).toBe('Reading list')
  expect(page.find('li').length).toBeGreaterThan(0)
})
```

The page also has `meta(key)`, `canonical()`, `jsonLd()` and `links()`. `find(selector)` returns `{ tag, attributes, text, html }` for each match. `text(selector)` gives the text a visitor reads in the first match, or in the whole body, with a space between sibling blocks such as list items and paragraphs, and none between inline elements.

A page whose `await` blocks stream holds the pending markup and, after it, the templates that replace it, so `text()` reads the pending text. `page.settled` is the page as the visitor ends up seeing it, each block swapped for its last part, with the same `title()`, `find()` and `text()` and an `html` without the templates: `expect(page.settled.text('main')).not.toContain('Loading')`. No browser is needed.

Assert on text through these, not on `page.html`. An island's markup holds hydration markers inside an interpolated text, so `Thanks, {name}!` is not one string there.

`site.sitemap()` resolves with the URLs `/sitemap.xml` lists. Pass another path for a sitemap served elsewhere. It fails when the path does not answer 200.

```ts
expect(await site.sitemap()).toContain('https://example.com/about')
```

## Posting an action

Import the action from its page and `submit` it as a form post without JavaScript. It follows the redirect back, or reads the page a refused post renders.

```ts
import { add } from '../src/routes/index.kay'

it('shows why a book was refused', async () => {
  const page = await site.submit(add, { title: '' }, { from: '/' })

  expect(page.text('.error')).toBe('Write a title')
})
```

`site.call(action, input)` calls an action as an island does, and throws `ActionError` when it fails. An action with no input takes no second argument: `site.call(signOut)`.

`site.refusal(action, input)` makes a call that you expect to be refused. It resolves with the `ActionError`, its `status`, `errors` and `data` typed from the handler. It fails the test when the call goes through.

### Testing an MCP endpoint

With `mcp: true`, `site.mcp.tools()` lists the tools an agent sees. `site.mcp.call('add_note', { title: 'Milk' })` calls one and resolves with `{ isError, text, data, status }`.

`isError` is true when the app refused the call, and `status` is 401 when a guard asks for a sign-in. Pass `{ headers: { authorization: 'Bearer token' } }` as the third argument to call as a signed-in agent. The cookies set so far go with a call.

### Action protections

An action with `minTime` takes the post as if its form had been open long enough, so a test of something else needs no waiting. To test the minimum itself, say how long the form was open: `{ from: '/', openedFor: 0 }` posts as soon as the page loaded.

The form carries a stamp of when it rendered. `page.stamp(contact)` reads it off a visit, and `{ from: page, stamp }` posts it back as it is, so a test can check that a refused page keeps the stamp its form first had. Any other text, such as `stamp: 'forged'`, is posted as given.

An action with `proofOfWork` gets a solved challenge with each post and call. Send your own `x-kay-work` header to override it, `''` for none.

A site made at the top of the file posts as a new client in each test, so a rate limit counts the posts of one test only.

## Websockets and streams

`site.socket(module, path, options)` opens a websocket route of an API module as an island does. `next()` resolves with the oldest message not read yet, and waits for one if there is none.

```ts
import chat from '../src/api/chat'

const room = site.socket(chat, '/:room', { params: { room: 'general' } })

room.send({ text: 'hello' })

expect(await room.next()).toEqual({ room: 'general', from: 'anonymous', text: 'hello' })
room.close()
```

`received` holds every message so far. The first socket starts the site on a free port, and the site is closed once the tests ran, or by `site.close()` when a test wants it sooner.

`site.stream(module, path, options)` reads an event stream the same way. `finished()` resolves with every value once the stream has ended.

```ts
const answer = site.stream(chat, '/answer', { method: 'post', body: { prompt: 'two words' } })

expect(await answer.finished()).toEqual(['two\n', 'words\n'])
expect(answer.status()).toBe('done')
```

Both take `headers` in their options, to call as a signed-in client.

To test that a socket is refused, `site.socketRefusal` sends a real upgrade and resolves with the refusal. It fails when the route accepted the connection.

```ts
const refused = await site.socketRefusal(chat, '/:room', { params: { room: 'general' }, headers: { origin: 'https://evil.test' } })

expect(refused.status).toBe(403)
```

## A site under a base

A site with a `base` in kay.config.ts is tested under it with nothing more. `testSite({ base: '/blog' })` serves one that sets none.

`visit`, `submit` and `fetch` take a path with the base or without it, `/blog/about` or `/about`. A path starting with the base is taken as written, so a route that starts like it is `/blog/blog/hello`.

`url` on a visit is the path as a browser shows it, base included. `site.open()` serves the site at the root of its port, since no proxy takes the base off there.

<ReadMore href="/llms/testing#test-site">How redirects and cookie paths work under a base are in the full testing reference.</ReadMore>

## Signed-in users

Cookies a response sets go with the next request, so an app on `session()` stays signed in across calls. `use` takes the plugins the server entry uses, and `locals` stands in for a `derive`.

```ts
const site = await testSite({ use: [sessions] })
const admin = await testSite({
  locals: () => ({ user: { id: 1, admin: true } }),
})
```

A site made with `headers` sends them with every request. `site.as()` gives the same site more of them, and a string is a `Cookie` header, such as `auth.sessionCookie` returns.

```ts
const asAdmin = site.as(await auth.sessionCookie(admin.id))

expect((await asAdmin.visit('/admin')).status).toBe(200)
```

To sign a site in as a member, call `auth.signInAs(site, { email, username })` with the app's own `auth`. It makes the member when none has that email or username, and sets the session cookie on the site, with no form to fill. Call it again to switch member, and `auth.signOut(site)` to sign out.

```ts
import { auth } from '../src/auth'

await auth.signInAs(site, { email: 'ada@example.com', username: 'Ada' })

expect((await site.visit('/auth/account')).status).toBe(200)
```

A `persisted` signal kept in a cookie stores its value in kay's own encoding, so `scheme=light` reads as the default. `persistedCookie(name, value)` gives the right cookie: `site.as(persistedCookie('scheme', 'light'))` renders the first page with `light`.

## Waiting for a mail

An action that sends a mail through a queue has not sent it when the call answers. `mailTest(site)` from kayjs-mail reads the site's mails, and its `waitFor(address)` runs the site's queues until the mail is there, and fails after 5 seconds, naming the mails the outbox holds. `token(mail, path)` reads the token of the link that opens `path`. `link(mail, path)` gives the link itself, for a page you visit next.

```ts
const mail = mailTest(site)

await site.submit(request, { email }, { from: '/auth/reset-password' })

const sent = await mail.waitFor(email, { find: each => each.subject.includes('Reset') })
const token = mail.token(sent, '/auth/reset-password')
```

## Testing a library

Each library has one helper. Call it at the top of a test file, and it clears itself before every test, so no test cleans up by hand. `mailTest(site)` reads the mails, `aiTest()` scripts the fake model, `auth.test(site)` signs the site in and out, and `cmsTest(site)` signs in as an editor, saves an entry and reads it back. Each library's page shows its helper.

## Calling an API route

`site.api(module, path, options)` calls a route of a module under `src/api` as an island's `call()` does. The method, params, query and body are typed from the route, so a wrong one fails to compile. It resolves with `ok`, `status`, `headers` and `body`, and a refusal is an answer, not a throw.

```ts
const created = await site.api(notes, '/', { method: 'post', body: { title: 'first' } })

if (created.ok)
  expect(created.body.title).toBe('first')
```

## One component

`mountComponent(Component, props)` renders one component into `document`, its props typed. Use it to test what its handlers and effects do.

Install `@happy-dom/global-registrator` as a dev dependency. The first `mountComponent` of a file registers happy-dom's DOM, and a file that mounts nothing never loads it. The popover API happy-dom lacks comes with it.

`fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal` and `WebSocket` stay Bun's, and `FormData` stays Bun's class while reading a form element as in a browser, so a test serving with `Bun.serve` still works beside it.

A test that reads `document` before its first mount imports `kay/test/dom`, which registers the DOM at once. Put the import last, where the kay lint preset sorts a side-effect import: every import runs before a test body, so the order changes nothing there. An earlier import that captures `setTimeout` as it loads is the exception, and needs it first.

```ts
import { expect, it } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Toggle from '../src/components/toggle.kay'

it('opens its panel on a click', async () => {
  const { root, unmount } = await mountComponent(Toggle)

  root.querySelector('button')!.click()
  await settle()

  expect(root.querySelector('.panel')?.textContent).toBe('Open')
  unmount()
})
```

On a French site, the component writes the same non-breaking spaces before `: ; ! ?` as it does in the browser, once the test sets `document.documentElement.lang` to `fr`.

A component that calls a route of an API module, your own, can be mounted too. The call goes out as a `fetch`, so stub `fetch` in the test to answer it.

## A database for each test file

An app that keeps its data with `@kaynooo/pg-orm` and has a `pg-orm.config.ts` and a `DATABASE_URL` (in `.env.test`) gets a database for each test file with nothing to declare. `kay/test/preload` copies the database your migrations build, points `DATABASE_URL` at the copy and drops it when the file is done. `kay new --template app --with postgres` is set up this way.

To start every file with some rows, export a function that adds them from `tests/seed.ts`.

```ts
// tests/seed.ts
import type { Database } from '@kaynooo/pg-orm'
import { Member } from '../src/db/member'

export default async function seed(db: Database): Promise<void> {
  await db.repo(Member).write.insertOne({ name: 'Ada' })
}
```

Each file gets a copy of the database the migrations build, with what `seed` adds. `kay test` runs each file in modules of its own, so each reads its own copy. A plain `bun test` would share one copy among the files, so the preload refuses it and names `kay test`.

An app that wrote its own `tests/database.ts` with `testDatabase()` deletes that file and its line in `bunfig.toml`, and moves its seed to `tests/seed.ts`.

`pg-orm.config.ts` may import the app's own `db` module: the modules it loads are loaded again once the copy is made, so they connect to the copy.

Sessions kept with `sqliteStore` stay in memory under `bun test`, so no test leaves a file or shares a session with another file, and the app writes no `NODE_ENV` check for it.

The database in `.env.test` need not exist. A SQLite file is made on first use, and a Postgres user only needs `CREATEDB`.

## Content in a test

A test never writes into your `src/content`. A folder collection moves to a copy under `.kay/scratch` the first time a save, a delete or a CMS screen reaches it, and the site reads it from there. A file you wrote straight into `src/content` after that is not seen, and the file a save wrote is not in your project.

`site.content` starts a test from known content:

```ts
await site.content.reset({
  posts: [{ slug: 'hello', data: { title: 'Hello' }, body: 'Hi' }],
})
```

- `reset()` puts everything back: folders are read from the project again and loaded collections go back to their own source.
- `reset(seed)` and `seed(name, entries)` make a collection hold exactly the entries you list. Give a localized collection's entries a `locale`.
- `write(name, file, text)` writes a raw file in the copy, for an entry that does not parse.

A loaded collection's seed is kept in memory. Its `load`, `get` and `count` read it, and its `save` and `remove`, where it has them, change it. Your database or API is never touched.

## Several projects

One test process serves one project. When test files call `testSite({ root })` on different folders, run them with `bun test --parallel`, which gives each file a process of its own.

You can also run each folder's tests on their own with `KAY_ROOT=<folder> bun test <files>`. A second root in the same process throws an error that says this.

## Smaller helpers

A test that drives an Elysia app of its own, rather than `testSite`, keeps a browser's cookies with `cookieJar()`. `jar.send(handle, request)` sends the cookies kept so far and keeps the ones the response sets.

A test gives a variable of `env` another value with `overrideEnv(env, { MEDIA_DIR: dir })`, and `restore()` puts it back. Write `using override = overrideEnv(...)` to have it put back when the test ends, even when it fails.

A module reading `env.MEDIA_DIR` when it runs sees the new value, but one that copied or destructured it at import keeps the old one.

The value is not checked against the schema, so a string given to a number field stays a string. Undo overrides in reverse order, as `using` does. Tests running at the same time share one `env`, and `publicEnv` is read apart, so an override never reaches it.

`solveWork(challenge)` solves a proof-of-work challenge as kay's script does. `scratchDir(prefix)` makes a fresh directory under `.kay/scratch`, which no build or check reads.

## Islands that fail the browser build

Every `testSite()` call builds the islands for the browser. It throws that build's error when one fails, such as an island importing a module that reaches `bun:sqlite` or the database. Pages still render without scripts, and no browser is needed.

A `.kay` file that does not compile is the exception: only the visit of a page importing it answers 500 and logs the error naming the file, so the tests of other pages stay green; a file no page imports goes unreported. A site opened with `browser` needs the whole build and throws it.

The build goes to `.kay/test-client`, so what `kay build` wrote stays as it was. It runs once per process while the files under `src`, your routes and your API are unchanged.

The `kay/test/preload` in your bunfig.toml gives every test and hook 20 seconds, so a hook that stops the server or drops a database does not fail on a busy machine. Set `timeout` under `[test]` in bunfig.toml to choose another time, which hooks then follow too. The `--timeout` flag does the same on Linux. On a large app the build may outlast 20 seconds. Pass `testSite({ islands: false })` to skip it, or a longer timeout to `beforeAll`.

## In a browser

For what only a browser does, use `testSite({ browser: true })`. It serves the islands it builds, and `site.open(path)` loads the page in headless Chrome.

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ browser: true })

it('counts the clicks', async () => {
  await using page = await site.open('/')

  await page.click('button.counter')
  await page.waitFor('button.counter', { text: 'Clicked 1' })
  expect(page.errors).toEqual([])
})
```

A page stays open until it is closed, which `await using` does when the test ends. A browser holds six connections to a host and each open page following a live value keeps one, so the seventh page waits for one: its load fails at the timeout, saying how many other pages are open.

The page clicks and types as a user does.

| Call | Does |
| --- | --- |
| `click(selector, { modifiers })` | Scrolls to the element once the page finished loading, waits until it is visible, still and not covered, and clicks, holding the keys in `modifiers` such as `['Alt']`. Covered at the middle of the view, by a fixed bar for instance, it is scrolled to the other alignments and aimed at the first point of its box nothing covers, once it keeps still (up to about a second); covered everywhere, it fails naming what covers it |
| `hover(selector)` | Scrolls to the element once the page finished loading and moves the pointer onto its middle, where it stays |
| `fill(selector, text)` | Replaces a field's text, as typing does |
| `type(text)`, `press(key)` | Type or press a key in the focused element |
| `text(selector)`, `value(selector)`, `count(selector)` | Read the page at once |
| `waitFor(selector, { text, gone })` | Waits for an element, or for none |
| `waitUntil(fn)` | Waits until a function run in the page returns something truthy |
| `evaluate(fn, ...args)` | Runs a function in the page |
| `goto`, `back`, `forward`, `reload`, `path()` | Navigate and read where the page is |
| `upload(selector, files)` | Puts files, given by path, in a file input, as the picker does |
| `onDialog(handler)` | Answers the page's `alert`, `confirm`, `prompt` and `beforeunload` dialogs |

The waits give up after 5 seconds, or after `timeout` in their options, and fail naming what they waited for. `evaluate` and `waitUntil` send only the source of the function, so it sees no variable of the test, only its arguments.

`page.view` is the `Bun.WebView` behind the page, for what the helpers leave out, such as `screenshot()` or `cdp()`.

```ts
await page.view.screenshot()
await page.view.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
```

A page behind a session opens signed in with `cookies`, a `Cookie` header string such as `auth.sessionCookie(userId)` returns, or a list of `{ name, value }`.

```ts
const page = await site.open('/account', { cookies: await auth.sessionCookie(user.id) })
```

A page opens as a visitor with other settings through the same options. `colorScheme: 'dark'` and `reducedMotion: 'reduce'` set the preferences the page reads, `javaScript: false` turns JavaScript off so a test sees what the server rendered, and `page.warnings` lists the console warnings the way `page.errors` lists the errors.

```ts
const plain = await site.open('/signup', { javaScript: false })

await plain.fill('input[name="email"]', 'ada@example.com')
await plain.click('form button')
await plain.waitFor('.notice', { text: 'Check your inbox' })
```

A dialog stays open until it is answered, and the page waits on it. `page.onDialog(handler)` answers each one: the handler gets its `type`, `message` and `defaultPrompt`, and returns `true` to accept, `false` to dismiss, or a string to answer a prompt. Register it before the action that opens the dialog, as a dialog nobody answers stays open and stops the page. A handler that throws dismisses the dialog and records the error in `page.errors`.

```ts
await page.onDialog(dialog => dialog.message.startsWith('Delete'))
await page.click('button.delete')
```

`browse(url)` from `kay/test` opens the same page for a server that is already running, such as one the test started itself.

### The network

`page.responses` lists every response the page received so far: its `url`, `method`, `status` and `type`, and its `requestHeaders` and `responseHeaders` as the wire carried them, lowercased. The request headers include the ones the browser adds itself, such as `accept-encoding` or `cookie`.

`page.waitForResponse(match)` resolves with the first response whose URL matches, once its body arrived, or on its headers with `{ complete: false }` for one that never ends, such as an event stream. `page.responses.length = 0` empties the list.

```ts
await page.click('button.save')

const saved = await page.waitForResponse('/api/save')

expect(saved.status).toBe(200)
expect(saved.requestHeaders['content-type']).toBe('application/json')
```

A `match` is a string with `*` for any characters, a `RegExp` on the whole URL or a function of the `URL`. A string starting with `/` matches the path on the site the page is on, a mount point included: `/docs/api/*` for an app under `/docs`.

`page.route(match, handler)` answers the requests the page makes from then on. The handler calls `fulfill`, `abort` or `continue` on the request. A request the handler answers none of goes on to the server. The latest route that matches a request answers it, and `page.unroute(match?)` stops one route, or every route without an argument.

```ts
await page.route('/api/*', request => request.fulfill({ status: 503, json: { error: 'down' } }))
await page.route('/avatar.png', request => request.abort('connectionrefused'))
await page.route('/', async (request) => {
  const answer = await request.fetch()

  await request.fulfill({ ...answer, body: answer.text().replace('Hello', 'Bonjour') })
})
```

`request.fetch()` lets the request reach the server and resolves with its decoded answer, `status`, `headers`, `body` and `text()`, for the handler to pass on changed.

It cannot read an event stream, whose body never ends, so a route that fetches should not match one. A handler that throws is reported in `page.errors` and its request fails.

`page.offline()` cuts the page off the network, so every request fails and `navigator.onLine` is false, and `page.online()` brings it back. `page.initScript(fn, ...args)` runs a function in every document the page loads from then on, before the document's own scripts, to set up a stub or a flag the page reads as it starts.

```ts
await page.offline()
await page.click('button.sync')
await page.waitFor('.banner', { text: 'You are offline' })
await page.online()
```

While a route exists the browser's cache is off, as a response it served from its cache would never reach the route. That also means no cache hit or 304 happens while a route exists. The cache is on again after the last `unroute`.

The view runs one DevTools command at a time, so use `page.cdp(method, params)` where `page.view.cdp()` would be called: it queues behind the page's own commands and a route's.

### Checking accessibility

`page.a11y(selector?)` checks the page as it stands, or only the elements the selector matches, with axe-core, as `kay dev` does. It resolves with the rules the page breaks, and with none when it passes.

```ts
const broken = await page.a11y()

expect(broken.map(rule => rule.id)).toEqual([])
```

Each rule has an `id` such as `color-contrast`, an `impact`, `help`, a `helpUrl` and its `nodes`, the elements breaking it as `{ target, html }`.

A page that does not settle in time fails `open()`, naming the files it could not load, such as an island's chunk answering 404. A page whose renderer crashes fails its next call at once, not at the test's timeout.

The browser is `Bun.WebView` on Chrome. Kay finds Chrome on the `PATH`, or reads `BUN_CHROME_PATH`. Use `describe.skipIf(browserPath() === undefined)` to skip a suite when there is none.

Chrome's profile lives in the temp directory while the browser runs. Chrome stays open for five minutes after the last page closes, so a file pausing between pages starts it once, and kay closes it after the run, when `kay/test/preload` kills every process Chrome started.

<ReadMore href="/llms/testing">Running jobs, mounting one component with its props, how the browser is found and closed and every browser helper in detail are in the full testing reference.</ReadMore>
