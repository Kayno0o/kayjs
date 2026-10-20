# Testing in a browser

## Common tasks

### Test an island in a real browser

`testSite({ browser: true })` builds the islands, and `site.open(path)` loads a page in a headless Chrome:

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
  expect(await page.a11y('main')).toEqual([])
})
```

A page behind a session opens signed in with `cookies`, a `Cookie` header string such as kayjs-auth's `auth.sessionCookie(userId)` returns (see [kayjs-auth](../packages/auth/llms/hardening-and-testing.md)) or a list of `{ name, value }`:

```ts
const cookie = await auth.sessionCookie(user.id)
const page = await site.open('/account', { cookies: cookie })

expect(await page.path()).toBe('/account')
```

## Reference

### Browser tests

- `testSite({ browser: true })` serves the islands that `testSite()` builds anyway.
- In each worker of `bun test --parallel`, the processes its tests start included, the build goes into `.kay/client-<n>`, so files running at once keep their builds apart, and a worker's `pages({ prebuilt: true })` reads its own, not what a `kay build` before the tests left.
- `site.open(path)` loads a page in a headless Chrome over a server the site starts on a free port, resolving with a page once it loaded and its islands hydrating on load are done.
- `browse(url, options)` from `kay/test` is the same for a server already running, such as one the test started itself, rather than one `testSite` serves.
- The page clicks as a user does: `click(selector)` scrolls the element to the middle of the view, then waits for it to be visible, still and not covered (a click on an island not hydrated yet is replayed once it is).
- `click(selector, { modifiers })` holds keys such as `['Alt']` for the click; `hover(selector)` scrolls the element to the middle and moves the pointer onto it, where it stays.
- `fill(selector, text)` replaces a field's text as typing does; `type(text)` and `press(key)` go to the focused element.
- `text`, `value` and `count` read the page at once, `text` and `value` null when nothing matches.
- `waitFor(selector, { text, gone })` and `waitUntil(fn)` poll until they hold, 5 seconds at most unless `timeout` gives other milliseconds, and fail naming what they waited for.
- A wait whose function keeps throwing names the last error when it times out.
- `evaluate(fn, ...args)` runs a function in the page, its arguments and result crossing as JSON.
- Only the source of that function crosses, so it sees no variable or helper of the test, only its arguments, and `waitUntil` runs its function the same way.
- `a11y(selector)` checks the page as it stands, or only the elements `selector` matches, with axe-core, as `kay dev` does (see [Checks and lints](checks.md#checks-and-lints)).
- `a11y` resolves with the rules it breaks, none when it passes, each with its `id` (such as `color-contrast`), `impact`, `help`, `helpUrl` and `nodes`, the elements breaking it as `{ target, html }`, `target` their CSS selector.
- Text the colour of its background is reported under `color-contrast`, as `kay dev` reports it.
- `goto`, `back`, `forward` and `reload` resolve once the page settled, a swapped page included, and fail naming the files the page could not load (an island's chunk answering 404, say) when it does not settle in time.
- `path()` reads where the page is.
- `errors` holds the page's console errors and uncaught exceptions.
- Once `errors` logs a problem kay recovers from in production, such as an island that did not match its server markup or had no client chunk, or a message no locale has, the page's next call fails naming it, unless `strict: false` was given to `open` or `browse`, which leaves it in `errors`.
- `lenient: true` returns a page that does not load and hydrate within the timeout as it stands, the reason in `errors`; `colorScheme: 'dark'` asks it for that scheme from its first load.
- Once the page's renderer crashes, killed or out of memory, the call waiting on it and every later one fail at once saying so, rather than at the test's timeout.
- `view` is the `Bun.WebView` behind it, for a `screenshot()` or a raw `cdp()` call; the view runs one `cdp()` at a time, so `page.cdp(method, params)` queues behind the page's own commands and a route's, and is what a test calls.
- `responses` lists every response so far, redirects included, as `{ url, method, status, type, requestHeaders, responseHeaders, complete }`: header names lowercased, the request's as the wire carried them (`accept-encoding`, `available-dictionary`, `cookie`), `type` as DevTools names it (`document`, `fetch`, `script`, `eventsource`...), `complete` once the body arrived. A test empties it with `responses.length = 0`.
- `waitForResponse(match, { timeout, complete })` resolves with the first response matching, received already or not, once it is `complete` (`complete: false` for one that never ends, such as an event stream), and fails naming `match` on timeout.
- A `match` is a string with `*` for any characters, matched against the path (and query when it holds a `?`) on the page's own site when it starts with `/`, whatever the base, else against the whole URL; a `RegExp` on the URL; or a function of the `URL`.
- `route(match, handler)` answers the page's requests from then on, the latest matching route first; the handler gets `{ url, method, type, headers, body, fetch, fulfill, abort, continue }` and may be async. A request it answers none of goes on, one it throws on fails and is reported in `errors`.
- `request.fulfill({ status, headers, body, json })` answers with a response of its own (200 by default, `json` sent as JSON, `content-length` left to the browser), `request.abort(reason)` fails it as a network error (`failed` by default, `connectionrefused`, `timedout`, `accessdenied`, `internetdisconnected`...), `request.continue({ headers })` sends it on, optionally with headers replaced.
- `request.fetch()` sends the request on and resolves with the server's decoded answer `{ status, headers, body, text() }` (without `content-encoding` and `content-length`), kept until the handler fulfils or continues, so it can pass it on changed: `request.fulfill({ ...answer, body: answer.text().replace(...) })`.
- `unroute(match)` stops the routes added with that same `match`, `unroute()` all of them; routing runs on DevTools' Fetch domain, enabled with the first route and disabled with the last, and a page closing with requests paused drops them.
- `offline()` and `online()` cut the page off the network and restore it: every request fails and `navigator.onLine` is false meanwhile.
- `initScript(fn, ...args)` runs a function in every document the page loads from then on, before the document's own scripts, as `evaluate` runs one; the current document is left as it is.
- `cookies` gives the first load of `open` or `browse` a `Cookie` header string (`name=value; other=value`, a value keeping any `=` after the first) or a list of `{ name, value }`, for the site's origin.
- Each page opened starts with no cookie or storage for the site, and pages opened at once share them, the browser's own rather than `site.cookies`.
- `site.close()` closes the pages, sockets and streams it opened, and stops the site without waiting on any connection.

### The browser itself

- The browser is `Bun.WebView` on its Chrome backend, young in Bun and marked experimental, so kay keeps to the part of it these helpers use.
- It runs the executable given as `path`, to `testSite({ browser: { path } })` or `open`, else `BUN_CHROME_PATH`, else the first Chrome or Chromium on the `PATH` or where it usually installs; with none, `open` fails saying so, and `describe.skipIf(!browserPath())` skips a suite instead.
- In an Alpine CI image, `apk add chromium` and `BUN_CHROME_PATH=$(command -v chromium)`; as root, as in a container, Chrome runs without its sandbox.
- Chrome runs on a profile kay makes in the temp directory and removes, with what Bun and Chrome leave beside it, when the browser closes.
- The browser closes a second after the last page closed, so the next test reuses it, and once the tests ran, as bun test runs no exit handler (after the run, or each file of a parallel one, with `kay/test/preload`; else after the file that loaded `kay/test` first), or at exit outside bun test.
- The first page of a later run removes what a killed run left.
- Closing the browser closes every `Bun.WebView` of the process, one the test made itself included, and kills every process Chrome started, which Alpine's Chromium leaves running otherwise.
