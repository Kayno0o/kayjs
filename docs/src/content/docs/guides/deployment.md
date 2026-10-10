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

With `NODE_ENV=production`, every request is logged as one line, `GET /blog/hello 200 12ms`.

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

`kay new` writes this `Dockerfile`: it builds the executable in one stage with `bun run compile` (`kay build --compile server`), and copies it into a small image:

```dockerfile
FROM oven/bun:1 AS build
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

The image has no curl, so `./server --health` checks the health route and exits with 0 or 1. If you keep SQLite files, mount a volume the `nobody` user can write.

## Health check and shutdown

`/_kay/health` answers `200 ok` while the server takes requests. Move it and add a check in `kay.config.ts`:

```ts
export default defineConfig({
  health: { path: '/up', check: async () => await db.ping() },
})
```

On SIGTERM or SIGINT the server stops taking connections, lets open requests finish, runs the `onStop` hooks and exits. Requests still open after `shutdownTimeout`, 10 seconds by default, are closed.

## Behind a proxy

Behind nginx, Caddy or Cloudflare, every request comes from the proxy. Tell kay how many proxies sit in front so that rate limits and `clientAddress` see the visitor:

```ts
export default defineConfig({
  proxy: { hops: 1 },
})
```

Use `hops: 2` for Cloudflare then nginx, or `proxy: { header: 'cf-connecting-ip' }` to read a header the proxy sets.

<ReadMore href="/llms/production">Request logs, tracing, background jobs, security headers and compression are in the full production reference.</ReadMore>
