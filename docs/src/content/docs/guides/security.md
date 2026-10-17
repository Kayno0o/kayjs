---
title: Security
order: 9.2
description: What kay protects by default, and how to adjust the security headers, Content-Security-Policy, rate limits, request size limit, proxy trust and CORS.
---

kay is safe by default. Every response carries security headers, a form refuses a post from another site, and a request has a size limit. This page shows how to adjust each one.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  security: {
    csp: { 'img-src': ['\'self\'', 'https://images.example.com'] },
    headers: { 'strict-transport-security': 'max-age=63072000; includeSubDomains' },
  },
  proxy: true,
  bodyLimit: 4 * 1024 * 1024,
})
```

## Security headers

Every response carries a Content-Security-Policy and the headers below. Your own routes get them too.

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `SAMEORIGIN`, following the policy's `frame-ancestors` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-site` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb and browsing-topics refused |

`security` in `kay.config.ts` changes them. `headers` merges over kay's, and a header set to `false` is not sent. `security: false` sends none of them.

HSTS is not sent by default. It binds the domain to https for its whole `max-age`, which no later deploy can take back, so it is your call.

## Content-Security-Policy

The default policy lets in your own origin, `data:` and https images, and kay's own inline scripts by hash. It uses no `'unsafe-inline'` for scripts and no nonce.

```text
default-src 'self';
script-src 'self' <kay's hashes>;
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

`csp` merges directives over kay's. A directive set to `false` is left out, and `csp: false` sends no policy.

```ts
export default defineConfig({
  security: {
    csp: {
      'img-src': ['\'self\'', 'https://images.example.com'],
      'frame-ancestors': false,
    },
  },
})
```

Do not set `'script-src': false` unless you mean it. kay's inline scripts then fall back to `default-src` and are blocked, and islands stop hydrating.

<ReadMore href="/llms/proxy-and-security#security-headers">Which inline scripts kay writes, how `X-Frame-Options` follows `frame-ancestors`, and the hashes for a policy written elsewhere.</ReadMore>

## Try a policy before enforcing it

`reportOnly` sends a stricter policy as `Content-Security-Policy-Report-Only`. The browser blocks nothing it allows, and reports what the stricter policy would have blocked.

```ts
export default defineConfig({
  security: {
    reportOnly: { 'style-src': ['\'self\''] },
    reports: true,
  },
})
```

`reports: true` has browsers send the reports to `/_kay/csp`, a route of kay's. Each violation is logged once per process and passed to `onError` as a `CspViolation`. `reports: 'https://...'` sends them to your own collector instead.

When the report looks clean, move the directives into `csp`.

## A policy for one page

A page adds sources for its own responses with `security` in its `page`. Use it for one page that needs a CDN script or a worker, while the rest of the site keeps the strict policy.

```ts
export const page = {
  security: {
    csp: { 'script-src': ['https://cdn.example.com'], 'worker-src': ['blob:'] },
    headers: { 'cross-origin-embedder-policy': 'require-corp' },
  },
}
```

Its `csp` adds sources to the site's directives and never replaces them, so a page cannot loosen the policy by dropping one. A layout's `security` applies to every page under it, and the page's own is applied after it.

A static export has no server to send these headers, so the host sets them instead.

## Cross-origin headers that block popups and embeds

Two defaults surprise apps. `Cross-Origin-Opener-Policy: same-origin` cuts a page off from a popup of another site. A sign-in or payment popup that answers through `window.opener` needs `'cross-origin-opener-policy': 'same-origin-allow-popups'`.

`Cross-Origin-Resource-Policy: same-site` stops another site from embedding your images and files. If you want that, send `'cross-origin-resource-policy': 'cross-origin'`.

A site that needs a feature `Permissions-Policy` refuses, such as geolocation for a map, sends its own `'permissions-policy': 'geolocation=(self)'`. It replaces kay's.

## Rate limits

A rate limit answers 429 once a client has posted too often. Set it on an action in the third argument.

```kay
--- server
export const contact = action(schema, send, {
  rateLimit: { max: 5, window: '1m' },
})
---
```

It counts every attempt, valid or not. Add `count: 'succeeded'` to count only the posts that went through, so typos lock no one out. An IPv6 client counts as its /64 block.

### Counting a person, not an address

`key` counts a post under something other than the client's address, such as the signed-in person, so each has their own allowance from any address and many behind one address do not share one.

```ts
rateLimit: { max: 20, window: '1m', key: async ctx => ctx.locals.session.get('userId') }
```

It takes `request`, `locale`, `cookies`, `locals` and `client`, and gives a text or a promise of one. The limit counts before the guards run, so `locals` holds what the app's `derive` adds, such as `session`, and not what a guard sets. When the key gives `undefined`, an empty text or something else than a text, or throws, the client's address counts instead, so a failing key never lifts the limit.

The refusal carries `Retry-After`, and the form shows when to try again. Several limits can apply at once, as a list, and the longest wait is the one told.

Counts live in the process. For several processes on one machine, share a file store.

```ts
import { sqliteRates } from 'kay/server'

rateLimit: { max: 5, window: '1m', store: sqliteRates('data/rates.sqlite') }
```

`sqliteRates` stores each key hashed, so the file alone cannot be checked against a guessed address.

### Your own store

`store` takes a `RateStore`, from `kay`, to count in Redis or a database. `hit` adds a weight under a key, one attempt unless given, and opens a window when none is open. It answers with the count so far, this hit included, and when the window closes.

```ts
import type { RateStore } from 'kay'

const store: RateStore = {
  hit: async (key, windowMs, weight = 1) => {
    const count = await redis.incrby(key, weight)

    if (count === weight)
      await redis.pexpire(key, windowMs)

    return { count, resetAt: Date.now() + await redis.pttl(key) }
  },
}
```

`peek(key)` is optional. It reads the open window without counting, which a limit set to `count: 'succeeded'` needs.

<ReadMore href="/llms/action-protection#rate-limits">Several limits at once and the exact counting rules.</ReadMore>

## Rate limit a guard or an API route

Outside an action, use `rateLimit(name, { max, window })` from `kay/server`. Call `hit` with the request, and it gives the seconds to wait once the client is over the limit.

```ts
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

Pass your own key to count something other than the client, such as `visits.hit(user.email)`.

A third argument counts several at once. With `max` set to tokens, `budget.hit(user.email, undefined, usage.tokens)` caps the tokens a visitor spends, not their requests.

Honeypots, a minimum time and proof of work protect a form from bots too. `minTime` also takes `plain: true` for plain forms only. They are in [Forms and actions](/essentials/forms-and-actions#rate-limit-honeypot-minimum-time-and-proof-of-work).

## Proof of work checked in your own code

`proofOfWork: true` on an action checks the work for you. For a form your code checks itself, such as a sign-up handled in an API route, `workChallenge` and `verifyWork` from `kay/server` do the same, bound to a name you pick.

```kay
---
import { workChallenge } from 'kay/server'
---
form(method="post" action="/api/contact")
  input(type="hidden" name="proof" data-kay-work={workChallenge('contact')})
  button Send
```

kay's script solves the challenge once the form takes focus, and posts the solution as the field's value. The handler checks it.

```ts
import { verifyWork } from 'kay/server'

const refusal = await verifyWork(input.proof, 'contact')

if (refusal !== undefined)
  deny(422, 'Please try again')
```

`verifyWork` answers `undefined` once for each solution. Otherwise it says `missing`, `expired` or `wrong`. A solution can pass only once, so replaying one fails.

Both take a `difficulty`, 100,000 by default, and `workChallenge` takes a `maxAge`, a day by default. Pass `store` to `verifyWork`, such as `sqliteRates(path)`, to share the used solutions between processes.

<ReadMore href="/llms/action-protection#proof-of-work-checked-in-code">The refusal values and what a prerendered page does.</ReadMore>

## The request body limit

An action or an API route accepts 1 MB at most. A larger request is refused before anything reads it.

```ts
export default defineConfig({
  bodyLimit: 4 * 1024 * 1024,
})
```

Raise it for one action in its third argument, `{ bodyLimit: 20 * 1024 * 1024 }`, for an API module with `api({ bodyLimit })`, or for one route with `detail: { bodyLimit }`. A form that takes files usually needs this.

A form post goes back to its page with a message, an island's call throws an `ActionError` with status 413, and an API route answers 413. Bun's own cap of 128 MB still holds over any `bodyLimit`.

<ReadMore href="/llms/action-protection#body-limit">The refusal message in your own words, and the cap on routes that are not actions or API routes.</ReadMore>

## Trust a proxy

Behind nginx, Caddy or Cloudflare, every request comes from the proxy. Without help, rate limits count the proxy as one visitor. Say how many proxies sit in front.

```ts
export default defineConfig({
  proxy: true,
})
```

`true` is one proxy, and `2` is two, such as Cloudflare then nginx. To read a header the proxy sets, name it: `proxy: { header: 'cf-connecting-ip' }`.

Only trust a proxy every request goes through. If a visitor can reach the server past it, they can write the header themselves.

kay reads the proxy's header only for a request from this machine or a private network. A server that a CDN reaches from public addresses lists them in `trusted`.

```ts
export default defineConfig({
  proxy: { header: 'cf-connecting-ip', trusted: ['173.245.48.0/20', '2400:cb00::/32'] },
})
```

Each entry is an IPv4 or IPv6 range or a single address. Cloudflare publishes the full list.

Pass `X-Forwarded-Proto` from the proxy on every location, websockets included. kay's cookies are `Secure`, and the session is named `__Host-session` over https, so a request that says `http` reads no session.

<ReadMore href="/llms/proxy-and-security#behind-a-proxy">How `hops` reads `X-Forwarded-For`, the warnings kay logs and `clientAddress` in a plain Elysia app.</ReadMore>

## Allow another site to call an API

A browser blocks a page of another origin from calling your API. Name the origins an API module accepts with `cors`.

```ts
export default api({
  cors: { origins: ['https://app.example.com', 'https://*.example.org'] },
})
```

A module without `cors` refuses every other origin. The module's rule is the only place that grants access.

`cors` in kay.config.ts is the default of every module that sets none, and `api({ cors: false })` opts a module out.

<ReadMore href="/llms/api-routes#cors">Credentials, preflight answers, exposed headers and the wildcard origin.</ReadMore>

## A post from another site

An action and an API route refuse a post another site sends, from its `Origin` or `Sec-Fetch-Site` header. The refusal is a 403 that says what it saw.

Code on a plain Elysia route that kay does not reach asks for itself. `crossSiteRefused(request)` from `kay/server` is true for a browser's cross-site POST or websocket upgrade. `crossSiteResponse(request, 'request')` is the 403 to answer with, saying what the request sent and what kay took for the site. Pass `'action'` as the second argument for a form post.

```ts
import { Elysia } from 'elysia'
import { crossSiteRefused, crossSiteResponse } from 'kay/server'

new Elysia().post('/hook', ({ request }) => {
  if (crossSiteRefused(request))
    return crossSiteResponse(request, 'request')

  return handle(request)
})
```

If you see it in development, open the site by the address it is served on. Behind a proxy that does not pass the `Host` on, set `site` in `kay.config.ts` to the public address.
