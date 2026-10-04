# kay-auth

Auth for kay apps, built on kay's sessions: OAuth sign-in, passwords, mailed links (verification, reset, magic links, email change), TOTP two-factor with recovery codes, bearer tokens and security mails. It works in kay pages, actions and guards, and in a plain Elysia app, with its data in memory, in Postgres through pg-orm, or in a store of your own.

```sh
bun add @kaynooo/kay-auth
```

```ts
export const auth = createAuth({ sessions: session<AuthSessionData>({ secret }), secret, store: memoryStore() })

const app = new Elysia().use(auth.plugin).use(await pages())
```

Tests need Postgres for the pg store: `docker compose up -d`, then `bun test`.

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt).
