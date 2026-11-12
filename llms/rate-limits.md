# Rate limits

How many times a client may do something in a window, on actions, in guards and API routes, and how kay's libraries name theirs. A limit is `{ max, window }` with `window` a duration string such as `'1m'`, `key` naming who is counted and `store` where the counts live.

## Common tasks

### Limit an action

`protect.rateLimit` in an action's third argument answers 429 past `max` posts every `window`, before the handler; the rest of the action's protection is in [Protecting actions](action-protection.md):

```kay
--- server
import { s, action } from 'kay'

export const subscribe = action(
  s.Object({ email: s.String({ format: 'email' }) }),
  async ({ email }) => email.length,
  { protect: { rateLimit: { max: 5, window: '1m' } } },
)
---
form(action={subscribe})
  input(field="email")
  error
  button Subscribe
```

### Limit attempts in a guard or an API route

`rateLimit(name, { max, window })` from `kay/server` counts attempts from the request's client; `await limit.enforce(ctx)` counts the guard's request and, once over the limit, sets `Retry-After` and denies with 429 in one call:

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'
import { rateLimit } from 'kay/server'

const visits = rateLimit('account', { max: 60, window: '1m' })

export default guard(async (ctx) => {
  await visits.enforce(ctx)
})
```

An API route or module sets its own with `api({ rateLimit })` or the route's `detail`, see [API routes](api-routes.md#limits).

### Share one limit between an action, a guard and an API route

The object `rateLimit()` returns is a limit: give it to `protect: { rateLimit: visits }`, `api({ rateLimit: visits })` or `page.rateLimit` and they count in the guard's counter, so one client has one allowance across all of them. An options object keeps counting apart, as before, and so does a copy of the object (`{ ...visits, max: 5 }` is a limit of its own).

- A guard calling `visits.enforce(ctx)` on the same object as an action behind it counts a post twice: once in the guard, once in the action.
- On a layout's `page.rateLimit` a shared object counts every page under the layout together, where a plain options object counts each route apart.
- kayjs-auth and kayjs-ai take `onLimit` but not a `rateLimit()` object, as they count under keys of their own, not the client's address: one is refused at boot.

### Hear of the refused requests

`onLimit` in a limit is called with `{ name, key, wait, request }` each time it refuses a request, to log it or raise an alarm: `{ max: 5, window: '1m', onLimit: ({ key, wait }) => console.warn(key, wait) }`.

### Count a person instead of an address

`key: ctx => ctx.locals.session.get('userId')` counts a signed-in person, so each has their own allowance from any address and many behind one do not share one; without it, or when it gives `undefined`, the client's address counts.

### Share the counts between processes

`store: sqliteData(path)` in kay.config.ts shares the counts of every limit that names no `store`; `rateLimit: { max: 5, window: '1m', store: sqliteRates('data/rates.sqlite') }` does it for one.

## Reference

### On an action

- `rateLimit` lets one client post `max` times every `window`, then answers 429 with `Retry-After` and `errors['']` saying when to retry.
- It counts every attempt, valid or not, unless it says `count: 'succeeded'`: then only the posts whose handler returned without `ctx.fail`, an error or a refusal count, so typos and a mail server failing lock no one out, a redirect from the handler counting as gone through.
- Posts arriving together all read the count before any adds to it, so a burst may pass `max` by a few.
- Several limits all apply, each counting every attempt it is meant to count whichever refuses it, the longest wait the one told: `rateLimit: [{ max: 30, window: '10m' }, { max: 5, window: '10m', count: 'succeeded' }]` slows a script hammering the form and lets five messages through, each limit counting under its place in the list.
- The client is the address the request came from, or the one the proxies in front passed on once `proxy` says how to read it (see [Behind a proxy](proxy-and-security.md#behind-a-proxy)).
- An IPv6 client counts as its /64 block, which one host or home network holds.
- `key: ctx => ctx.locals.session.get('userId')` counts a person instead of an address, so each has their own allowance from any address and many behind one do not share one; it gives a text or a promise of one, and `undefined`, an empty text, a value that is no text or a throw counts the client's address, the last logged once, so a limit is never lifted. A key over 256 characters is hashed.
- `ctx` holds `request`, `locale`, `cookies`, `locals` and `client`. The limit counts before the guards and the app's `resolve` hooks, so `locals` holds what `derive` adds, a `session()` say, and not what a guard sets; `count: 'succeeded'` counts under the key the check used.
- Counts live in the process unless `store` names a shared one, for at most 10,000 windows per limit, the expired ones dropped first and the oldest past that.
- A limit whose store throws or rejects counts in this process's memory instead, logged once per limit and store until the store answers again, so no request fails for it; a store taking over 8 seconds is also passed over for ten seconds, so a hanging one holds one request, not every one. This holds for an action's limits, an API route's, `rateLimit()`, the proof-of-work solutions and kay's own routes, whether the store is the limit's or the app's `store.rates`, and for kayjs-auth's attempts; kayjs-ai refuses an ask instead, as a paid chat must not run on a count it cannot read.
- `store: sqliteData(path)` in kay.config.ts (or `store: { rates }`) is where every limit naming no `store` counts, kay's own login-less routes aside, so one line shares the counts of all of them between replicas.
- `rateLimit: { max: 5, window: '1m', store: sqliteRates('data/rates.sqlite') }`, `sqliteRates` from `kay/server`, counts every process of the machine opening that file together, which stores each key pseudonymised as an HMAC keyed by the session's, the app's (`secret`, `KAY_SECRET`) or the preview's secret once one is set, else by a random key in `<path>.key` beside the file.
- `RateStore`, a `hit(key, window, weight)` method, `window` in milliseconds, adding `weight` (one unless given) to the count and giving `{ count, resetAt }` and, for a limit counting what went through, a `peek(key)` giving the open window without counting or `undefined`, is the shape of an app's own. An optional `refund(key, resetAt)` takes one attempt back off the window closing at `resetAt`, never below zero and not once that window is gone: kay calls it for a call that started no work (kayjs-ai's resume of a reply it keeps), and a store without it keeps the attempt counted; kay's own stores, memory, SQLite and Postgres, have it. An optional `reset(key)` forgets the window under `key`: kayjs-auth clears a count with it once a sign-in succeeds; kay's own stores have it too.
- A store needs only `hit`: `limiter` derives `peek` (a `hit` of weight 0, which on a store holding no window opens an empty one the next hit joins) and `reset` (a `hit` of minus the open count, which leaves an empty window open, and needs a store that adds a negative weight as it adds any), so no limit, action or library refuses or warns of a store for lacking them.

### `limiter`

- A limit on an API route, module or endpoint file counts after the guards, a `key` reading what they set, and counts a request the guards refuse as well: a refused one over the limit gets the 429 in place of the refusal, so a guard such as `basicAuth` cannot be guessed at full speed. `basicAuth` also limits its own wrong credentials per client by default.
- A page, a layout or an endpoint file takes the same limit in `page`: `export const page = { rateLimit: { max: 30, window: '1m' } }`, one limit or a list, `key` as an action's. Past it the page answers 429 with `Retry-After` through the nearest `_429.kay` or `_error.kay`. It counts after the guards, a request they refuse included, in `store.rates` under the route's pattern; a request a guard refused that is over the limit is answered through the special pages the guard sees, so a `_429.kay` beside the guarded page is not used for it. A layout's applies to each page under it apart, the innermost `rateLimit` winning and `false` lifting it; to share one budget across a section, count in a guard with `rateLimit(name, ...)`. A prerendered page with one is still counted by the kay server serving it, answered `private`; `kay build` warns when it writes one, as a static host cannot count, and does not keep an unmarked page on its own for it.
- `limiter({ max, window, store?, name?, failure?, memory? })` from `kay/server` (and `kay/library`) is the one limit every part of kay counts through: actions, guards, API routes, `rateLimit()`, kayjs-auth, kayjs-ai and kayjs-cms. `hit(key, weight?)` counts and gives `{ count, resetAt }`, `peek(key)` reads the open window without counting, `reset(key)` forgets it, `enforce(key, weight?)` counts and gives the seconds to wait once past `max`, else `undefined`, and `refund(key, resetAt)` takes one attempt back, `false` for a store without `refund`.
- `store` is the app's `store.rates` unless given, read on each call, else this process's memory (`memory` names another place, for a caller that sweeps it). Keys sit under `name` (`'limiter'` unless given), so limiters sharing a store never share a count. A store that fails counts in memory and logs once, unless `failure: 'refuse'`, which lets the error through for a limit that must not lift because it could not be read, as kayjs-ai and kayjs-cms do.

### Outside an action

- A guard, an API route or a library limits attempts the same way with `rateLimit(name, { max, window, store })` from `kay/server`: `await limit.hit(request)` counts one from the request's client and gives the seconds to wait once over the limit, else `undefined`.
- Two `enforce`s, not alike: `limiter().enforce(key, weight?)` counts under a key and answers the seconds to wait, refusing nothing; `rateLimit().enforce(ctx, message?)` is the guard's call below.
- `await limit.enforce(ctx, message?)` takes a guard's `ctx`, counts under the limit's `key` or the client's address, and past the limit sets `Retry-After` and calls `ctx.deny(429, message)`, `message` a text or a function of the seconds to wait.
- `onLimit(refusal)` on a limit (`RateLimitRefusal`: `name`, the key counted, `wait` in seconds, `request` when there is one) runs for each request an action, a page, an API route, `enforce` or `hit` refused, beside the answer, which never waits for it; one that throws or rejects is logged. A limit object from `rateLimit()` shared with an action reports the action's URL as `name`.
- `await limit.hit(user.email)` counts under the app's own key instead, such as an account or a socket, whoever sends the request.
- `await limit.hit(user.email, undefined, tokens)` counts `tokens` at once, a whole number from 1, so `max` caps tokens or bytes rather than attempts; a store of the app's own must add the weight, and one ignoring it throws when a window's first hit shows it.
- Limits of one name count together; an action's counts under its URL.

- A library or route limiting attempts its own way reads the client as `rateLimit` does: `clientAddress(request, server)` and `rateKey(address)` from `kay/server` give the address, read through the `proxy` setting, and the key a limit counts it under, an IPv6 address's /64 block. A library guarding what kay's actions and API do not reach reads `crossSiteRefused(request, site?)` from `kay/server`, true for a browser's cross-site POST or websocket upgrade that no `api({ cors })` module let in, `site` an extra public URL whose host counts as the request's own; `crossSiteResponse(request, 'action' | 'request', site?)` from `kay/server` is the 403 `Response` for one it refused, headed `Cross-site action refused` or `Cross-site request refused`, saying the `Origin` or `Sec-Fetch-Site` it saw and the origins kay took for the site.

### In the libraries

- Every limit is one `RateLimit` (from `kay`, `kay/server` and `kay/library`): `{ max, window, store?, key? }`. Every `rateLimit` option takes one or a list of them, each counted apart, and `false` lifts a default one. kayjs-auth and kayjs-ai count under keys of their own and take no `key`.
- kayjs-ai takes `ai({ rateLimit, budget, key })` and `ask(messages, { key })`, see [Limits and the token budget](../packages/ai/llms/limits.md).
- kayjs-auth takes `authCore({ rateLimit: { signIn: { max, window } } })`, one entry per kind of attempt, each a limit or a list of them, see [Limits](../packages/auth/llms/hardening-and-testing.md#limits).
- kayjs-mail's contact form takes the action's `protection: { rateLimit }` ([Contact form](../packages/mail/llms/contact-form-and-testing.md)); `smtp({ rateLimit: { max: 5, window: '1s' } })` caps the mails sent (one window, in memory: no list, `store` or `key`), and `MAIL_RATE_LIMIT=5/1s` sets it from the environment.
