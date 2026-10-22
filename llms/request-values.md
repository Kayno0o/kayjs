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

They are loaded before the render, so the markup is in the first bytes with JavaScript off. A page whose imports (its layouts, components and helpers, however deep) reach no template reading `ctx` loads nothing and reads no session. A page that does is the visitor's own: its answer is `private, no-cache` with `Vary: cookie`, and a page kept by the build is rendered per request.

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

## Reference

- The keys are typed from the extension's module in `kay check` and the editor: `kay check` writes them into `.kay/types/kay-env.d.ts`.
- Two extensions loading the same key throw, naming both.
- A fence reads `ctx` as before, the request: only a template reading `ctx` with no `ctx` declared in its file gets the values.
- An island cannot read `ctx`, it renders in the browser too: `kay check` and the build refuse it, so pass the value as a prop.
- A page with `prerender: true` that reaches a template reading `ctx` fails the build asking for a render per request, as any request read does.
- A load that throws fails the render like a fence's would: an extension answering a missing session returns no user rather than throwing.
- A template's `ctx` holds the extensions' values only: the request (`ctx.params`, `ctx.url`) is read in a `--- server` fence.
- The walk follows import specifiers and the files an `import.meta.glob` pattern matches, in `.kay` files and in scripts of the app: a component reached only through a script in `node_modules` is not followed, so import it in the page, or its `ctx` read throws.
- The pages that load them are found as `layout: { file, reaching }` finds them ([Component libraries](component-libraries.md#extensions)).
