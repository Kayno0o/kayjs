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

## 3. Static HTML Export (`kay build --static`)

```bash
kay build --static
```

Outputs a ready-to-host directory in `dist/` containing:
- Every route and `paths()` page (expanded across locales if `@kayjs/i18n` is enabled)
- `404.html` (if `src/routes/_404.tsx` exists)
- Hashed client CSS/JS/font assets under `dist/_kay/`
- All `public/` files, RSS feeds, `sitemap.xml`, and generated OG `shareCard()` PNGs
