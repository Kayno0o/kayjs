# Running in production

## Request logs

With NODE_ENV=production, a server's first line, once `.listen()` started it, says where it listens and what runs: `kay: listening on http://localhost:3000, kay 1.30.0 in production, 12 pages prerendered`. Then every request kay or the app's routes registered after `.use(await pages())` answer is logged to stdout as one line: `GET /blog/hello 200 12ms AZnLe0vUe9qD0uXq9vLwZw`, the method, the path without its query string, which may carry tokens, the status, the milliseconds until the response was made, a streamed one's headers, and the request's id. kay's own `/_kay/` routes, assets included, and the health route, wherever `health.path` puts it, are left out. `true` in kay.config.ts's `log` logs them outside production too, `false` never.

kay's own messages, an error it caught, a warning about the app, a shutdown notice, go out in any mode, as `kay: ` and the message, an error's source-mapped stack on the lines below. `log` sets the format of both: `'json'` writes one JSON object per line for a log collector, on stdout for info and on stderr for warnings and errors, and a function receives each entry instead, typed `LogEntry` from `kay/server`:

- a request, `{ type: 'request', time, level: 'info', method, path, status, duration, id }`;
- a message, `{ type: 'message', time, level: 'info' | 'warn' | 'error', message, request?: { method, path, id }, error?: { name, message, stack } }`, `request` when it was logged while answering one.

Every response carries its request's id as `X-Request-Id`, time-ordered, made by kay unless `proxy` is set and the proxy passed one on in that header. An error logged while answering a request is headed by the request, `kay: GET /blog/hello, request AZnLe0vUe9qD0uXq9vLwZw`, then its stack, so a line from a user or a log search finds both. `requestId(request)` from `kay/server` gives it, in `onError` or a route, and a server span carries it as `kay.request.id`.

## Tracing and timing

- `serverTiming: true` in kay.config.ts sends the `Server-Timing` header development sends on every page rendered per request in production too: `load-0;desc="src/routes/_layout.kay";dur=3.1, load-1;desc="src/routes/blog/[slug].kay";dur=12.4, render;dur=1.8`, layouts first. Anyone loading the page reads it, page file names included; a prerendered page has none, but one with server islands carries the timings of the loads and render that filled them.
- `tracer` takes an OpenTelemetry tracer, which kay calls without depending on OpenTelemetry: the app installs `@opentelemetry/api` and an SDK exporting the spans, as `@opentelemetry/sdk-trace-node` with an OTLP exporter, registered before the server starts, then passes `tracer: trace.getTracer('my-site')`. Without one, kay starts no span and the requests cost nothing more.
- A page request is a server span named after its route, `GET /blog/[slug]`, with `http.request.method`, `http.route`, `url.path` and `http.response.status_code`, and inside it one span per load, `kay.load src/routes/blog/[slug].kay`, and one for the render, `kay.render ...`; spans the loads start nest under theirs. An action call is one too, `POST /_kay/action/...`, holding the handler's spans and the page it renders back. A span whose work threw records the error and an error status, as does a request answered with a 5xx.
- An API request is a server span from its guards to its response, `POST /api/upload`; spans its handler starts do not nest under it, since Elysia runs the handler outside any call kay makes.
- Spans nest across `await` through the context manager the SDK registers, which Bun's `AsyncLocalStorage` backs.

## Health and shutdown

`/_kay/health` answers `200 ok` while the server takes requests, for a load balancer or a container's health check. `health: { path: '/up', check: async () => await db.ping() }` in kay.config.ts moves it and adds a check: one returning `false`, throwing, or taking over 5 s answers 503, the error logged. `health: false` leaves the route out. An executable `kay build --compile` made checks a server it started, rather than starting one, when run as `./server --health`: it exits with 0 when the health route on `PORT`, 3000 by default, answers 200, else 1, for a container image with no curl: `HEALTHCHECK CMD ["./server", "--health"]`.

On SIGTERM or SIGINT, a server started with `.listen()` stops taking connections, lets open requests and streams finish, then runs the app's `onStop` hooks and exits with 0. New connections are refused from the signal on, so a load balancer stops sending any; a client on a connection kept alive gets 503 from the health route meanwhile. Requests still open after `shutdownTimeout`, 10 seconds by default, are closed and the process exits with 1. `kay dev` restarts at once instead.

## Background jobs

`schedule(cron, job)` and `background(work)` from `kay/server` are Elysia plugins, so a job runs in the server's process, from `.listen()` to the server stopping, once per process:

```ts
import { Elysia } from 'elysia'
import { background, pages, schedule } from 'kay/server'

new Elysia()
  .use(schedule('@hourly', async () => purgeExpiredCarts()))
  .use(schedule('30 2 * * MON', sendWeeklyReport, { tz: 'Europe/Paris' }))
  .use(schedule('30s', collectMetrics))
  .use(background(async (signal) => {
    while (!signal.aborted)
      await handleNextEmail(signal)
  }))
  .use(await pages())
  .listen(3000)
```

- `schedule` takes five cron fields, `minute hour day-of-month month day-of-week`, or a nickname such as `@daily`, read in the system's time zone unless `tz` names one. A literal one with another number of fields, an unknown nickname or a day its month never has, `0 0 30 2 *`, is a type error; a computed one it cannot read, or that never comes, fails the boot. Runs never overlap: the next is planned once the last settles. A run that throws is logged and the next one comes as planned.
- `schedule('30s', job)`, or `schedule(30, job)` in seconds, runs every so long in place of a cron, at the multiples of that length since the epoch, `'1h'` on the hour and `'1d'` at UTC midnight, so it takes no `tz`; a run outlasting its length skips the runs it overlaps. A length that is not positive is a type error, or fails the boot when computed. `lock`, `store`, the overlap and the shutdown work as for a cron.
- `background` starts `work` with the server, for a queue consumer or anything else that runs the whole time. On stop its signal aborts and the server waits for it to return. Work that throws is logged and not started again.
- Stopping on a signal waits for a scheduled run in progress, and for every `onStop` hook the app registers, async ones included, in turn. `shutdown(app)` from `kay/server` stops a server the same way, as a test does; Elysia's own `app.stop()` does not wait for the hooks.
- With several server processes, each runs its own schedules. `schedule(cron, job, { lock: 'weekly-report' })` runs each time once across every process sharing the job store (below), the first to reach it taking it; `store` names another store than the default one.

A queue holds jobs that must not be lost: an action enqueues one and goes on, and the server runs it in the background, after a restart or a deploy if need be:

```ts
// src/jobs.ts
import { queue } from 'kay/server'

export const welcomeMails = queue(
  'welcome-mails',
  async ({ to }: { to: string }) => sendWelcome(to),
  { attempts: 5, backoff: '30s' },
)
```

```ts
// src/server.ts
new Elysia().use(welcomeMails).use(await pages()).listen(3000)
```

An action calls `await welcomeMails.enqueue({ to: email })`, or `enqueue(payload, { delay: '1h' })` to run it later.

- `queue(name, handler, options)` is an Elysia plugin: the server using it runs the queue's jobs from start to stop, `concurrency` at a time, 1 by default, and waits on stop for the runs in progress. A process that only enqueues, a script say, need not use it.
- Jobs wait in a store shared by every process of the machine opening it: `sqliteJobs('data/jobs.sqlite')` by default, its file and directory created by the first job enqueued or schedule locked, so a server whose queues never get a job, one only sending its mails with `send()` say, writes nothing; `sqliteJobs(path)` and `memoryJobs()` from `kay/server` make a `store` of another file or one kept in the process, and `JobStore` is the shape of an app's own. Under `bun test` the default is in memory. Each job runs in one process. The payload goes through devalue, as cached values do: dates, maps and sets survive, a function or a class instance throws from `enqueue`.
- A run that throws is retried: `backoff` after the first failure, 10 seconds by default, twice as long after each next one, until `attempts` runs in all, 5 by default, each failure retried logged as a one-line warning with its attempt, its wait and the error's message. The last failure keeps the job as failed, logs it with its stack and hands its payload and error to `onFailed`; `failed()` lists the failed jobs.
- A store that fails, a SQLite file locked past its timeout say, is logged once as the outage starts and once as it ends, its workers asking it again later and later meanwhile, up to a minute apart.
- A process that dies running a job leaves it held: it runs again once `lostAfter` has passed since it started, 10 minutes by default, so a job outlasting it may run twice.
- `drain()` runs every job whose time has come, here and now, until none is left; in tests `site.runJobs()` from `kay/test` does it for every queue.

## Behind a proxy

A server behind nginx, Caddy or Cloudflare is reached from the proxy rather than from the visitor, so the address `rateLimit` and `clientAddress` count is the proxy's for every visitor until `proxy` in kay.config.ts says how to read the visitor's:

```ts
export default defineConfig({
  proxy: { hops: 1 },
})
```

- `hops` is the number of proxies in front, each appending the address it was reached from to `X-Forwarded-For`, so the visitor is the entry `hops` from its end: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx. A request with fewer entries skipped an outer proxy, and its first entry is who reached the inner one.
- `header` names a header a proxy sets to the visitor's address, read instead: `{ header: 'cf-connecting-ip' }`, or `{ header: 'x-real-ip' }` for nginx's `proxy_set_header X-Real-IP $remote_addr`. Only a proxy every request goes through can be trusted with it: a server reachable past that proxy lets a visitor write their own, and the same goes for `hops` when an outer proxy can be skipped.
- Either is read only from a request coming from this machine or a private network (loopback, private, shared and link-local ranges), so a visitor reaching the server directly is counted by their own address whatever headers they send. So a server Cloudflare reaches directly, with no proxy on its machine or network, gets nothing from either: put nginx or a tunnel such as cloudflared in front. A setting holding both, or neither, stops the server.
- Without `proxy`, the address the request came from is the client. A server getting requests from a private address that carry `X-Forwarded-For` warns once that every visitor counts as the proxy.
- In a plain Elysia app that `pages()` does not serve, `clientAddress(request, server, { hops: 1 })` takes the setting itself.

## Security headers

Every response the app sends, its own routes included, carries a Content-Security-Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none` and `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`. The policy:

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

Every inline script kay writes is the same on every page: the hydration bootstrap, the speculation rules, the swap of streamed blocks, with `offline` the service worker's registration, and, in development, live reload and the problems panel. The policy allows them by hash, with no `'unsafe-inline'` and no nonce. `security` in `kay.config.ts` adjusts it:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  security: {
    csp: {
      'img-src': ['\'self\'', 'https://images.example.com'],
      'frame-ancestors': false,
    },
    reportOnly: { 'style-src': ['\'self\''] },
    reports: true,
    headers: {
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-frame-options': false,
    },
  },
})
```

- `csp` merges directives over kay's, one given `false` left out; `'wasm-unsafe-eval'` and `worker-src 'self' blob:` join kay's directives and the app's when the islands need them, unless the app sets that directive to `false` or `'none'` (see [Wasm and workers](styles-and-assets.md#wasm-and-workers)); `script-src`, and `script-src-elem` when the app sets one, keep kay's hashes whatever they list. With `fonts`, a `style-src` or `style-src-elem` without `'unsafe-inline'` gets the hash of their inline `@font-face` rules, one with it none, since a hash would switch it off. `'script-src': false` leaves kay's inline scripts to `default-src`, which blocks them, islands and streamed blocks with them. `csp: false` sends no policy, `security: false` none of these headers.
- `reports: true` has browsers report what the policy blocks to kay's own route, `/_kay/csp` under the site's `base`, through `report-to` and its `Reporting-Endpoints` header, and `report-uri` for browsers that predate them. The route takes both formats, logs each violation once per process for its directive, what it blocked and the page, and hands it to `onError` as a `CspViolation` from `kay/server`, with `directive`, `blocked`, a URL or `inline` or `eval`, `url`, the page without query or hash, `disposition`, `enforce` or `report`, and, when the browser says, `source`, the script that tried as `file:line:column`, and `sample`, the start of a blocked inline script or style when the directive lists `'report-sample'`. A client posting more than 30 reports a minute or 64 KB at once is refused. `reports: 'https://...'` sends them to that collector instead, and kay serves no route.
- `reportOnly` merges directives over the enforced policy and sends the result as `Content-Security-Policy-Report-Only`: the browser blocks nothing it allows, but reports what that stricter policy would have blocked, with `disposition: 'report'`, to try it before moving it into `csp`. With `csp: false`, it merges over kay's directives.
- `headers` merges headers over kay's, one given `false` not sent. HSTS is not sent by default: it binds the domain to https for its `max-age`, so it is the app's call. `Cross-Origin-Opener-Policy: same-origin` cuts a page off from a window of another site it opened, or that opened it, so a sign-in or payment popup that answers through `window.opener` needs `'cross-origin-opener-policy': 'same-origin-allow-popups'`; a site using a feature `Permissions-Policy` refuses, such as geolocation for a map, sends its own, `'permissions-policy': 'geolocation=(self)'`, which replaces kay's.
- A header the app sets itself, in an Elysia `onRequest` or a handler, wins over kay's. The build's files under `/_kay/` and the image route carry kay's headers in their own responses, which Elysia does not let a later hook override: change them there through `headers`.
- `inlineScriptHashes({ prefetch, dev, base, offline })` from `kay/server` gives the hashes, for a policy written elsewhere, such as by a proxy.
- Whatever the policy, a `javascript:`, `vbscript:` or `data:text/html` URL bound to an `href`, `src`, `action`, `formaction`, `xlink:href`, `poster` or `data`, as a user-supplied link would be, goes out prefixed with `unsafe:`, on the server and in islands, so following it does nothing. One written out as text in the template is left as it is.

## Compression

With no proxy in front compressing responses, `compress: true` in kay.config.ts has kay do it: pages rendered per request, action results, and any `Response` the app's routes registered after `.use(await pages())` return go out with brotli or gzip, whichever the browser's `Accept-Encoding` prefers, and `Vary: Accept-Encoding`. A response whose body is whole within a tick, as a rendered page is, is compressed in one go at brotli 4 or gzip 6, at most four at once, except a page carrying stylesheets `inlineStyles` wrote, which goes as gzip to a browser taking it, whatever weight it gives brotli, only what lies around them compressed (see [Styles](styles-and-assets.md#styles)); a streamed page is flushed chunk by chunk, so what it sends early still arrives early. A strong ETag becomes weak. Left alone: a response encoded already, such as the build's copies, one under 256 bytes, its length known or not, one with `Cache-Control: no-transform`, and anything but text, JSON, JavaScript, XML and SVG.
