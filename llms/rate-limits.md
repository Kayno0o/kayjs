# Rate limits

How many times a client may do something in a window, on actions, in guards and API routes, and how kay's libraries name theirs. A limit is `{ max, window }` with `window` a duration string such as `'1m'`, `key` naming who is counted and `store` where the counts live.

## Common tasks

### Limit an action

`rateLimit` in an action's third argument answers 429 past `max` posts every `window`, before the handler; the rest of the action's protection is in [Protecting actions](action-protection.md):

```kay
--- server
import { s } from 'kay'

export const subscribe = action(
  s.Object({ email: s.String({ format: 'email' }) }),
  async ({ email }) => email.length,
  { rateLimit: { max: 5, window: '1m' } },
)
---
form(action={subscribe})
  input(field="email")
  error
  button Subscribe
```

### Limit attempts in a guard or an API route

`rateLimit(name, { max, window })` from `kay/server` counts attempts from the request's client and gives the seconds to wait once over the limit:

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'
import { rateLimit } from 'kay/server'

const visits = rateLimit('account', { max: 60, window: '1m' })

export default guard(async ({ request, headers, deny }) => {
  const wait = await visits.hit(request)

  if (wait !== undefined) {
    headers.set('retry-after', String(wait))
    deny(429, `Too many requests; try again in ${wait} s`)
  }
})
```

An API route or module sets its own with `api({ rateLimit })` or the route's `detail`, see [API routes](api-routes.md#limits).

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
- `store: sqliteData(path)` in kay.config.ts (or `store: { rates }`) is where every limit naming no `store` counts, kay's own login-less routes aside, so one line shares the counts of all of them between replicas.
- `rateLimit: { max: 5, window: '1m', store: sqliteRates('data/rates.sqlite') }`, `sqliteRates` from `kay/server`, counts every process of the machine opening that file together, which stores each key pseudonymised as an HMAC keyed by the session's, the app's (`secret`, `KAY_SECRET`) or the preview's secret once one is set, else by a random key in `<path>.key` beside the file.
- `RateStore`, a `hit(key, window, weight)` method, `window` a `Duration` string such as `'60000ms'` (`durationMs` from `kay` turns it into milliseconds), adding `weight` (one unless given) to the count and giving `{ count, resetAt }` and, for a limit counting what went through, a `peek(key)` giving the open window without counting or `undefined`, is the shape of an app's own.

### Outside an action

- A guard, an API route or a library limits attempts the same way with `rateLimit(name, { max, window, store })` from `kay/server`: `await limit.hit(request)` counts one from the request's client and gives the seconds to wait once over the limit, else `undefined`.
- `await limit.hit(user.email)` counts under the app's own key instead, such as an account or a socket, whoever sends the request.
- `await limit.hit(user.email, undefined, tokens)` counts `tokens` at once, a whole number from 1, so `max` caps tokens or bytes rather than attempts; a store of the app's own must add the weight, and one ignoring it throws when a window's first hit shows it.
- Limits of one name count together; an action's counts under its URL.

- A library or route limiting attempts its own way reads the client as `rateLimit` does: `clientAddress(request, server)` and `rateKey(address)` from `kay/server` give the address, read through the `proxy` setting, and the key a limit counts it under, an IPv6 address's /64 block. A library guarding what kay's actions and API do not reach reads `crossSiteRefused(request, site?)` from `kay/server`, true for a browser's cross-site POST or websocket upgrade that no `api({ cors })` module let in, `site` an extra public URL whose host counts as the request's own; `crossSiteResponse(request, 'action' | 'request', site?)` from `kay/server` is the 403 `Response` for one it refused, headed `Cross-site action refused` or `Cross-site request refused`, saying the `Origin` or `Sec-Fetch-Site` it saw and the origins kay took for the site.

### In the libraries

- Every library names its limits as an action does: `rateLimit`, with `max`, `window`, `store?` and `key?`, and `false` lifts a default one.
- kayjs-ai takes `ai({ rateLimit, budget, key })` and `ask(messages, { key })`, see [Limits and the token budget](../packages/ai/llms/limits.md).
- kayjs-auth takes `createAuth({ rateLimit: { signIn: { max, window } } })`, one entry per kind of attempt, see [Limits](../packages/auth/llms/hardening-and-testing.md#limits).
- kayjs-mail's contact form takes the action's `protection: { rateLimit }` ([Contact form](../packages/mail/llms/contact-form-and-testing.md)); `smtp({ rateLimit: { max: 5, window: '1s' } })` caps the mails sent, and `MAIL_RATE_LIMIT=5/1s` sets it from the environment.
- The old names `limit`, `visitor` and `limits` still work and `kay check` finds them (`deprecated-rate-limit`).
