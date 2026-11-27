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

`kay build` compresses the hashed assets, the `public/` files and the prerendered pages into `.br` and `.gz` files beside them, for files of 256 bytes or more, keeping each one only when it comes out smaller. Brotli runs at quality 11, the smallest it makes, and its output is kept in `.kay-cache/` by content, so the next build compresses only the files that changed; an entry no build used for 7 days is removed. The server sends those files as they are, so it compresses on the fly only the responses that have none, such as pages rendered per request. A page streamed past `<Suspense>` is compressed as it goes, flushed with each part. A `public/` file shipped with its own `.br` or `.gz` keeps it.

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

A page loaded just before a deploy still links the previous build's scripts. So each build keeps the hashed client files the build before it made and it dropped, as hard links beside its own (copies where the filesystem refuses links), and serves them for one more deploy. A deferred island on that page still finds its chunk, and the build after that removes it. A `--static` export and a compiled binary keep them the same way, and routes, preloads and `--max-js` count only the new build's files.

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

`kay start` serves an export too. It lists the files once at startup, so a request reads no directory: `/about` answers `about.html` or `about/index.html`, and a missing path answers `404.html` with status 404. Every file answers an `ETag`, a `304` to a matching `If-None-Match` and its length to a `HEAD`. A file edited or added in place is served a moment later, and a new `kay build --static` is picked up with no restart.
