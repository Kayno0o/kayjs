---
title: Routing & Layouts
description: File-based routes, dynamic params, nested layouts, directory middleware, API endpoints, and hybrid prerendering.
section: core
order: 3
---

Every file in `src/routes/` maps directly to a URL path on `Bun.serve()`.

## Route conventions

| File path | URL pattern | Type |
| :--- | :--- | :--- |
| `src/routes/index.tsx` | `/` | Page |
| `src/routes/about.tsx` | `/about` | Page |
| `src/routes/posts/[slug].tsx` | `/posts/:slug` | Dynamic param (`params.slug`) |
| `src/routes/docs/[...slug].tsx` | `/docs/*slug` | Catch-all (`params.slug`) |
| `src/routes/api/users.ts` | `/api/users` | API route (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) |
| `src/routes/_layout.tsx` | All sibling & nested routes | Nested layout (outer → inner) |
| `src/routes/_middleware.ts` | All sibling & nested routes | Request middleware (outer → inner) |
| `src/routes/_404.tsx` | Unmatched routes | 404 page (also `404.html` in `--static`) |
| `src/routes/_error.tsx` | Uncaught route errors | Error page (receives `{ error }`) |

`_404.tsx` and `_error.tsx` automatically render inside your root `_layout.tsx` with global styles.

Every other file under `src/routes/` must export a page, a method handler or an action, since an action placed there is guarded by its folder's `_middleware.ts`. A helper with none of these fails `kay build` and `kay check`: move it elsewhere, or prefix its name or folder with `_`, as in `_format.ts` or `_components/`. The four special files fail the same way without a default export.

## Data loading (`load` vs `async` page)

Use either an `async` route component (strictly server-only) or a sync route with `export async function load(ctx)`. `load()` can return data props or a `Response` (such as a `404` or redirect):

```tsx
import type { RequestContext } from '@kayjs/kay/server'

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

## API routes & `RequestContext`

Export HTTP verb handlers from any `.ts` file under `src/routes/`:

```ts
// src/routes/api/items.ts
import type { RequestContext } from '@kayjs/kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ items: [], ip: ctx.ip })
}

export async function POST(ctx: RequestContext) {
  const body = await ctx.request.json()
  if (!body?.name)
    return ctx.deny(400, 'name is required', { name: 'Required' })
  return ctx.json({ created: body.name }, { status: 201 })
}
```

Every `RequestContext` provides: `request`, `url`, `params`, `cookies`, `locals`, `ip`, `json(data, init?)`, `text(body, init?)`, `redirect(location, status?)`, and `deny(status, message, fieldErrors?)`.

Unsafe HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) verify `Origin` / `Sec-Fetch-Site` by default. Export `export const csrf = false` in an API route to opt out for external webhooks or bearer-token endpoints.

## Layouts & Middleware

Layouts receive `{ children, params, locals, url }`:

```tsx
import type { KayChild } from '@kayjs/kay'

export default function Layout({ children, locals }: { children: KayChild, locals: Record<string, unknown> }) {
  return (
    <div class="shell">
      <header>{locals.user ? 'Signed in' : 'Guest'}</header>
      <main>{children}</main>
    </div>
  )
}
```

Middleware in `_middleware.ts` runs outer-to-inner before matching routes and actions in that directory:

```ts
import type { Middleware } from '@kayjs/kay/server'

const middleware: Middleware = async (ctx, next) => {
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

Dynamic routes with `prerender = true` must export `paths()` — `kay check` enforces this. Any request for a param not returned by `paths()` receives a `404` instead of falling back to SSR.

In `kay dev`, prerendering is skipped so routes render on demand. In `kay build` and `kay build --static`, all paths prerender concurrently.
