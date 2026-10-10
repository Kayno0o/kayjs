# kayjs-mail

Mail for kay apps: SMTP configured from typed environment variables, mails written as `.kay` components rendered to html and text, an outbox shown at `/_kay/mail` in development and read by tests instead of a real server, and sending through kay's queue with retries. It works from kay pages, actions and jobs, and from a plain Elysia app.

## Install

kayjs-mail is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml` (a project made by `kay new` already carries it in its `.npmrc`):

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-mail
```

kay 1.6 or later and Elysia are peers.

## Use

```ts
// src/mail.ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'fr' })
```

```ts
// kay.config.ts: the server runs the queue, and lists the outbox at /_kay/mail in development (kay 1.26 or later; before, `new Elysia().use(mail)` in src/server.ts)
import { mailExtension } from '@kaynooo/kayjs-mail'

export default defineConfig({ extensions: [mailExtension(async () => (await import('./src/mail')).mail)] })
```

```kay
--- server
import { mail } from '../mail'
import Welcome from '../mails/welcome.kay'

export const signUp = action(schema, async ({ name, email }) => {
  await mail.enqueue({ to: email, subject: `Welcome, ${name}`, view: Welcome, props: { name } })
})
---
```

In production it sends over SMTP from `SMTP_HOST`, `SMTP_PORT` (465 by default), `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`, and stops the boot naming any that is missing. A mail naming no recipient, such as a contact form's, goes to `MAIL_TO`. In development and under `bun test` mails stay in the process's outbox.

The full reference, for people and for LLMs, is [llms.txt](./llms.txt).

## Develop

```sh
bun install
bun test
bun run check
bun run lint
```

The tests run the fixture app under `tests/fixture`, which installs this library as an app does, linked back to the repository by `scripts/link-fixture.ts`.

kay ships breaking changes as minors, so the `kay` peer lists each minor this library was tested on as a tilde range (kay 1.22 was never published) rather than `>=1.6 <2`: a new kay minor is tested here, added to the peer, and released as a patch.
