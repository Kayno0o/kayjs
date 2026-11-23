# Kay v2

**Write standard TypeScript & JSX. Zero `'use client'`, zero `client:load`.**
Static UI compiles to `0 KB` HTML strings; interactive components automatically become `~2.6 KB` fine-grained signal islands. Built natively on Bun with single-binary production deploys and a strict `KayPlugin` boundary (`~6.9k LOC` core).

---

## Performance (vs Kay v1, Solid, Svelte, Astro, Next.js & Nuxt)

| Metric | **Kay v2** | Kay v1 | Solid | Svelte | Astro | Next.js | Nuxt |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Clean build** | **18.8 ms** | 460 ms | 140 ms | 90 ms | 1,190 ms | 2,180 ms | 2,580 ms |
| **Build output (gzip)** | **5.18 KB** | 65.9 KB | 8.2 KB | 22.5 KB | 137.8 KB | 328.6 KB | 614.7 KB |
| **SSR throughput (500 products)** | **7,017 req/s** | 3,983 req/s | 1,712 req/s | 3,861 req/s | 1,898 req/s | — | 583 req/s |
| **Products JS shipped (gzip)** | **2.62 KB** | 9.9 KB | 8.2 KB | 22.5 KB | 8.6 KB | 133.4 KB | 76.4 KB |
| **Table JS shipped (gzip)** | **4.93 KB** | 12.5 KB | 8.2 KB | 22.5 KB | 9.6 KB | 134.3 KB | 72.3 KB |
| **Table: create 10,000 rows** | **219.1 ms** | 262.0 ms | 226.0 ms | 232.0 ms | 234.0 ms | 360.0 ms | 266.0 ms |
| **Table: replace 1,000 rows** | **23.9 ms** | 25.5 ms | 24.3 ms | 25.9 ms | 24.5 ms | 29.9 ms | 27.4 ms |
| **Table: select row** | **0.20 ms** | **0.20 ms** | 0.30 ms | 1.00 ms | 0.30 ms | 1.20 ms | 0.70 ms |

---

## Quick Example

### Interactive Island (`src/components/Counter.tsx`)
No directives needed — using `signal` or an event handler automatically marks the component as an island:

```tsx
import { signal } from 'kay'

export function Counter({ start = 0 }: { start?: number }) {
  const count = signal(start)
  return (
    <button type="button" onClick={() => count.value++}>
      Clicked {count.value}
    </button>
  )
}
```

### Server Page (`src/routes/index.tsx`) — `0 KB` JS
`async` route components run strictly on the server:

```tsx
import { Head } from 'kay'
import { Counter } from '../components/Counter'
import { db } from '../db'

export default async function Home() {
  const posts = await db.posts.list()
  return (
    <>
      <Head><title>Blog</title></Head>
      <h1>Posts</h1>
      <Counter start={0} />
      <ul>
        {posts.map(post => (
          <li key={post.id}><a href={`/posts/${post.slug}`}>{post.title}</a></li>
        ))}
      </ul>
    </>
  )
}
```

### Unified Server Action (`src/actions/posts.ts`)
Accepts any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType, TypeBox). Works both as a zero-JS progressive `<form action={createPost} method="post">` and as a typed island RPC (`await createPost(data)`), with server code automatically stripped from client bundles and CSRF verified:

```ts
import { action } from 'kay/server'
import { z } from 'zod'

export const createPost = action(
  z.object({ title: z.string().min(1) }),
  async (input, ctx) => {
    const post = await db.posts.create(input)
    return { id: post.id }
  },
)
```

---

## Modular Ecosystem (`KayPlugin`)

Core stays tiny (`~6.9k LOC`). Every optional capability plugs in cleanly through `kay.config.ts`:

| Package | Purpose | Notes |
| :--- | :--- | :--- |
| **`kay`** | Compiler, linked-list signals, DOM runtime, router, SSR/Suspense, actions, build/compile, `kay/test` | 1 runtime dep (`oxc-parser`) |
| **`@kayjs/ui`** | Platform-first headless primitives + 5 structurally distinct pure CSS `@layer kui` Grammars (`editorial`, `workshop`, `console`, `soft`, `orbit`) + `kay ui-eject` | Zero JS recipe engine, zero Tailwind lock-in |
| **`@kayjs/auth`** | Argon2id passwords, hashed DB sessions, magic links, OAuth 2.0 + PKCE (GitHub/Discord/Google), `auth.guard()`, `bun:sqlite` store | Zero external deps |
| **`@kayjs/live`** | Typed real-time SSE rooms, microtask-coalesced presence, `useLive()` browser signal hook | Zero external deps |
| **`@kayjs/content`** | `Bun.markdown` GFM collections, YAML frontmatter + Standard Schema, heading TOC, `paths()` prerender, RSS XML | Zero external deps |
| **`@kayjs/mail`** | Resend HTTP transport, custom transports, and dev-only `/_kay/mail` outbox preview | Zero external deps |
| **`@kayjs/images`** | Build-time responsive AVIF/WebP pipeline + content-hash cache + `<Picture>` | Sharp-backed |
| **`@kayjs/icons`** | Virtual `~icons/<set>/<name>` imports + browser-pure `<Icon>` | Iconify JSON sets |
| **`@kayjs/seo`** | `titleTemplate`, OpenGraph/Twitter meta, JSON-LD, sitemap, redirects, self-hosted fonts | Zero external deps |
| **`@kayjs/tailwind`** | Tailwind v4 CSS integration via `bun-plugin-tailwind` | Opt-in |
| **`@kayjs/spa`** | Opt-in SPA navigation with persistent islands | Opt-in |
| **`@kayjs/i18n`** | Locale URL rewriting, dictionary lookup & localized HTML | Zero external deps |

---

## Examples

- **[`examples/showcase`](examples/showcase)** — Live `@kayjs/ui` Grammar Switcher (`editorial` / `workshop` / `console` / `soft` / `orbit` / `bare`), every UI primitive, and guarded `@kayjs/auth` routes.
- **[`examples/noticeboard`](examples/noticeboard)** — Full-stack real-time app combining `@kayjs/auth`, `@kayjs/live` (SSE presence & live push), `@kayjs/mail`, `@kayjs/ui`, Standard-Schema `action()`, and `bun:sqlite`.

```sh
cd examples/showcase && bun run dev
cd examples/noticeboard && bun run dev
```

## CLI Commands

```sh
kay new my-app [--template minimal|fullstack|blog|app]  # Scaffold a new project
kay check                              # Validate routes, compiler rules & types
kay dev                                # Fast rebuild + live reload
kay build                              # Production client + server build
kay build --static                     # Pure static HTML export
kay build --compile ./server           # Single standalone executable
kay start                              # Serve built production app
kay ui-eject editorial                 # Eject a standalone @kayjs/ui CSS Grammar
```
