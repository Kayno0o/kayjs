---
title: Testing
order: 8
description: Test pages and actions in-process with kay/test, and drive a real browser when you need one.
---

`kay/test` serves your pages and actions inside the test process, with no server and no browser. `kay new` writes the `bunfig.toml` preload and a first test. Run them with `bun test`.

It does build your islands for the browser, so a test fails when one cannot be built. See [Islands that fail the browser build](#islands-that-fail-the-browser-build).

## Rendering a page

`testSite()` gives a site. `visit` GETs a page and follows redirects. It resolves with `{ url, status, headers, html }`.

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

The page also has `meta(key)`, `canonical()`, `jsonLd()` and `links()`. `find(selector)` returns `{ tag, attributes, text, html }` for each match. `text(selector)` gives the text a visitor reads in the first match, or in the whole body.

Assert on text through these, not on `page.html`. An island's markup holds hydration markers inside an interpolated text, so `Thanks, {name}!` is not one string there.

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

An action with `proofOfWork` gets a solved challenge with each post and call. Send your own `x-kay-work` header to override it, `''` for none.

A site made at the top of the file posts as a new client in each test, so a rate limit counts the posts of one test only.

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

## One component

`mount(file, props)` renders one component into `document`. Use it to test what its handlers and effects do.

List `kay/test/dom` after the preload, with `@happy-dom/global-registrator` installed as a dev dependency. It registers happy-dom's DOM for every test file, and adds the popover API happy-dom lacks.

```toml
[test]
preload = ["kay/test/preload", "kay/test/dom"]
```

```ts
import { expect, it } from 'bun:test'
import { mount, settle } from 'kay/test'

it('opens its panel on a click', async () => {
  const { root, unmount } = await mount('src/components/toggle.kay')

  root.querySelector('button')!.click()
  await settle()

  expect(root.querySelector('.panel')?.textContent).toBe('Open')
  unmount()
})
```

## Several projects

One test process serves one project. When test files call `testSite({ root })` on different folders, run them with `bun test --parallel`, which gives each file a process of its own.

You can also run each folder's tests on their own with `KAY_ROOT=<folder> bun test <files>`. A second root in the same process throws an error that says this.

## Smaller helpers

A test that drives an Elysia app of its own, rather than `testSite`, keeps a browser's cookies with `cookieJar()`. `jar.send(handle, request)` sends the cookies kept so far and keeps the ones the response sets.

`solveWork(challenge)` solves a proof-of-work challenge as kay's script does. `scratchDir(prefix)` makes a fresh directory under `.kay/scratch`, which no build or check reads.

## Islands that fail the browser build

Every `testSite()` call builds the islands for the browser. It throws that build's error when one fails, such as an island importing a module that reaches `bun:sqlite` or the database. Pages still render without scripts, and no browser is needed.

The build goes to `.kay/test-client`, so what `kay build` wrote stays as it was. It runs once per process while the files under `src`, your routes and your API are unchanged.

On a large app it may outlast a hook's 5 second timeout. Pass `testSite({ islands: false })` to skip it, or a longer timeout to `beforeAll`.

## In a browser

For what only a browser does, use `testSite({ browser: true })`. It serves the islands it builds, and `site.open(path)` loads the page in headless Chrome.

```ts
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ browser: true })

afterAll(async () => site.close())

it('counts the clicks', async () => {
  const page = await site.open('/')

  await page.click('button.counter')
  await page.waitFor('button.counter', { text: 'Clicked 1' })
  expect(page.errors).toEqual([])
})
```

A page that does not settle in time fails `open()`, naming the files it could not load, such as an island's chunk answering 404. A page whose renderer crashes fails its next call at once, not at the test's timeout.

The browser is `Bun.WebView` on Chrome. Kay finds Chrome on the `PATH`, or reads `BUN_CHROME_PATH`. Use `describe.skipIf(!browserPath())` to skip a suite when there is none.

Chrome's profile lives in the temp directory while the browser runs. Kay closes it a second after the last page closes, and again after the run, when `kay/test/preload` kills every process Chrome started.

<ReadMore href="/llms/testing">Jobs, websockets and streams, mounting one component, per-test databases and every browser helper are in the full testing reference.</ReadMore>
