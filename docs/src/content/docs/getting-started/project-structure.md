---
title: Project Structure
description: File-based routing, layouts, middleware, actions, static assets, and kay.config.ts conventions.
section: getting-started
order: 3
---

A typical Kay v2 project stays flat and predictable:

```text
my-app/
├── kay.config.ts           # Plugins, security headers, lang, trustedOrigins
├── public/                 # Served at / (ETag/304 in prod, zero-copy in dev)
├── src/
│   ├── app.css             # Optional global stylesheet (CSS or Tailwind v4)
│   ├── actions/
│   │   └── preferences.ts  # Server actions (auto-stubbed on client)
│   ├── components/
│   │   ├── Counter.tsx     # Interactive -> auto-island
│   │   └── Header.tsx      # Static -> 0 KB JS
│   └── routes/
│       ├── _layout.tsx     # Root layout (wraps all nested routes)
│       ├── _middleware.ts  # Runs before matching routes in this directory
│       ├── _404.tsx        # Custom 404 page (also emitted as 404.html)
│       ├── _error.tsx      # Error boundary page
│       ├── index.tsx       # GET /
│       ├── posts/
│       │   └── [slug].tsx  # GET /posts/:slug
│       └── api/
│           └── health.ts   # GET /api/health (Web Request -> Response)
└── package.json
```

## TypeScript configuration

Enable Kay's JSX import source in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@kayjs/kay",
    "noEmit": true
  }
}
```

## Configuration (`kay.config.ts`)

```ts
import { defineConfig } from '@kayjs/kay/config'
import { ui } from '@kayjs/ui/plugin'
import { seo } from '@kayjs/seo'

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'orbit' }),
    seo({ site: 'https://example.com', name: 'My App' }),
  ],
})
```
