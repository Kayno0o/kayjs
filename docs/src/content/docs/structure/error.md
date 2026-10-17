---
title: _error.kay
order: 4
description: The page shown when a load or a render throws.
path: src/routes/_error.kay
---

`_error.kay` renders with status 500 when a load or a render throws in its folder and below, and for a 404 with no [`_404.kay`](/structure/not-found). `ctx.deny(403, 'Members only')` renders it too, with that status and message. It reads `ctx.error`.

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

`ctx.error` holds `status`, `message` and, in development only, `stack`. In production the message is generic and the real error goes to `console.error`.

Without an `_error.kay` the response is plain text, and development shows an error page with the stack instead.

The nearest `_error.kay` wins, wrapped by the layouts of its own folder. Each error kay logs also goes to the `onError` option of [`kay.config.ts`](/structure/kay-config). Use it to send errors to an error tracker. It also gets an error a scheduled, background or queued job (once out of attempts) or an `onStop` hook throws, with no request, and an error an island meets in the browser, as a `BrowserError` whose stack points at your `.kay` files in production.

kay waits 10 seconds at most for `onError` after a job or an `onStop` hook, so a tracker that hangs holds neither a queue worker nor a shutdown.

<ReadMore href="/essentials/routing#not-found-and-errors">Not found and error pages in the routing guide.</ReadMore>
