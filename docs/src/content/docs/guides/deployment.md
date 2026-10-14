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

`kay start` runs the last build that way on your machine, or the executable below when the build compiled one, to try it before deploying.

## One executable

`--compile` writes a single executable holding the server, its pages and the client build. It needs neither Bun nor the project where it runs.

```sh
kay build --compile server
PORT=8080 ./server
```

It reads a `.env` and a `bunfig.toml` where it runs, but nothing else of the project: a file a page reads by path at runtime is not in it.

## Static export

For a host with no server, `--static` writes the whole site to `dist`:

```sh
kay build --static --outdir dist
```

Every page is rendered, with `about.html` and `about/index.html` for `/about`, plus each [endpoint file](/essentials/routing#endpoint-files) such as `llms.txt`, the sitemap, feeds and a `404.html`. The build fails naming each page or endpoint that needs a server: one behind a guard, one exporting an action, one with params and no `prerender` list, and any module under `src/api/`. With no server to take them, the errors a browser meets are logged to its console only, not reported to `onError`.

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
