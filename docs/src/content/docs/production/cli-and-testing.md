---
title: CLI & Testing
description: Kay CLI commands and in-process integration testing with testApp() from kay/test.
section: production
order: 4
---

## CLI commands

| Command | Description |
| :--- | :--- |
| `kay new <dir> [--template minimal\|fullstack\|blog\|app]` | Scaffold a new project |
| `kay check` | Run TypeScript typechecking + Kay compiler validation |
| `kay dev` | Fast incremental dev server with SSE live reload (`~60–170 ms` rebuilds) |
| `kay build` | Single-pass production build into `dist/` |
| `kay build --static` | Static HTML + asset export into `dist/static/` |
| `kay build --compile [out]` | Compile into a single standalone Bun executable |
| `kay start` | Serve a built `dist/` app on `Bun.serve()` |
| `kay ui-eject <grammar> [dest]` | Eject a `@kayjs/ui` CSS Grammar into your repo |

## In-process testing (`kay/test`)

Test routes, middleware, cookies, auth flows, and server actions directly in-process with `testApp()` — no port binding required:

```ts
import { describe, expect, it } from 'bun:test'
import { testApp } from 'kay/test'

describe('app routes', () => {
  it('renders home and submits a server action', async () => {
    const app = await testApp({ root: process.cwd() })

    const res = await app.get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Latest posts')

    // Persistent cookie jar across requests
    const submitRes = await app.submit('/settings', { project: 'orbit' })
    expect(submitRes.status).toBe(200)
  })
})
```
