---
title: Streaming & Head
description: Document <Head> metadata collection, <Suspense> streaming SSR with 0 KB external JS, error/timeout handling, and <Catch> error boundaries.
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

- **One child per boundary**: Give each `<Suspense>` a single child (use one `<Suspense>` per async component). An async component renders only as that child. Anywhere else, even inside an async page or inside an element in the boundary, `kay build` and `kay check` fail with its file and line. Nested `<Suspense>` boundaries inside a resolved chunk stream as well.
- **Error handling**: If the child throws, the boundary renders its `error` prop (markup or `(err) => Html`) in place of the fallback, the rest of the page keeps streaming, and `onError` in `kay.config.ts` is notified. Without `error`, the failed boundary renders nothing.
- **Timeout**: A boundary that does not resolve within `30` seconds fails so the response always finishes. Change the limit with `streamTimeout` (in milliseconds) in `kay.config.ts`.
- **Compression**: A streamed page is compressed in zstd or gzip, whichever the browser takes, and flushed with each part, so the shell still arrives before the parts that wait.

## Catching errors with `<Catch>`

`<Catch>` renders its `fallback` in place of children that throw, so one broken part leaves the rest of the page standing:

```tsx
import { Catch } from '@kayjs/kay'

export default function Product({ product }) {
  return (
    <main>
      <h1>{product.name}</h1>
      <Catch fallback={<p>Reviews are unavailable right now.</p>}>
        <Reviews productId={product.id} />
      </Catch>
    </main>
  )
}
```

- **On the server**: A child that throws, or an awaited child that rejects, renders the fallback, and `onError` in `kay.config.ts` is notified. Unlike `<Suspense>`, nothing streams: the page waits for the children. Wrap an async component in `<Suspense error={...}>` instead.
- **In an island**: `<Catch>` works there too, and also catches an effect of its children that throws later, after a click for instance. A fallback written as a function gets the error and `retry`, which renders the children again:

```tsx
<Catch fallback={(error, retry) => <button onClick={retry}>Reload the chart</button>}>
  <Chart points={points.value} />
</Catch>
```

- **Event handlers**: An error thrown by an `onClick` or another handler is not caught. Catch it in the handler.

For `defineEnv()`, `nodeEnv()`, cookies, and security headers, see [Configuration & Security](/docs/core/configuration-and-security).
