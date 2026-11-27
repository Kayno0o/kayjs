---
title: Configuration & Security
description: kay.config.ts options, default strict CSP with automatic SHA-256 hashes, HSTS, reverse-proxy trust, body limits, error hooks, and typed environment variables.
section: core
order: 6
---

Configure your app in `kay.config.ts` with `defineConfig()` from `@kayjs/kay/config`:

```ts
import { defineConfig } from '@kayjs/kay/config'

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

A key kay does not read fails the build, `kay check` and `kay dev`, naming the key you most likely meant (`outDirr` points at `outDir`).

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
| `navigation` | `{ viewTransitions: true, prefetch: 'moderate', prerender: false }` | How a change from one page to the next feels, with no client JS: see [Page changes](/core/routing-and-layouts#page-changes). |
| `consent` | `undefined` | One-declaration CNIL/RGPD consent categories, cookie name (`'kay_consent'`), retention (`15552000` s = 180 days), and `POST` endpoint (`'/_kay/consent'`). |
| `compliance` | `undefined` | French web law check overrides: `{ ignore?, publicBody?, legalNotice? }`. |
| `streamTimeout` | `30000` | Milliseconds a `<Suspense>` boundary may wait before failing. |
| `compress` | `true` in prod, `false` in dev | Sends the `.br` and `.gz` files `kay build` wrote beside assets, `public/` files and prerendered pages, and compresses the rest on the fly (zstd, gzip), streamed pages included. |
| `onError` | `undefined` | Hook called on unhandled errors in routes, actions, or plugins (`source: 'route' \| 'action' \| 'plugin'`). A hook that throws is logged with its owner, and the other hooks still run. |
| `plugins` | `[]` | Array of `KayPlugin` instances. |

## Security headers & strict CSP

Kay attaches safe security headers to every response out of the box:

- `Content-Security-Policy`: Defaults to `DEFAULT_CSP` (`default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`). A `style="..."` attribute is allowed, since it cannot run script.
- **Automatic SHA-256 hashes**: Each page's policy gains the hashes of the inline styles and scripts it renders: islands, `<Suspense>`, and every `<style>` block of the app. A policy you set in `security.csp` gets the same hashes. No `'unsafe-inline'` is needed for them.
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

Pass `category` for any non-essential cookie (for example, `{ category: 'analytics' }`). Kay refuses to set it unless the visitor has granted consent for that category. Essential cookies (no `category` or `category: 'essential'`) always work.

## French Web Law & Consent (RGPD, CNIL, RGAA, LCEN)

`kay check` and production `kay build` check French web law rules by default and emit actionable warnings (never hard compile errors; pass `kay check --strict` in CI to fail on warnings):

| Rule | What it checks |
| :--- | :--- |
| `rgaa/img-alt` | `<img>` missing an `alt` attribute (`alt=""` is accepted for decorative images). |
| `rgaa/form-label` | `<input>` (except `hidden`/`submit`/`reset`/`button`/`image`), `<select>`, or `<textarea>` without an enclosing `<label>`, matching `<label for>`, `aria-label`, `aria-labelledby`, or `title`. |
| `rgaa/accessible-name` | Empty or icon-only `<button>` or `<a>` with no visible text, `aria-label`, `aria-labelledby`, `title`, or labelled child image/icon. |
| `rgpd/third-party-url` | Third-party URL on `<script src>`, `<link rel="stylesheet\|preload\|preconnect\|dns-prefetch">`, `<iframe src>`, or CSS `@import`/`url(...)` outside `<ConsentGate>` (same-origin `site` and `localhost` are excluded). |
| `lcen/legal-notice` | Page app missing a legal notice route (`/mentions-legales`, `/legal`, `/legal-notice`, `/imprint`, `/impressum`, `/cgu`, `/cgv`, or custom `compliance.legalNotice`). Skipped for API-only apps. |
| `rgaa/accessibility-statement` | When `compliance: { publicBody: true }` is set, missing an accessibility statement route (`/accessibilite`, `/accessibility`, `/declaration-accessibilite`, or `/accessibility-statement`). |

### Silencing warnings

Silence a specific rule explicitly in `kay.config.ts` or inline with a comment naming the rule:

```ts
// kay.config.ts
export default defineConfig({
  compliance: {
    publicBody: false,
    legalNotice: '/mentions-legales', // or false to disable lcen/legal-notice
    ignore: ['rgaa/img-alt'],
  },
})
```

```tsx
{/* kay-ignore rgaa/img-alt */}
<img src="/generated.png" />

// Or at the top of a file:
// kay-ignore-file rgpd/third-party-url
```

### One-declaration consent gating (`consent` & `<ConsentGate>`)

Declare your non-essential categories once in `kay.config.ts`. Kay automatically wires a CSRF-protected `POST /_kay/consent` endpoint (supporting both zero-JS HTML forms and JSON), sets an `HttpOnly; SameSite=Lax` cookie (`kay_consent`, 180-day CNIL max-age by default), exposes `ctx.consent` (`decided`, `categories`, `has(cat)`, `all()`), gates `ctx.cookies.set(..., { category })`, and provides server-only `<ConsentGate>` with **0 KB of browser JS**:

```ts
// kay.config.ts
import { defineConfig } from '@kayjs/kay/config'

export default defineConfig({
  consent: {
    categories: {
      analytics: 'Audience measurement',
      media: 'External video embeds',
    },
  },
})
```

```tsx
// src/routes/index.tsx
import type { PageProps, RouteContext } from '@kayjs/kay'
import { ConsentGate } from '@kayjs/kay'

export function load(ctx: RouteContext) {
  // Refused until the visitor grants 'analytics' consent
  ctx.cookies.set('visitor_id', 'v_123', { category: 'analytics' })
  return { decided: ctx.consent.decided }
}

export default function Home({ data }: PageProps<typeof load>) {
  return (
    <main>
      <ConsentGate category="media" fallback={<p>Accept media cookies to load this video.</p>}>
        <iframe src="https://video.example.com/embed/demo" title="Demo video" />
      </ConsentGate>

      {!data.decided && (
        <form method="post" action="/_kay/consent">
          <button type="submit" name="action" value="accept-all">Accept all</button>
          <button type="submit" name="action" value="reject-all">Reject all</button>
        </form>
      )}
    </main>
  )
}
```

Granular checkboxes (`<input type="checkbox" name="analytics" />`) work with the same zero-JS form, or send JSON `POST /_kay/consent` with `{ categories: { analytics: true, media: false } }`, `{ acceptAll: true }`, or `{ rejectAll: true }`.

## Typed environment variables (`defineEnv` & `nodeEnv`)

Validate required server environment variables once at startup with any Standard Schema validator:

```ts
import { defineEnv, nodeEnv } from '@kayjs/kay/server'
import { z } from 'zod'

export const env = defineEnv(z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
}))

const isProd = nodeEnv() === 'production'
```

Read `nodeEnv()` instead of `process.env.NODE_ENV` in server code. `kay build` does not set `NODE_ENV`, so a page it prerenders would read it unset, while `nodeEnv()` returns the mode of the build or of the running server. In `--compile` binaries, `Bun.build` can also inline `process.env.NODE_ENV` at build time. `kay build` and `kay check` warn on a `process.env.NODE_ENV` read the server runs. An island may read it: its bundle inlines the value.
