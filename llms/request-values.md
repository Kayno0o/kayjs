# Request values in templates

## Common tasks

### Read the signed-in user in a layout or component with no fence

A template reads `ctx.<key>` for the request values an extension gives it, with no `--- server` fence and no import. kayjs-auth gives `ctx.user` and `ctx.can(role)`:

```kay
nav
  if ctx.user as user
    p Signed in as {user.username}
  if ctx.can('admin')
    a(href="/admin") Admin
```

They are loaded before the render, so the markup is in the first bytes with JavaScript off. A page whose imports (its layouts, components and helpers, however deep) reach no template reading `ctx` loads nothing and reads no session. A page that does is the visitor's own: its answer is `private, no-cache` with `Vary: cookie`, and a page kept by the build is rendered per request. `kay build` records which templates read `ctx` in `.kay/client/context-reads.json`, which a server started from disk reads in place of the templates.

### Give templates request values from an extension

An extension's `context` names a module default-exporting `defineContext(load)`. `load(request)` runs at most once per request, for a page reaching a template that reads `ctx`, and the keys it returns are `ctx.<key>`:

```ts
// src/pages/index.ts
import type { KayExtension } from 'kay/server'

export function reports(): KayExtension {
  return { name: 'reports', context: `${import.meta.dir}/../context.ts` }
}
```

```ts
// src/context.ts
import { defineContext } from 'kay/library'

export default defineContext(async (request: Request) => ({ plan: await planOf(request) }))
```

### Load a value only for the pages that show it

`defineContext` also takes an object of loaders, one per key. A loader runs at most once per request and only for a page whose templates read that key, so a cart count costs nothing on a page showing no cart, nor does the session read on a page showing no user:

```ts
// src/context.ts
import { defineContext } from 'kay/library'

export default defineContext({
  cartCount: async (request: Request) => countCart(request),
  user: async (request: Request) => userOf(request),
})
```

```kay
// a component reading only ctx.cartCount loads only that
a(href="/cart") Cart ({ctx.cartCount})
```

## Reference

- The keys are typed from the extension's module in `kay check` and the editor: `kay check` writes them into `.kay/types/kay-env.d.ts`.
- Two extensions loading the same key throw, naming both.
- A fence reads `ctx` as before, the request: only a template reading `ctx` with no `ctx` declared in its file gets the values.
- An island cannot read `ctx`, it renders in the browser too: `kay check` and the build refuse it, so pass the value as a prop.
- A page with `prerender: true` that reaches a template reading `ctx` fails the build asking for a render per request, as any request read does.
- A load that throws fails the render like a fence's would: an extension answering a missing session returns no user rather than throwing.
- A template's `ctx` holds the extensions' values only: the request (`ctx.params`, `ctx.url`) is read in a `--- server` fence.
- The walk is the one that finds islands: it follows static and literal dynamic imports, aliases and `import.meta.glob`, a library's components wherever it is installed and the app's scripts. A computed `import(x)` or a script in `node_modules` is not followed, so a page reaching a template only through one throws when the template reads `ctx`.
- A template using `ctx` any other way than `ctx.name`, passed whole, spread or indexed, loads every key, as does an error page or a 404, which may show keys the failed page did not. A key is read off `ctx` in a template or its script, not in a `--- server` fence, whose `ctx` is the request.
- Values hold no prototype: `ctx.hasOwnProperty` is undefined and `String(ctx)` throws.
- A function `defineContext(load)` still loads all its keys at once.
- The pages that load them are found as `layout: { file, reaching }` finds them ([Component libraries](component-libraries.md#extensions)).
