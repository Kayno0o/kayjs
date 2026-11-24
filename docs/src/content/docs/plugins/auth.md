---
title: "@kayjs/auth"
description: Zero-dependency Bun-native authentication — Argon2id passwords, hashed sessions, magic links, OAuth 2.0 + PKCE, route guards, and SQLite.
section: plugins
order: 2
---

`@kayjs/auth` ships a complete authentication layer in ~1,285 lines of TypeScript with **zero external dependencies**, built natively on `Bun.password` (Argon2id), Web Crypto, and `bun:sqlite`.

## Setup

```ts
// src/auth.ts
import { createAuth, github, sqliteAuthStore } from '@kayjs/auth'
import { mail } from './mail'

export const auth = createAuth({
  store: sqliteAuthStore('data/app.sqlite'),
  secret: process.env.AUTH_SECRET!,
  site: 'https://example.com',
  defaultRedirect: '/dashboard',
  sendMail: async m => mail.send({ to: m.to, subject: m.subject, text: m.text, html: m.html }),
  providers: [
    github({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
})
```

`site` is the public origin of the app. Sign-in links in emails and OAuth callbacks are built from it, never from the request's `Host` header, which the client controls. Without it, magic links only work on `localhost`, and other hosts get a `500`.

Register `auth.plugin` in `kay.config.ts`:

```ts
import { defineConfig } from 'kay/server'
import { auth } from './src/auth'

export default defineConfig({
  plugins: [auth.plugin],
})
```

## Built-in endpoints

| Route | Behavior |
| :--- | :--- |
| `POST /auth/signup` | Argon2id password hash + session cookie |
| `POST /auth/signin` | Timing-safe Argon2id verify + per-IP rate limiting (`429`) |
| `POST /auth/signout` | Revokes hashed session + clears cookie |
| `GET /auth/session` | Returns current public user JSON |
| `POST /auth/magic-link` & `GET /auth/magic-link/verify` | One-time email login via `@kayjs/mail`. The first sign-in by link verifies the address and drops any password and sessions set before it |
| `GET /auth/oauth/:provider` & callback | OAuth 2.0 + PKCE (`S256`) with HMAC-signed state (`github`, `discord`, `google`, or custom `oauthProvider`) |

## Protecting routes & actions

Protect any directory with `_middleware.ts`:

```ts
// src/routes/dashboard/_middleware.ts
import { auth } from '../../auth'

export default auth.guard({ redirectTo: '/login' })
```

Inside any route, layout, or server `action()`, `ctx.locals.user` is automatically populated with the signed-in user (or `undefined`).
