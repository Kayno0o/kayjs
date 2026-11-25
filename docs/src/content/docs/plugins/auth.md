---
title: "@kayjs/auth"
description: Zero-dependency Bun-native authentication — Argon2id passwords, hashed sessions, email verification, magic links, OAuth 2.0 + PKCE, route guards, RGPD helpers, and SQLite.
section: plugins
order: 2
---

`@kayjs/auth` ships a complete authentication layer with **zero external dependencies**, built natively on `Bun.password` (Argon2id), Web Crypto, and `bun:sqlite`.

## Setup

```ts
// src/auth.ts
import { createAuth, github } from '@kayjs/auth'
import { sqliteAuthStore } from '@kayjs/auth/sqlite'
import { mail } from './mail'

export const auth = createAuth({
  store: sqliteAuthStore('./data/app.sqlite'),
  secret: process.env.AUTH_SECRET,
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

- **`secret`**: In `NODE_ENV=production`, `secret` (or `AUTH_SECRET` env) is **required** and must be at least **32 UTF-8 bytes**. An empty string is rejected in all environments. In development, omitting `secret` generates an ephemeral key per process.
- **`site`**: The public origin of the app. Mailed sign-in/verification links and OAuth callbacks are built from it, never from the request's `Host` header, which the client controls. Without it, mailed links only work on loopback hosts (`localhost` / `127.0.0.1`), and other hosts receive `500`.
- **`requireEmailVerification`**: Defaults to `true`. `POST /auth/signup` creates an unverified account, mails a one-time verification link (`kind: 'verify-email'`), and returns `202 { ok: true, verificationRequired: true }` without opening a session cookie. `POST /auth/signin` refuses unverified accounts with `403`. Set `requireEmailVerification: false` explicitly only if you intentionally allow unverified password sessions (for example, local development without mail).
- **`trustProxy`**: Defaults to `false`. Rate limiting keys on `ctx.ip` (populated by Kay's server) plus the normalized email address on email-bearing endpoints, and covers sign-up, sign-in, magic-link, verification, and OAuth endpoints. Forwarded headers are ignored unless `trustProxy` is set: `true` trusts one proxy, a number trusts that many hops, and only the entry those hops wrote counts.

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
| `POST /auth/signup` | Argon2id password hash; by default sends a verification email and returns `202` without opening a session (`201` + session only when `requireEmailVerification: false`) |
| `GET` / `POST /auth/verify-email` | Consumes one-time `verify-email` token, marks `emailVerified = true`, and opens a session cookie |
| `POST /auth/signin` | Timing-safe Argon2id verify, rejects unverified accounts (`403`) when verification is required, IP + email rate limiting (`429`) |
| `POST /auth/signout` | Revokes hashed session + clears cookie |
| `GET /auth/session` | Returns current public user JSON |
| `POST /auth/magic-link` & `GET /auth/magic-link/verify` | One-time email login via `@kayjs/mail`. The first sign-in by link verifies the address and drops any password, sessions and provider links set before it |
| `GET /auth/oauth/:provider` & callback | OAuth 2.0 + PKCE (`S256`) with HMAC-signed state (`github`, `discord`, `google`, or custom `oauthProvider`), rate limited |

## Protecting routes & actions

Protect any directory with `_middleware.ts`:

```ts
// src/routes/dashboard/_middleware.ts
import { auth } from '../../auth'

export default auth.guard({ redirectTo: '/login' })
```

Inside any route, layout, or server `action()`, `ctx.locals.user` is automatically populated with the signed-in user (or `undefined`).

## Data retention & RGPD helpers

`createAuth()` automatically starts an unref'd background timer (`pruneIntervalMs`, default 15 minutes; set `false` to disable) that calls `store.pruneExpired()` and sweeps expired rate-limit buckets. Call `auth.dispose()` in tests or shutdown hooks to stop the timer.

For session data minimization, you can configure:

- `storeIp`: `true` (default), `'truncate'` (IPv4 `/24`, IPv6 `/48`), or `false` (omit IP).
- `storeUserAgent`: `true` (default) or `false` (omit `User-Agent`).

The `Auth` instance also exposes RGPD lifecycle methods delegating to your `AuthStore`:

```ts
const sessions = await auth.listSessions(userId)   // Active non-expired sessions
const dump = await auth.exportUser(userId)          // Public profile (no passwordHash), sessions, OAuth links
await auth.deleteUser(userId)                       // Cascades user, sessions, OAuth accounts, and tokens
await auth.pruneExpired()                           // Manual purge of expired sessions, tokens, and rate-limit entries
```

## Custom `AuthStore` & Migration

If you implement a custom `AuthStore` (rather than using `memoryAuthStore()` or `sqliteAuthStore()`), ensure your adapter implements all required methods on the `AuthStore` interface:

- **`deleteUserOAuthAccounts(userId: string)`** *(added in #3525)*: Deletes all OAuth provider links belonging to `userId`. Called when an unverified account is claimed via a verified magic link or verified OAuth login so a pre-account squatter cannot retain provider access.
- **`deleteUser(userId: string)`**: Permanently deletes the user and cascades removal of all associated sessions, OAuth accounts, and verification tokens (matching both `userId` and the user's email address).
- **`exportUser(userId: string)`**: Returns a `UserExport` (`{ user, sessions, oauthAccounts, exportedAt }`) with `passwordHash` stripped and only active non-expired sessions included, or `null` if the user does not exist.
- **`listSessions(userId: string)`**: Returns all active, non-expired `AuthSession` records for `userId`.
- **`pruneExpired()`**: Deletes expired sessions and expired verification tokens from storage. Invoked automatically on the `pruneIntervalMs` timer.
