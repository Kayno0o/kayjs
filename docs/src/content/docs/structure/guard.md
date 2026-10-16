---
title: _guard.ts
order: 5
description: A check run before every page, action and endpoint in its folder and below.
path: src/routes/_guard.ts
---

A `_guard.ts` runs before every page, action and [endpoint](/structure/endpoint) in its folder and below. It lets the request through unless it redirects or denies.

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    return deny(403, 'Admins only')
})
```

A guard's `ctx` is the same one a page, an endpoint and an action get. That is `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`.

`redirect`, `notFound` and `deny` throw. Write `return redirect(...)`, so TypeScript knows nothing after it runs.

A guard in a library reads locals the app may not have registered. It names them as a type argument, `guard<{ auth: Auth }>(...)`, and its `ctx.locals` has them. That is a claim about the plugin the app mounts, which nothing checks when the guard runs.

Guards still run on every request to a prerendered page. A guard under a param folder reads that param, as `src/routes/orgs/[org]/_guard.ts` reads `params.org`. One in [`src/api/`](/structure/api) protects its routes the same way.

## A public page under a guard

Set `guards: false` in a page's `page` to run none of the guards above it. Use it for a page anyone may reach, such as the sign-in page under a root guard asking for a session.

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

<ReadMore href="/guides/sessions-and-guards#guards">Guards, public routes and sites that require a guard on every route.</ReadMore>
