# Noticeboard

A club noticeboard running kay with its libraries together. Members join and sign in on [kayjs-auth](../../packages/auth)'s prebuilt pages under `/auth`, with passwords and mailed links, and manage their account there; [kayjs-mail](../../packages/mail) sends those mails and the notices; [kayjs-ui](../../packages/ui) draws the cards, the dialog pinning a notice and the toasts. Postgres keeps the members and the notices through `@kaynooo/pg-orm`, a `queue()` job mails each new notice to the members with a confirmed address, and a `rooms()` websocket shows who is reading and each notice as it is pinned.

## How it is wired

`kay.config.ts` lists `auth` and `mail`, and that is all the wiring: they add kayjs-auth's and kayjs-mail's plugins before the pages, so `src/server.ts` mounts only the queue, and they bring the sign-in, register, reset, verify and account pages and the mails' wording. `src/auth.ts` sets `pages: true` and sends its mails through `authMailer(mail.enqueue)`. The example keeps no sign-in page of its own: the shipped ones cover every flow it had, so a member picks a name on the account page and the tests drive the shipped pages' actions, which `tests/pages.ts` imports.

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
