---
title: Streaming & Head
description: Document <Head> metadata collection, <Suspense> streaming SSR with 0 KB external JS, cookies, security headers, and typed defineEnv().
section: core
order: 5
---

## Document `<Head>`

Place `<Head>` anywhere inside a layout or page. Kay collects all tags during SSR and hoists them into `<head>` (when multiple `<title>` tags are rendered, the innermost page `<title>` wins):

```tsx
import { Head } from 'kay'

export default function AboutPage() {
  return (
    <>
      <Head>
        <title>About</title>
        <meta name="description" content="About our app" />
      </Head>
      <h1>About</h1>
    </>
  )
}
```

## Streaming `<Suspense>`

Wrap slow async server components in `<Suspense fallback={...}>` to stream the HTML shell immediately and flush resolved chunks inline with **0 KB** of external JavaScript:

```tsx
import { Suspense } from 'kay'

async function LiveStats() {
  const stats = await fetchSlowAnalytics()
  return <p>{stats.visitors} visitors today</p>
}

export default function Dashboard() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Suspense fallback={<p>Loading stats…</p>}>
        <LiveStats />
      </Suspense>
    </main>
  )
}
```

## Typed environment variables (`defineEnv`)

Validate environment variables once at startup with any Standard Schema validator:

```ts
import { defineEnv } from 'kay/server'
import { z } from 'zod'

export const env = defineEnv(z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
}))
```

## Cookies & Security Headers

- Read/write cookies via `ctx.cookies.get('name')`, `ctx.cookies.set('name', value, { httpOnly: true, secure: true, sameSite: 'lax' })`, and `ctx.cookies.delete('name')`.
- Configure `security: { csp: "..." }` in `kay.config.ts` to attach `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options` automatically on every response.
