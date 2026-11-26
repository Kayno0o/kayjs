---
title: Streaming & Head
description: Document <Head> metadata collection, <Suspense> streaming SSR with 0 KB external JS, and error/timeout handling.
section: core
order: 5
---

## Document `<Head>`

Place `<Head>` anywhere inside a layout or page. Kay collects all tags during SSR and hoists them into `<head>`. When multiple `<title>` tags render, the innermost page `<title>` wins:

```tsx
import { Head } from '@kayjs/kay'

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

Wrap a slow async server component in `<Suspense fallback={...}>` to send the HTML shell immediately and stream the resolved chunk inline with **0 KB** of external JavaScript:

```tsx
import { Suspense } from '@kayjs/kay'

async function LiveStats() {
  const stats = await fetchSlowAnalytics()
  return <p>{stats.visitors} visitors today</p>
}

export default function Dashboard() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Suspense fallback={<p>Loading stats…</p>} error={<p>Stats unavailable.</p>}>
        <LiveStats />
      </Suspense>
    </main>
  )
}
```

- **One child per boundary**: Give each `<Suspense>` a single child (use one `<Suspense>` per async component). Nested `<Suspense>` boundaries inside a resolved chunk stream as well.
- **Error handling**: If the child throws, the boundary renders its `error` prop (markup or `(err) => Html`) in place of the fallback, the rest of the page keeps streaming, and `onError` in `kay.config.ts` is notified. Without `error`, the failed boundary renders nothing.
- **Timeout**: A boundary that does not resolve within `30` seconds fails so the response always finishes. Change the limit with `streamTimeout` (in milliseconds) in `kay.config.ts`.

For `defineEnv()`, `nodeEnv()`, cookies, and security headers, see [Configuration & Security](/docs/core/configuration-and-security).
