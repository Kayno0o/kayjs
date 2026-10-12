# Noticeboard

A club noticeboard running kay with its libraries together, as a site migrated to kay does. Members join and sign in through [kayjs-auth](../../packages/auth), with passwords and mailed links; [kayjs-mail](../../packages/mail) sends those mails and the notices; [kayjs-ui](../../packages/ui) draws the cards, the dialog pinning a notice and the toasts. Postgres keeps the members and the notices through `@kaynooo/pg-orm`, a `queue()` job mails each new notice to the members with a confirmed address, and a `rooms()` websocket shows who is reading and each notice as it is pinned.

It runs on the kay of this checkout, and on the libraries kay's repository installs: kay's own tests check it, run its tests and compile it, so a change that breaks kay with its libraries fails there before it reaches a site.

## Run it

From the root of kay's repository, `bun install` once, then here:

```sh
cp .env.example .env    # then fill in the two secrets
docker compose up -d --wait
bun run db:migrate
bun run dev
```

Mails go to the outbox in development, listed at http://localhost:3000/_kay/mail, where the links to confirm an address or sign in are.

## Test it

```sh
bun run test
```

Each test file gets a copy of the migrated database, on the server `.env.test` names, which `docker compose up -d --wait` starts. The browser test runs where Chrome or Chromium is found.

## Build it

`bun run compile` makes the one executable, `server`. The image is built from the root of kay's repository, which holds what it runs on:

```sh
docker build -f examples/noticeboard/Dockerfile .
```

`compose.prod.yaml` runs it with its database, the migrations applied first; it names the variables production sets.
