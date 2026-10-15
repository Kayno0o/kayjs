---
title: Deployment
order: 9
description: Build kay for production, ship one executable or static files, and run it behind a proxy.
---

## Build and run

`kay build` bundles the browser code into `.kay/client`, checks the project as `kay check` does, and renders the pages marked `prerender`. In production the server serves what the build wrote and bundles nothing at boot.

```sh
bun run build
NODE_ENV=production bun src/server.ts
```

Without `NODE_ENV=production` the server warns at boot, as it would bundle its browser code as it starts and its API would answer a refused request with the schema it failed. `kay start` runs the last build that way on your machine, or the executable below when the build compiled one, to try it before deploying.

## One executable

`--compile` writes a single executable holding the server, its pages and the client build. It needs neither Bun nor the project where it runs.

```sh
kay build --compile server
PORT=8080 ./server
```

It reads a `.env` and a `bunfig.toml` where it runs, but nothing else of the project: a file a page reads by path at runtime is not in it.

### Prove the executable starts

The executable is bundled apart from what `kay dev` runs, so a module it cannot load only shows when it starts. `--verify` starts it as part of the build:

```sh
kay build --compile server --verify
```

The build starts the executable on a free port, waits until its health route answers, runs `./server --health` once as a container would, and stops it. If the server exits first, or does not answer within 30 seconds, the build fails with the last 40 lines it wrote.

It waits for the health route rather than sleeping, so it takes the time the server needs to start, usually well under a second. It runs your server entry, so whatever that needs at startup, such as a database URL, has to be in the environment of the build. That is why it is off by default: add it to the CI step that builds your image. With `health: false` any answer on the port counts, and `--health` is not run.

## Static export

For a host with no server, `--static` writes the whole site to `dist`:

```sh
kay build --static --outdir dist
```

Every page is rendered, with `about.html` and `about/index.html` for `/about`, plus each [endpoint file](/essentials/routing#endpoint-files) such as `llms.txt`, the sitemap, feeds and a `404.html`. The files of `public/` are copied but its dotfiles, `.env` files and editor backups, `.htaccess` and `.nojekyll` kept for the host. The build fails naming each page or endpoint that needs a server: one behind a guard, one exporting an action, one with params and no `prerender` list, and any module under `src/api/`. With no server to take them, the errors a browser meets are logged to its console only, not reported to `onError`.

A `kay new` project keeps `.env` and `.env.*` out of git and out of its Docker image, so a value the static build reads, such as `SITE_URL`, goes in the CI's variables or the build command's environment.

## Docker

`kay new` writes this `Dockerfile`, on the Bun version it ran under: it builds the executable in one stage with `bun run compile` (`kay build --compile server`), and copies it into a small image:

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

Its `compose.prod.yaml` publishes the app on `127.0.0.1:3000` alone, for the reverse proxy serving it over HTTPS. The image has no curl, so `./server --health` checks the health route and exits with 0 or 1. If you keep SQLite files, mount a volume the `nobody` user can write.

### Database roles

The `app` preset's `compose.prod.yaml` runs the app and the migrations under two Postgres roles, so a SQL injection or a compromised app process can read and write rows but cannot drop or alter a table.

| Role | Connects | Can |
| --- | --- | --- |
| The owner, `app` (`POSTGRES_USER`, password `POSTGRES_PASSWORD`) | the `migrate` service, as `MIGRATE_DATABASE_URL` | change the schema |
| `app_rw` (password `APP_DB_PASSWORD`, another secret than the owner's) | the `app` service, as `DATABASE_URL` | select, insert, update and delete rows, and draw from sequences |

`db/roles.sh` creates `app_rw`: the database image runs it once, when it first creates the database. It also sets default privileges for the owner, so the tables, sequences and schemas a later migration creates are reachable by `app_rw` with no `GRANT` in the migration. `pg-orm.config.ts` reads `MIGRATE_DATABASE_URL` before `DATABASE_URL`, so `bun run db:migrate` and `db:generate` run as the owner wherever it is set. Development does the same with `app_rw:app_rw` in `.env`.

pg-orm's migration history table, `_pgorm_migrations`, is the exception: `app_rw` reads it and cannot write it, so a compromised app cannot make a deploy re-run or skip a migration. The script does it with an event trigger (creating one takes a superuser, which the image's user is; without one the script prints a notice and skips it), and it revokes the writes from a table that exists already. The password goes into the URL as it is, so keep it to letters and digits. An existing app adopts the roles with [the upgrading steps](/guides/upgrading).

## Health check and shutdown

`/_kay/health` answers `200 ok` while the server takes requests. Move it and add a check in `kay.config.ts`:

```ts
export default defineConfig({
  health: { path: '/up', check: async () => await db.ping() },
})
```

On SIGTERM, SIGINT or SIGHUP the server stops taking connections, lets open requests finish, runs the `onStop` hooks and exits. Requests still open after `shutdownTimeout`, 10 seconds by default, are closed.

## Logs and tracing

With `NODE_ENV=production`, the server's first line says where it listens, the kay version and how many pages the build prerendered, and every request is logged as one line, `GET /blog/hello 200 12ms AZnLe0vUe9qD0uXq9vLwZw`, ending with the id its response carries as `X-Request-Id`. An error logged while answering it is headed by the same id, and `requestId(request)` from `kay/server` gives it to `onError`. Behind a proxy set in `proxy`, an `X-Request-Id` the proxy passed on is kept. `log: 'json'` writes these lines and kay's own messages, its errors and warnings, as one JSON object each, for a log collector. Libraries such as kayjs-mail log through the same setting with `logFrom` from `kay`: `const log = logFrom('kayjs-mail')`, then `log.warn(message)` or `log.error(message, error)`, what was thrown coming second. Their lines are headed by their name, `kayjs-mail: ...`, and carry it as `from` in JSON. Outside a server, in the browser or a script, they go to the console as `[kayjs-mail] message`.

`tracer` takes an OpenTelemetry tracer from the `@opentelemetry/api` and SDK the app installs, kay itself depending on neither. Each page request becomes a span named after its route, with one span per load and one for the render inside it, and each action and API request becomes a span too. `serverTiming: true` sends the same load and render times as a `Server-Timing` header, as development always does, for every page rendered per request and the server islands of a prerendered one.

```ts
import { trace } from '@opentelemetry/api'

export default defineConfig({
  log: 'json',
  tracer: trace.getTracer('my-site'),
})
```

## Behind a proxy

Behind nginx, Caddy or Cloudflare, every request comes from the proxy. Tell kay how many proxies sit in front so that rate limits and `clientAddress` see the visitor:

```ts
export default defineConfig({
  proxy: { hops: 1 },
})
```

Use `hops: 2` for Cloudflare then nginx, or `proxy: { header: 'cf-connecting-ip' }` to read a header the proxy sets. kay reads either only from this machine, a private network or the address ranges `trusted` lists, such as a CDN's published ranges when it reaches the server directly: `proxy: { header: 'cf-connecting-ip', trusted: ['173.245.48.0/20'] }`.

The proxy passes `X-Forwarded-Proto`, or `site` in kay.config.ts is the https address, so kay's cookies stay `Secure`; production warns once when it cannot tell.

<ReadMore href="/llms/production">Log entries for your own sink, span attributes, security headers and compression are in the full production reference.</ReadMore>
