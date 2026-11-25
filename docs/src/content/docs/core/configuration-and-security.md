---
title: Configuration & Security
description: kay.config.ts options, default strict CSP with automatic SHA-256 hashes, HSTS, reverse-proxy trust, body limits, error hooks, and typed environment variables.
section: core
order: 6
---

Configure your app in `kay.config.ts` with `defineConfig()` from `kay/server`:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lang: 'en',
  port: 3000,
  trustProxy: true,
  maxRequestBodySize: 2 * 1024 * 1024,
  streamTimeout: 15_000,
  onError({ error, request, source }) {
    console.error(`[${source}] ${request.method} ${request.url}`, error)
  },
  plugins: [],
})
```

## `kay.config.ts` options

| Option | Default | Purpose |
| :--- | :--- | :--- |
| `lang` | `'en'` | Default `<html lang="...">` attribute. |
| `port` | `3000` | Default port for `kay start` (overridden by `PORT` or `--port`). |
| `routesDir` | `'src/routes'` | Directory scanned for file-based routes. |
| `outDir` | `'dist'` | Build output directory. |
| `publicDir` | `'public'` | Static files served at `/` with ETag and `304`. |
| `assetPrefix` | `'/_kay'` | URL prefix for immutable hashed build assets. |
| `security` | Enabled | Security headers options, or `false` to disable all of them. |
| `trustedOrigins` | `undefined` | Extra origins allowed by CSRF checks (for example, `['https://app.example.com']`). |
| `trustProxy` | `false` | Reverse proxies in front of Kay: `true` for 1 hop, a number for `N` hops (e.g. `2` for CDN + nginx). |
| `maxRequestBodySize` | `1048576` (1 MiB) | Maximum request body size before returning `413 Payload Too Large`. |
| `streamTimeout` | `30000` | Milliseconds a `<Suspense>` boundary may wait before failing. |
| `compress` | `true` in prod, `false` in dev | On-the-fly and sidecar Brotli/Gzip response compression. |
| `onError` | `undefined` | Hook called on unhandled errors in routes, actions, or plugins (`source: 'route' \| 'action' \| 'plugin'`). |
| `plugins` | `[]` | Array of `KayPlugin` instances. |

## Security headers & strict CSP

Kay attaches safe security headers to every response out of the box:

- `Content-Security-Policy`: Defaults to `DEFAULT_CSP` (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`).
- **Automatic SHA-256 hashes**: Pages that render islands or `<Suspense>` automatically append only the exact SHA-256 hashes Kay needs — no `'unsafe-inline'` required.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `Strict-Transport-Security`: Sent on HTTPS requests (`max-age=31536000; includeSubDomains` by default).

Override individual headers or turn one off with `false`:

```ts
export default defineConfig({
  security: {
    csp: "default-src 'self'; img-src 'self' https://cdn.example.com",
    frameOptions: 'DENY',
    hsts: false,
  },
})
```

## Reverse proxies (`trustProxy`)

Forwarded headers (`X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`) are ignored unless `trustProxy` is set. Kay reads the entry written by the trusted hops from the right of each header so clients cannot spoof their IP or protocol.

This affects `ctx.ip`, HTTPS cookie `Secure` flags, HSTS headers, and CSRF `Origin` checks.

## Cookies

Read and write cookies through `ctx.cookies` inside `load()`, middleware, API routes, and actions:

```ts
const theme = ctx.cookies.get('theme')
ctx.cookies.set('theme', 'dark', { httpOnly: true, sameSite: 'lax', path: '/' })
ctx.cookies.delete('theme')
```

## Typed environment variables (`defineEnv` & `nodeEnv`)

Validate required server environment variables once at startup with any Standard Schema validator:

```ts
import { defineEnv, nodeEnv } from 'kay/server'
import { z } from 'zod'

export const env = defineEnv(z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
}))

const isProd = nodeEnv() === 'production'
```

Use `nodeEnv()` instead of reading `process.env.NODE_ENV` directly when writing reusable modules or plugins. In `--compile` binaries, `Bun.build` can inline `process.env.NODE_ENV` at build time, while `nodeEnv()` always reads the runtime value.
