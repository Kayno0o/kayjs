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

## Handing a value on

A guard may return an object. Every guard below it, and the layouts, the page and its actions, read it as `ctx.guard`, so nothing loads the same record again.

```ts
import { guard } from 'kay'

export default guard(async ({ params, deny }) => {
  const org = await loadOrg(String(params.org))

  return org ?? deny(404)
})
```

Wrap the record in an object (`return { org }`) to give it a name. A page, a layout and the actions of a page read `ctx.guard.org`, and `kay check` types it from the guards above the file. The objects of several guards are merged, outermost first, and a guard below wins a key it shares. A guard reads what the ones above returned in its own `ctx.guard`.

`ctx.guard` is empty on a page that sets `guards: false`, and a prerendered page has none, since its guards run when it is served. `ctx.locals` stays what the app's Elysia plugins add.

## Sharing a load

A layout and its page load at the same time, and a layout cannot read its page's data. `ctx.once(key, load)` runs `load` the first time the request asks for `key` and gives every later ask the same promise.

```kay
--- server
const org = await ctx.once(`org:${ctx.params.org}`, () => loadOrg(ctx.params.org))
---
h1 {org.name}
```

It lasts as long as the request and is never shared between visitors. A load that fails fails for everyone who asked. For data shared between visitors, use `cached`.

## A public page under a guard

Set `guards: false` in a page's `page` to run none of the guards above it. Use it for a page anyone may reach, such as the sign-in page under a root guard asking for a session.

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

<ReadMore href="/guides/sessions-and-guards#guards">Guards, public routes and sites that require a guard on every route.</ReadMore>
