---
title: Deployment
order: 9
description: Build kay for production, ship one executable or static files, and run it behind a proxy.
---

Kay ships as a server you run, one executable, or static files. This page builds the project, packages it and puts it behind a proxy.

```sh
kay build --compile server
```

## Build and run

`kay build` bundles the browser code into `.kay/client`, checks the project as `kay check` does, and renders the pages marked `prerender`. In production the server serves what the build wrote and bundles nothing at boot.

```sh
bun run build
NODE_ENV=production bun src/server.ts
```

Without `NODE_ENV=production` the server warns at boot. It would bundle its browser code as it starts, and its API would answer a refused request with the schema it failed. A name such as `staging` warns too: only `production` turns on the request log and compression, so set `NODE_ENV=production` everywhere the app is deployed and tell environments apart with another variable.

To try a build before deploying, run `kay start`. It runs the last build on your machine, or the executable when the build compiled one.

## One executable

`--compile` writes a single executable holding the server, its pages and the client build. It needs neither Bun nor the project where it runs. It embeds the source maps too, compressed, so a stack in its logs and an island's report to `onError` point at your `.kay` lines, as they do under `kay start`. The server never sends a source map to a browser. They add to its size with the app's modules, about 1.5 MB for a small one.

```sh
kay build --compile server
PORT=8080 ./server
```

The server listens on every address unless `HOST` names one. `HOST=127.0.0.1 PORT=8080 ./server` answers on the loopback address alone. `./server --health` asks the address `HOST` names.

`kay dev` ignores `HOST` and listens on localhost, or on the network with `--host`.

The executable reads a `.env` and a `bunfig.toml` where it runs, but nothing else of the project. A file a page reads by path at runtime is not in it.

### Prove the executable starts

The executable is bundled apart from what `kay dev` runs, so a module it cannot load only shows when it starts. `--verify` starts it as part of the build:

```sh
kay build --compile server --verify
```

The build starts the executable on a free port and waits until its health route answers. It runs `./server --health` once, as a container would, then stops the executable.

The build fails with the last 40 lines the server wrote when the server exits early or does not answer within 30 seconds. `kay start` then does not run that executable.

The check runs your server entry, so whatever it needs at startup, such as a database URL, has to be in the build's environment. That is why it is off by default. Add it to the CI step that builds your image.

With `health: false`, any answer on the port counts and `--health` is not run.

<ReadMore href="/llms/production#check-the-executable-starts">The exact failure conditions, the process group and the Linux socket check are in the full production reference.</ReadMore>

## Static export

For a host with no server, `kay build --static --outdir dist` writes the whole site as files. See [Static export and base path](/guides/static-export) for what is written and which pages cannot be exported.

## Docker

`kay new` writes this `Dockerfile`, on the Bun version it ran under. One stage builds the executable with `bun run compile`, and a small image runs it.

```dockerfile
FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock* .npmrc ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server ./server
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER nobody
HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]
CMD ["./server"]
```

Its `compose.prod.yaml` publishes the app on `127.0.0.1:3000` alone, for the reverse proxy serving it over HTTPS, and its `kay.config.ts` sets `proxy: true` so that rate limits count each visitor. The image has no curl, so `./server --health` checks the health route and exits with 0 or 1. It waits as long as `health.timeout` says, but the `HEALTHCHECK --timeout=6s` above cuts it off, so raise its `--timeout` yourself when you raise `health.timeout` past 5 s.

If you keep SQLite files, mount a volume the `nobody` user can write. The `app` preset does. Its `compose.prod.yaml` mounts a `data` volume at `/app/data`, and a `migrate` service applies the migrations and hands the file to `nobody` before the app starts. The app's sessions live in `data/sessions.sqlite` on the same volume, so they survive a deploy, and the Postgres preset mounts the volume for them too.

### Database roles

An app made with `--with postgres` runs the app and the migrations under two Postgres roles. A SQL injection or a compromised app process can then read and write rows, but cannot drop or alter a table.

| Role | Connects | Can |
| --- | --- | --- |
| The owner, `app` (`POSTGRES_USER`, password `POSTGRES_PASSWORD`) | the `migrate` service, as `MIGRATE_DATABASE_URL` | change the schema |
| `app_rw` (password `APP_DB_PASSWORD`, another secret than the owner's) | the `app` service, as `DATABASE_URL` | select, insert, update and delete rows, and draw from sequences |

`db/roles.sh` creates `app_rw`. The database image runs it once, when it first creates the database. It also sets default privileges, so the tables a later migration creates are reachable by `app_rw` with no `GRANT`.

`pg-orm.config.ts` reads `MIGRATE_DATABASE_URL` before `DATABASE_URL`, so `bun run db:migrate` and `db:generate` run as the owner wherever it is set. Development does the same with `app_rw:app_rw` in `.env`.

pg-orm's migration history table, `_pgorm_migrations`, is the exception. `app_rw` reads it and cannot write it, so a compromised app cannot make a deploy re-run or skip a migration.

The password goes into the URL as it is, so keep it to letters and digits. An existing app adopts the roles with [the upgrading steps](/guides/upgrading).

## Secrets

A provider key such as kayjs-ai's `ANTHROPIC_API_KEY`, or kayjs-mail's `SMTP_PASS`, is a secret. Set it as an environment variable of the container, or in a `.env` next to the executable. Never put it in the image or the repository.

`kay env` lists the variables each library reads, and which of them production requires. Compare its output with your compose file before you deploy.

## Tabs open during a deploy

A deploy replaces the JavaScript files of the site. A tab opened before it still runs the old ones, and the old files are gone: the next island it loads is a 404.

Kay handles this without setup. Every answer of a production server names its build in an `x-kay-build` header. When a tab fails to load a file, it asks the server which build it runs now, with a request for its own entry file, which renders no page. If that is another one, the tab reloads the current page, and the browser keeps the scroll position.

A tab with something typed in it is not reloaded under the visitor, and neither is a page that answered a form sent without JavaScript, an error page included, as the browser would ask to send it again. The next link they follow loads the new page in full instead of swapping it in. The same goes for a tab whose action call or server island was answered by the new build, once the server confirms it, as a cached answer may name an old one. An action the new build dropped reloads the tab at once.

When a file fails to load but the build has not changed, as when the visitor is offline, the page still stays correct. After an action, the page loads again in full if the code that swaps pages in is missing, and an island that waits to be visible or idle hydrates at once if the code that watches for that is missing.

A tab reloads once a minute at most, so a cache that keeps serving the old page cannot loop it. Static exports work the same way, with the tab reading the build off the host's page.

The server's answer is believed for five seconds, so a page of cached answers costs one request. If your scripts are served from a CDN on another origin, or from a path outside `/_kay/`, the tab cannot ask for its entry file and asks for the page itself instead.

Kay also keeps the script, stylesheet and asset files of the last three builds in `.kay/client`, so an old tab finds the files it loads until it reloads, for a few deploys. This needs the `.kay` folder to survive from one build to the next, as it does on your machine and not on a clean CI checkout: keep `.kay/client` and `.kay/client-kept` between builds there. Static exports and executables carry the kept files too.

A build with other options in the same `.kay`, such as `--static`, takes a slot of its own.

Keep your HTML pages revalidating in any cache in front of the server, as kay's own pages do.

## Health check and shutdown

`/_kay/health` answers `200 ok` while the server takes requests. Move it, or add a check, in `kay.config.ts`.

```ts
export default defineConfig({
  health: { path: '/up', check: async () => await db.ping() },
})
```

The check runs at most once every three seconds, however often the route is polled, and the probes in between get its last answer.

On SIGTERM, SIGINT or SIGHUP the server stops taking connections and lets open requests finish. It then runs the `onStop` hooks and exits. Requests still open after `shutdownTimeout`, 10 seconds by default, are closed.

## Logs and tracing

With `NODE_ENV=production`, the server's first line says where it listens, the kay version and how many pages the build prerendered. Every request is logged as one line, ending with the id its response carries as `X-Request-Id`.

```
GET /blog/hello 200 12ms AZnLe0vUe9qD0uXq9vLwZw
```

An error logged while answering the request starts with the same id. `requestId(request)` from `kay/server` gives it to `onError`. Behind a proxy set in `proxy`, an `X-Request-Id` the proxy passed on is kept, and `requestIdHeader: 'x-correlation-id'` in kay.config.ts names another header for both.

Set `log: 'json'` to write these lines, and kay's own errors and warnings, as one JSON object each. Use it for a log collector.

### Logging from a library

Libraries such as kayjs-mail log through the same setting. Use `logFrom` from `kay` in your own library or script.

```ts
import { logFrom } from 'kay'

const log = logFrom('kayjs-mail')

log.warn(message)
log.error(message, error)
```

Their lines start with their name, `kayjs-mail: ...`, and carry it as `from` in JSON. In the browser or a script they go to the console as `[kayjs-mail] message`.

### Tracing

Set `tracer` to an OpenTelemetry tracer from the `@opentelemetry/api` and SDK that your app installs. Kay depends on neither.

```ts
import { trace } from '@opentelemetry/api'

export default defineConfig({
  log: 'json',
  tracer: trace.getTracer('my-site'),
})
```

Each page request becomes a span named after its route, with one span per load and one for the render inside it. Each action and API request becomes a span too.

`serverTiming: true` sends a `Server-Timing` header with the time of the guards, the module imports, the loads and the render. Development always does. It covers every page rendered per request, and the server islands of a prerendered one.

<ReadMore href="/llms/production#request-logs">The log fields, span attributes and the sink for your own entries are in the full production reference.</ReadMore>

## Behind a proxy

Behind nginx, Caddy or Cloudflare, every request comes from the proxy. Set `proxy` in kay.config.ts so that rate limits and `clientAddress` see the visitor. See [Trust a proxy](/guides/security#trust-a-proxy).

Have the proxy pass `X-Forwarded-Proto`, or set `site` in kay.config.ts to the https address. Kay's cookies then stay `Secure`. Production warns once when it cannot tell.

<ReadMore href="/llms/production">Log entries for your own sink, span attributes, security headers and compression are in the full production reference.</ReadMore>
