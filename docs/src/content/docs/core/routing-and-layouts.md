---
title: Routing & Layouts
description: File-based routes, dynamic params, nested layouts, directory middleware, API endpoints, and hybrid prerendering.
section: core
order: 3
---

Every file in `src/routes/` maps directly to a URL path on Bun's native server.

## Route conventions

| File path | URL pattern | Type |
| :--- | :--- | :--- |
| `src/routes/index.tsx` | `/` | Page |
| `src/routes/about.tsx` | `/about` | Page |
| `src/routes/posts/[slug].tsx` | `/posts/:slug` | Dynamic param (`params.slug`) |
| `src/routes/docs/[...slug].tsx` | `/docs/*slug` | Catch-all (`params.slug`) |
| `src/routes/api/users.ts` | `/api/users` | API route (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) |
| `src/routes/_layout.tsx` | All sibling & nested routes | Nested layout (outer → inner) |
| `src/routes/_middleware.ts` | All sibling & nested routes | Request middleware |
| `src/routes/_404.tsx` | Unmatched routes | 404 page (also `404.html` in `--static`) |
| `src/routes/_error.tsx` | Uncaught route errors | Error page |

## Data loading (`load` vs `async` page)

Use either an `async` route component (strictly server-only) or a sync route with `export async function load(ctx)` (which can return data or a `Response` like `404` / redirect):

```tsx
import type { RequestContext } from 'kay/server'

export async function load(ctx: RequestContext) {
  const post = await findPost(ctx.params.slug)
  if (!post)
    return new Response('Not found', { status: 404 })
  return { post }
}

export default function PostPage({ data }: { data: { post: Post } }) {
  return <article><h1>{data.post.title}</h1></article>
}
```

## Layouts & Middleware

Layouts receive `{ children, params, locals, url }`:

```tsx
import type { KayChild } from 'kay'

export default function Layout({ children, locals }: { children: KayChild, locals: Record<string, unknown> }) {
  return (
    <div class="shell">
      <header>{locals.user ? 'Signed in' : 'Guest'}</header>
      <main>{children}</main>
    </div>
  )
}
```

Middleware in `_middleware.ts` runs outer-to-inner before matching routes:

```ts
import type { Middleware } from 'kay/server'

export const middleware: Middleware = async (ctx, next) => {
  ctx.locals.requestId = crypto.randomUUID()
  return next()
}
export default middleware
```

## Hybrid prerendering

Mark any static or dynamic route with `export const prerender = true`:

```tsx
export const prerender = true
export function paths() {
  return ['/posts/hello', '/posts/kay-v2']
}
```

In `kay dev`, prerendering is skipped so routes render on-demand in milliseconds. In `kay build` / `kay build --static`, all paths are prerendered concurrently.
