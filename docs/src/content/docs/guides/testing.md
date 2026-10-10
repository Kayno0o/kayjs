---
title: Testing
order: 8
description: Test pages and actions in-process with kay/test, and drive a real browser when you need one.
---

`kay/test` serves your pages and actions inside the test process, with no server and no browser build. `kay new` writes the `bunfig.toml` preload and a first test; run them with `bun test`.

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

The page also has `meta(key)`, `canonical()`, `jsonLd()`, `links()` and `find(selector)`, which returns `{ tag, attributes, text }` for each match.

## Posting an action

Import the action from its page and `submit` it as a form post without JavaScript. It follows the redirect back, or reads the page a refused post renders:

```ts
import { add } from '../src/routes/index.kay'

it('shows why a book was refused', async () => {
  const page = await site.submit(add, { title: '' }, { from: '/' })

  expect(page.html).toContain('Write a title')
})
```

`site.call(action, input)` calls an action as an island does, and throws `ActionError` when it fails.

## Signed-in users

Cookies a response sets go with the next request, so an app on `session()` stays signed in across calls. `use` takes the plugins the server entry uses, and `locals` stands in for a `derive`:

```ts
const site = await testSite({ use: [sessions] })
const admin = await testSite({
  locals: () => ({ user: { id: 1, admin: true } }),
})
```

## In a browser

For what only a browser does, `testSite({ browser: true })` builds the islands and `site.open(path)` loads the page in headless Chrome:

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

The browser is `Bun.WebView` on Chrome. kay finds Chrome on the `PATH`, or reads `BUN_CHROME_PATH`. `describe.skipIf(!browserPath())` skips a suite when there is none.

</Callout>

<ReadMore href="/llms/testing">Jobs, websockets and streams, mounting one component, per-test databases and every browser helper are in the full testing reference.</ReadMore>
