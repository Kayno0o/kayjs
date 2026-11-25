---
title: CLI & Testing
description: Kay CLI commands, plugin subcommands, bundle analysis, and in-process integration testing with testApp() from kay/test.
section: production
order: 4
---

## CLI commands

| Command | Description |
| :--- | :--- |
| `kay new <dir> [--template minimal\|fullstack\|blog\|app] [--force]` | Scaffold a new project |
| `kay check [dir] [--no-typecheck]` | Run Kay compiler checks, route checks, plugin `check()` hooks, and `bun check`/`tsgo`/`tsc` |
| `kay dev [dir] [--port 3000] [--host [addr]]` | Dev server with live reload (binds `127.0.0.1` by default; pass `--host` for `0.0.0.0`) |
| `kay build [dir] [--analyze]` | Single-pass production build into `dist/`; `--analyze` prints per-route JS/CSS weights |
| `kay build --static` | Static HTML + asset export into `dist/` |
| `kay build --compile [out]` | Compile into a single standalone Bun executable |
| `kay start [dir] [--port 3000] [--host [addr]]` | Serve a built `dist/` app on `Bun.serve()` (binds `127.0.0.1` by default) |
| `kay ui-eject <grammar> [dest]` | Eject a `@kayjs/ui` CSS Grammar into your repo |
| `kay mcp-footprint` | Print `@kayjs/mcp` tool sizes in bytes and estimated tokens |
| `kay i18n-check` | List missing translation keys across `@kayjs/i18n` locales |

Plugins can register additional commands via `KayPlugin.commands`.

## In-process testing (`kay/test`)

Test routes, middleware, cookies, auth flows, and server actions in-process with `testApp()` — no port binding needed:

```ts
import { describe, expect, it } from 'bun:test'
import { testApp } from 'kay/test'

describe('app routes', () => {
  it('renders home and submits a server action', async () => {
    const app = await testApp({ root: process.cwd() })

    const res = await app.get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Latest posts')

    // The app's own bundled copy, the one its routes and kay.config.ts use
    const { savePreferences } = await app.import('src/actions/preferences.ts')
    const submitRes = await app.submit(savePreferences, { project: 'orbit', target: 'binary' })
    expect(submitRes.status).toBe(200)
  })
})
```

`TestApp` helpers:

- `app.get(path, headers?)`: Sends a `GET` request with the current cookie jar.
- `app.post(path, body?, headers?)`: Sends JSON (or `FormData`) with `Origin: http://localhost`.
- `app.import(path)`: The app's bundled copy of a route, layout, middleware, action file or `kay.config.ts`, by path from the root. Read module state and actions from it: a module the test file imports itself is a second copy, and its actions have no URL.
- `app.submit(action, fields, headers?)`: Sends `FormData` with `Origin: http://localhost` to an action from `app.import()`, or to an action URL.
- `app.fetch(pathOrRequest, init?)`: Low-level request helper with cookie jar persistence.
- `app.cookies` / `app.clearCookies()`: Inspect or reset cookies between test cases.
- Pass `prebuilt: true` to `testApp({ root, prebuilt: true })` to reuse an existing `dist/` build across tests.
