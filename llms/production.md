# Running in production

## Common tasks

### Log requests as JSON for a log collector

`log: 'json'` in kay.config.ts writes one JSON object per line, requests included, on stdout for info and on stderr for warnings and errors:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  log: 'json',
})
```

### Log from a library or a script

`logFrom` from `kay` follows the app's `log` setting, its lines headed by the request being answered when there is one:

```ts
import { logFrom } from 'kay'

const log = logFrom('kayjs-mail')

log.info('sent')
log.warn('slow relay')
log.error('failed', new Error('refused'))
```

### Trace requests with OpenTelemetry

`tracer` takes an OpenTelemetry tracer, the SDK registered before the server starts:

```ts
import { trace } from '@opentelemetry/api'
import { defineConfig } from 'kay/server'

export default defineConfig({
  tracer: trace.getTracer('my-site'),
})
```

### Check the database in the health route

`health` moves the route and adds a check, which answers 503 when it returns `false`, throws or takes over 5 s, and runs at most once every 3 s, probes between sharing its answer, which `timeout` changes (`health: { timeout: '10s' }`, seconds or a duration such as `'250ms'`, which `./server --health` and the build's check of the executable wait for too, though the Dockerfile `kay new` writes cuts a probe off at 6 s: raise its `--timeout` with it):

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  health: { path: '/up', check: async () => await db.ping() },
})
```

### Health-check a container with no curl

An executable made by `kay build --compile` checks the health route itself when run as `./server --health`, in a Dockerfile:

```dockerfile
HEALTHCHECK CMD ["./server", "--health"]
```

`kay build --compile server --verify` runs it once at build time, see [Check the executable starts](#check-the-executable-starts).

### Check the executable starts

`kay build --compile server --verify` starts the executable it wrote on a free port, as `NODE_ENV=production` with the project as its working directory, so a `.env` there is read, waits until the health route answers 200, then runs it again as `--health` and stops it. A crash at startup, such as a module of the app the executable could not load, fails the build with the server's own output instead of showing at the deploy's health check:

```sh
kay build --compile server --verify
```

- It waits on the health route, polled every 50 ms, not a fixed sleep: a server that exits or is killed first, or within 250 ms of its first answer, fails at once, one that never answers fails after 30 s, each printing the last 40 lines of what it wrote (`executable-failed`).
- It runs the app's server entry, so a database or secret the entry needs must be in the build's environment: add it to the CI step that builds the image. A Dockerfile build stage has none, so `--verify-load` there only loads every module the executable carries, as `./server --load`, with the variables missing (a read fails the code using it) and the entry never run, and fails with the output of one that cannot load.
- The `--health` run fails the build when it has not exited after 10 s.
- A failed verify writes no record of the executable, so `kay start` runs the entry instead.
- The server runs in a process group of its own and everything it started is stopped with it. On Linux an answer only counts when the listening socket belongs to the server or a process it started, so another process holding the port cannot pass the verify; where /proc cannot be read, the check is left out. An interrupted build stops the server too.
- It costs the server's startup plus 250 ms, usually well under a second, and `--format json` carries it as `compiled.verifiedMs`.
- `health: false` leaves no route to ask, so any answer on the port counts and `--health` is not run.

### Set a library's secrets

- A provider key, kayjs-ai's `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or the password in kayjs-mail's `MAIL_URL`, is a production secret: an environment variable of the container or a `.env` beside the executable, never in the image or the repository.
- `kay env` lists what each library in `extensions` reads and which of it production requires, such as `AI_MODEL`; `env: { compose, example }` in kay.config.ts has `kay check` compare it with the compose file and `.env.example` ([Server](server.md)).

### Run a job on a schedule

`schedule` from `kay/server` is an Elysia plugin taking a cron or a length, and runs in the server's process:

```ts
import { Elysia } from 'elysia'
import { pages, schedule } from 'kay/server'

new Elysia()
  .use(schedule('30 2 * * MON', sendWeeklyReport, { tz: 'Europe/Paris' }))
  .use(schedule('30s', collectMetrics))
  .use(await pages())
  .listen(3000)
```

### Run a job that must not be lost

A `queue` runs its jobs in the background, after a restart or a deploy if need be, and an action enqueues one and goes on:

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

Then `await welcomeMails.enqueue({ to: email })` in an action, or `enqueue(payload, { delay: '1h' })` to run it later., and more in [Queues](queues.md).

## Reference

### Request logs

- A server started with a NODE_ENV that is none of `development`, `production` and `test`, such as `staging`, warns once as it boots: only `production` turns on the request log, compression, the prebuilt browser bundle and the https fallback to the site's origin, so any other name runs without them; set `NODE_ENV=production` on every deployed environment and tell them apart with another variable.
- A server started with no NODE_ENV warns as it boots, as it then bundles its browser code at boot and Elysia answers a refused API request with the schema it failed: set NODE_ENV=production where the app is deployed.
- With NODE_ENV=production, a server's first line, once `.listen()` started it, says where it listens and what runs: `kay: listening on http://localhost:3000, kay 1.30.0 in production, 12 pages prerendered`.
- Then every request kay or the app's routes registered after `.use(await pages())` answer is logged to stdout as one line: `GET /blog/hello 200 12ms AZnLe0vUe9qD0uXq9vLwZw`, the method, the path without its query string, which may carry tokens, the status, the milliseconds until the response was made, a streamed one's headers, and the request's id.
- kay's own `/_kay/` routes, assets included, and the health route, wherever `health.path` puts it, are left out.
- `true` in kay.config.ts's `log` logs them outside production too, `false` never.
- kay's own messages, an error it caught, a warning about the app, a shutdown notice, go out in any mode, as `kay: ` and the message, an error's source-mapped stack on the lines below.
- `log` sets the format of both: `'json'` writes one JSON object per line for a log collector, on stdout for info and on stderr for warnings and errors, and a function receives each entry instead, typed `LogEntry` from `kay/server`:
  - a request, `{ type: 'request', time, level: 'info', method, path, status, duration, id }`;
  - a message, `{ type: 'message', time, level: 'info' | 'warn' | 'error', from, message, request?: { method, path, id }, error?: { name, message, stack } }`, `from` being `'kay'` or a library's name, `request` when it was logged while answering one.
- A library logs through the same setting with `logFrom` from `kay`: `const log = logFrom('kayjs-mail')`, then `log.info(message)`, `log.warn(message)` or `log.error(message, error)`.
- Its lines read `kayjs-mail: ` and the message, headed by the request being answered as kay's are, in a page, an action, an endpoint or a guard, though not in an API module's handler or a socket, which Elysia runs outside any call kay makes, and carry `from: 'kayjs-mail'` as JSON or in the entry a log function receives.
- Outside a server, in the browser or a script, they go to the console as `[kayjs-mail] message`.
- Every response carries its request's id as `X-Request-Id`, time-ordered, made by kay unless `proxy` is set and the proxy passed one on in that header; `requestIdHeader: 'x-correlation-id'` in kay.config.ts names another header for both.
- An error logged while answering a request is headed by the request, `kay: GET /blog/hello, request AZnLe0vUe9qD0uXq9vLwZw`, then its stack, so a line from a user or a log search finds both.
- `requestId(request)` from `kay/server` gives it, in `onError` or a route, and a server span carries it as `kay.request.id`.

### Tracing and timing

- `serverTiming: true` in kay.config.ts sends the `Server-Timing` header development sends on every page rendered per request in production too: `guards;dur=0.4, import;dur=0.2, loads;dur=12.6, load-0;desc="src/routes/_layout.kay";dur=3.1, load-1;desc="src/routes/blog/[slug].kay";dur=12.4, render;dur=1.8`: the guards (on a route that has any), the import of the page's modules and its loads as a whole, which run at once, then each load, layouts first, then the render.
- Anyone loading the page reads it, page file names included.
- A prerendered page has none, but one with server islands carries the timings of the loads and render that filled them.
- `tracer` takes an OpenTelemetry tracer, which kay calls without depending on OpenTelemetry: the app installs `@opentelemetry/api` and an SDK exporting the spans, as `@opentelemetry/sdk-trace-node` with an OTLP exporter, registered before the server starts, then passes `tracer: trace.getTracer('my-site')`.
- Without one, kay starts no span and the requests cost nothing more.
- A page request is a server span named after its route, `GET /blog/[slug]`, with `http.request.method`, `http.route`, `url.path` and `http.response.status_code`, and inside it one span per load, `kay.load src/routes/blog/[slug].kay`, and one for the render, `kay.render ...`.
- Spans the loads start nest under theirs.
- An action call is one too, `POST /_kay/action/...`, holding the handler's spans and the page it renders back.
- A span whose work threw records the error and an error status, as does a request answered with a 5xx.
- An API request is a server span from its guards to its response, `POST /api/upload`; spans its handler starts do not nest under it, since Elysia runs the handler outside any call kay makes.
- Spans nest across `await` through the context manager the SDK registers, which Bun's `AsyncLocalStorage` backs.

### Health and shutdown

- `/_kay/health` answers `200 ok` while the server takes requests, for a load balancer or a container's health check.
- `health: { path: '/up', check: async () => await db.ping() }` in kay.config.ts moves it and adds a check: one returning `false`, throwing, or taking over 5 s answers 503, the error logged.
- `health: false` leaves the route out.
- An executable `kay build --compile` made checks a server it started, rather than starting one, when run as `./server --health`: it exits with 0 when the health route on `PORT`, 3000 by default, at `HOST` when it names an address and on loopback otherwise, answers 200, else 1, for a container image with no curl: `HEALTHCHECK CMD ["./server", "--health"]`.
- On SIGTERM, SIGINT or SIGHUP, a server started with `.listen()` stops taking connections, lets open requests and streams finish, then runs the app's `onStop` hooks and exits with 0.
- New connections are refused from the signal on, so a load balancer stops sending any; a client on a connection kept alive gets 503 from the health route meanwhile.
- Requests still open after `shutdownTimeout`, 10 seconds by default, are closed and the process exits with 1.
- `kay dev` restarts at once instead.

### A deploy under open tabs

- Every answer of a production server carries `x-kay-build`, a hash of the names of all the client chunks (the entry, the runtime and every island), which changes with any island's code. A page knows its own build from the `kay-build` meta it was rendered with; `kay dev` sends none.
- A chunk the new build dropped is a 404, so a tab opened before the deploy meets it on the next island it hydrates (`hydrate="visible"`, `"idle"`, a server island) or the next lazy chunk. A tab that failed to load a chunk asks the server once, with a HEAD request for the entry chunk it loaded (a file, so no page renders), and when that names another build, reloads the current URL, the browser putting the scroll back. No config.
- An action call or server island answered by another build marks the tab once the server confirms that build (an answer replayed by the HTTP cache may carry an old one): its next link, form post or back/forward loads in full instead of swapping pages in. A 404 from another build, as for an action the new build no longer has, reloads at once.
- A tab with something typed (a changed field, a file chosen, a `guardLeave` guard holding unsaved changes) is never reloaded under the visitor: it waits for the next navigation, which loads in full. So is a document that answered a form posted without JavaScript (it carries `<meta name="kay-posted">`, an error page that rendered for the post included), which a reload would post again.
- A lazy chunk that fails to load while the build is unchanged (offline, a server restarting) does not leave the page stale: an action's refresh reloads the page when the code swapping pages in is missing, under the rules above (nothing typed, no form post, once a minute), else the next link loads in full; an island hydrating on `visible` or `idle` hydrates at once, and the error is logged.
- A tab reloads once a minute at most, and not at all without `sessionStorage`, so a cache in front of the server keeping an old page cannot loop it.
- The build the server named is believed for 5 seconds, so many cached island answers cost one HEAD; a missing chunk asks afresh unless that answer already named another build, as a deploy is not undone by a later one. An entry served from a CDN (another origin, or not under `/_kay/`) cannot be asked with a HEAD, so the tab fetches its own page instead, as for a static export.
- A static export has no header: the tab reads the `kay-build` meta of its own page from the host instead, and its entry carries none of the code reading headers. The code doing all this is part of the entry chunk, as a chunk loaded later would be dropped with the others by a deploy.
- `kay build` keeps the script, stylesheet and asset files of the last 3 builds beside the new one in `.kay/client`, so an old tab finds its chunks until it reloads, for 3 deploys after; a static export and `--compile` carry them too, and a build that changed nothing takes no slot. A fresh `.kay` (a clean CI checkout, an image built from scratch) has none to keep: keep `.kay/client` and `.kay/client-kept` between builds, or rely on the reload above, which is what a tab past the last 3 builds does. Builds with other options (`--static`, another `base`) in the same `.kay` each take a slot, and `.kay/client-kept` sits beside the output.
- A cache or CDN serving the old HTML after a deploy is the one case kay cannot see past: keep HTML pages revalidating, as kay's own pages do.

### Background jobs

- `schedule(cron, job)` and `background(work)` from `kay/server` are Elysia plugins, so a job runs in the server's process, from `.listen()` to the server stopping, once across the processes sharing the job store in production, else once per process:

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

- `schedule` takes five cron fields, `minute hour day-of-month month day-of-week`, or a nickname such as `@daily`, read in the system's time zone unless `tz` names one.
- A literal one with another number of fields, an unknown nickname or a day its month never has, `0 0 30 2 *`, is a type error; a computed one it cannot read, or that never comes, fails the boot.
- Runs never overlap: the next is planned once the last settles.
- A run that throws is logged and the next one comes as planned.
- `schedule('30s', job)` runs every so long in place of a cron, at the multiples of that length since the epoch, `'1h'` on the hour and `'1d'` at UTC midnight, so it takes no `tz`; a run outlasting its length skips the runs it overlaps.
- A length that is not positive is a type error, or fails the boot when computed.
- `lock`, `store`, the overlap and the shutdown work as for a cron.
- `background` starts `work` with the server, for a queue consumer or anything else that runs the whole time.
- On stop its signal aborts and the server waits for it to return.
- Work that throws is logged and not started again.
- Stopping on a signal waits for a scheduled run in progress, and for every `onStop` hook the app registers, async ones included, in turn.
- `shutdown(app)` from `kay/server` stops a server the same way, as a test does; Elysia's own `app.stop()` does not wait for the hooks.
- A production server (`NODE_ENV=production`) locks every schedule by default, named `auto:<schedule>:<hash of the job's source>` (a twin with the same schedule and source takes `#2` by start order, which every process of one app shares), so each run happens once across processes sharing the store; a dev or test server runs each schedule in every process. `lock: false` opts out. If the store cannot give that default lock, one warning is logged and the run goes on unlocked, once per process; a `lock` the app named skips the run instead.
- A run still going after `timeout` (`'10m'` by default, `false` for none) is logged as failed and left, so it no longer blocks the next run; a stop aborts the signal and waits 5 s at most for a run ignoring it, without reporting it. The job takes an `AbortSignal` that aborts at the timeout and as the server stops. Every job is called with the signal, so one with an optional first parameter gets it. The lock name hashes the job's source, so during a rolling deploy old and new builds with changed jobs both run.
- `schedule(cron, [jobA, jobB])` gives each job of the list that schedule, and `schedule({ '* * * * *': [jobA, jobB], '@hourly': jobC, '30s': jobD }, options)` several schedules at once, each key checked as a literal schedule is and `tz` read by the crons alone, all in one plugin: with several jobs, `lock` names each `<lock>:<its schedule>:<its place in that schedule's list>`, `report:@hourly:0`.
- `schedule(cron, job, { boot: true })` runs the jobs once as the server starts too, the first scheduled run waiting for it and a stop too, so a job needing a first run does not start itself by hand; processes starting within the same minute (the schedule's length if shorter) run it once, two either side of the boundary possibly twice (it takes the lock `<lock>:boot` for a slot of a minute at most, a skipped one is logged), while a restart minutes later runs it again, each restart of `kay dev`, `kay render` and `--verify` included.
- `schedule(cron, job, { lock: 'weekly-report' })` runs each time once across every process sharing the job store ([Queues](queues.md)), the first to reach it taking it; `store` names another store than the default one.

The queue, its stores and its retries are in [Queues](queues.md).
