---
title: _guard.ts
order: 5
description: A check run before every page, action and endpoint in its folder and below.
path: src/routes/_guard.ts
---

A `_guard.ts` runs before every page, action and [endpoint](/structure/endpoint) in its folder and below. It lets the request through unless it redirects or denies:

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    deny(403, 'Admins only')
})
```

Guards still run on every request to a prerendered page. A guard under a param folder reads that param, as `src/routes/orgs/[org]/_guard.ts` reads `params.org`. One in [`src/api/`](/structure/api) protects its routes the same way.

A page under a guard that anyone may reach, such as the sign-in page under a root guard asking for a session, sets `guards: false` in its `page` and runs none of the guards above it:

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

<ReadMore href="/guides/sessions-and-guards#guards">Guards, public routes and sites that require a guard on every route.</ReadMore>
