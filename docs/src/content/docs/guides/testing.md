---
title: Testing
order: 8
description: Test pages and actions in-process with kay/test, and drive a real browser when you need one.
---

`kay/test` serves your pages and actions inside the test process, with no server and no browser. It does build your islands for the browser, so a test fails when one cannot be built. `kay new` writes the `bunfig.toml` preload and a first test; run them with `bun test`.

## Rendering a page

`testSite()` gives a site. `visit` GETs a page and follows redirects, and resolves with `{ url, status, headers, html }`:

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

The page also has `meta(key)`, `canonical()`, `jsonLd()`, `links()`, `find(selector)`, which returns `{ tag, attributes, text }` for each match, and `text(selector)`, the text a visitor reads in the first match, or in the whole body. Assert on text through these rather than on `page.html`: an island's markup holds hydration markers inside an interpolated text, so `Thanks, {name}!` is not one string there.

## Posting an action

Import the action from its page and `submit` it as a form post without JavaScript. It follows the redirect back, or reads the page a refused post renders:

```ts
import { add } from '../src/routes/index.kay'

it('shows why a book was refused', async () => {
  const page = await site.submit(add, { title: '' }, { from: '/' })

  expect(page.text('.error')).toBe('Write a title')
})
```

`site.call(action, input)` calls an action as an island does, and throws `ActionError` when it fails. `site.refusal(action, input)` makes a call expected to be refused and resolves with that `ActionError`, its `status`, `errors` and `data` typed from the handler; it fails the test when the call goes through.

An action with `minTime` takes the post as if its form had been open long enough, so a test of something else needs no waiting. A test of the minimum itself says how long the form was open: `{ from: '/', openedFor: 0 }` posts as soon as the page loaded. An action with `proofOfWork` gets a solved challenge with each post and call, unless the test sends its own `x-kay-work` header, `''` for none.

A site made at the top of the file posts as a new client in each test, so a rate limit counts the posts of one test only.

## Signed-in users

Cookies a response sets go with the next request, so an app on `session()` stays signed in across calls. `use` takes the plugins the server entry uses, and `locals` stands in for a `derive`:

```ts
const site = await testSite({ use: [sessions] })
const admin = await testSite({
  locals: () => ({ user: { id: 1, admin: true } }),
})
```

## One component

`mount(file, props)` renders one component into `document`, for what its handlers and effects do. List `kay/test/dom` after the preload, with `@happy-dom/global-registrator` installed as a dev dependency. It registers happy-dom's DOM for every test file, and adds the popover API happy-dom lacks:

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

## Smaller helpers

A test that drives an Elysia app of its own, rather than `testSite`, keeps a browser's cookies with `cookieJar()`. `jar.send(handle, request)` sends the cookies kept so far and keeps the ones the response sets. `solveWork(challenge)` solves a proof-of-work challenge as kay's script does. `scratchDir(prefix)` makes a fresh directory under the project's `.kay/scratch`, which no build or check reads.

## In a browser

Every `testSite()` call builds the islands as `kay build` does, and throws that build's error when one fails, such as an island importing a module that reaches `bun:sqlite` or the database. Pages still render without scripts, and no browser is needed. The build runs once per process while the files under `src`, your routes and your API are unchanged, and costs a fraction of a second on a small app. `testSite({ islands: false })` skips it.

For what only a browser does, `testSite({ browser: true })` builds the islands and `site.open(path)` loads the page in headless Chrome. The build goes to `.kay/client`, or `.kay/client-<n>` in each worker of `bun test --parallel`, so test files running at once never overwrite each other's; a worker's `pages({ prebuilt: true })` reads its own `.kay/client-<n>` too, not what a `kay build` run before the tests left:

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

<Callout type="note">

A page that does not settle in time fails `open()`, naming the files it could not load, such as an island's chunk answering 404.

The browser is `Bun.WebView` on Chrome. kay finds Chrome on the `PATH`, or reads `BUN_CHROME_PATH`. `describe.skipIf(!browserPath())` skips a suite when there is none. Chrome's profile lives in the temp directory only while the browser runs: kay closes it a second after the last page closes, and once the tests ran, `kay/test/preload` closing it after the run. Closing it also closes a `Bun.WebView` the test made itself, and kills every process Chrome started, which Alpine's Chromium leaves running otherwise.

</Callout>

<ReadMore href="/llms/testing">Jobs, websockets and streams, mounting one component, per-test databases and every browser helper are in the full testing reference.</ReadMore>
