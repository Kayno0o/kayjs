---
title: Server Actions
description: Unified Standard-Schema server actions that work as zero-JS progressive HTML forms and typed island RPCs with built-in CSRF protection.
section: core
order: 4
---

Define server mutations once with `action(schema, handler)` from `kay/server`. It accepts any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType, TypeBox, or custom).

## Defining an action

```ts
// src/actions/preferences.ts
import { action } from 'kay/server'
import { z } from 'zod'

export const savePreferences = action(
  z.object({
    project: z.string().min(1),
    target: z.enum(['binary', 'static']),
  }),
  async (input, ctx) => {
    await db.save(ctx.locals.user?.id, input)
    return { saved: true, project: input.project }
  },
)
```

## 1. Zero-JS progressive `<form>`

Pass the action directly to `<form action={savePreferences} method="post">`:

```tsx
import { savePreferences } from '../actions/preferences'

export default function SettingsPage() {
  return (
    <form action={savePreferences} method="post">
      <input name="project" required />
      <select name="target">
        <option value="binary">Single binary</option>
        <option value="static">Static HTML</option>
      </select>
      <button type="submit">Save</button>
    </form>
  )
}
```

No client JavaScript is shipped. Form fields are parsed, validated against the schema, and executed on the server.

A field the schema declares as an array always arrives as one. That includes a checkbox group with one box or none ticked, and a multi-select with a single choice.

## 2. Typed RPC from islands

Import and call the exact same function from an interactive island — Kay strips all server-only code and replaces it with a tiny `actionStub()` RPC call in the client bundle:

```tsx
import { signal } from 'kay'
import { savePreferences } from '../actions/preferences'

export function QuickSave() {
  const status = signal('')
  const onSave = async () => {
    const res = await savePreferences({ project: 'orbit', target: 'binary' })
    status.value = res.ok ? `Saved ${res.data.project}` : res.error
  }
  return <button onClick={onSave}>{status.value || 'Save'}</button>
}
```

The call always resolves to a result. A network failure gives `{ ok: false, status: 0, error }`. Pass a `FormData` instead of an object to send files. If the action answers with a redirect, the page navigates there and the call never resolves.

<Callout title="Built-in CSRF & reverse-proxy support" tone="info">
Every action `POST` automatically verifies the `Origin` / `Referer` header against the request host, honoring `X-Forwarded-Proto` and `X-Forwarded-Host` behind HTTPS reverse proxies (nginx, Caddy, Cloudflare) once `trustProxy` is set in `kay.config.ts`: `true` for one proxy, `2` for a CDN in front of it.
</Callout>
