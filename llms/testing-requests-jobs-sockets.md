# Testing requests, jobs, sockets and sessions

## Common tasks

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

## Reference

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
