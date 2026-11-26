---
title: Static & --compile
description: Deploy Kay v2 as a Bun server, a CDN-ready static export (--static), or a zero-dependency single executable (--compile).
section: production
order: 1
---

Kay v2 supports three first-class deployment modes from the exact same codebase.

## 1. Bun Server (`kay build` + `kay start`)

```bash
kay build
PORT=3000 kay start
```

Serves dynamic SSR routes, streaming `<Suspense>`, server actions, API routes, prerendered pages, and immutable `/_kay/*` client assets directly from `Bun.serve()`.

## 2. Single Standalone Executable (`kay build --compile`)

Compile your entire server, routes, `kay.config.ts` plugins, client bundles, and `public/` assets (`with { type: "file" }`) into **one self-contained binary**:

```bash
kay build --compile ./server
./server
```

- Cold start: **~35 ms**
- `NODE_ENV` defaults to `production` inside compiled binaries
- SQLite (`bun:sqlite`) works out of the box alongside the binary

## Stopping the server

`kay start` and a compiled binary stop gracefully on `SIGTERM`, `SIGINT` or `SIGHUP`, so a rolling deploy drops no request. The server stops taking connections, `@kayjs/live` ends its open streams, and each plugin's `api.onShutdown()` hook runs. The process exits 0 once the requests already in flight have answered. A request still open after 10 seconds is cut, and the process exits 1.

## How a build replaces `dist/`

`kay build` writes into a folder beside `dist/` and renames it to `dist/` only once every step has passed: bundling, plugin hooks, prerendering and `--compile`. A build that fails leaves the previous `dist/` byte for byte, and a running `kay start` keeps serving it.

When a build lands, a running `kay start` loads it in the same process, with no restart and no dropped connection. Requests that arrive while it loads wait for the new build, so no page links a script the new build removed. Each plugin's `server()` runs again for the new build, and the old build's `api.onShutdown()` hooks run once it stops answering. If the new build fails to load, the server logs why and keeps answering from the one it had. A new port, host or `maxRequestBodySize` still needs a restart. A file the server can no longer read answers `404` with `cache-control: no-store`, so no CDN keeps the failure.

kay marks each folder it builds with a `.kay-output` file. It refuses to replace an `outDir` holding files it did not build, and names the folder, so a mistyped `outDir` never deletes your files. An empty folder, or a build from an older kay, is replaced as usual.

## 3. Static HTML Export (`kay build --static`)

```bash
kay build --static
```

Outputs a ready-to-host directory in `dist/` containing:
- Every route and `paths()` page (expanded across locales if `@kayjs/i18n` is enabled). A dynamic page with no `paths()` fails the build, because a static host cannot render it. Dynamic API routes are left out.
- `404.html` (if `src/routes/_404.tsx` exists)
- Hashed client CSS/JS/font assets under `dist/_kay/`
- All `public/` files, RSS feeds, `sitemap.xml`, and generated OG `shareCard()` PNGs
