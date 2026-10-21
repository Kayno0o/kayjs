# kayjs-mail

Mail for kay apps: SMTP configured from typed environment variables, mails written as `.kay` components rendered to html and text, an outbox shown at `/_kay/mail` under `kay dev` and read by tests instead of a real server, and sending through kay's queue with retries. It works from kay pages, actions and jobs, and from a plain Elysia app.

## Install

kayjs-mail is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml` (a project made by `kay new` already carries it in its `.npmrc`):

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-mail
```

kay and Elysia are peers. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together. An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Use

```ts
// src/mail.ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'fr' })
```

```ts
// kay.config.ts: the server runs the queue, and lists the outbox at /_kay/mail under kay dev
import { mail } from '@kaynooo/kayjs-mail'

export default defineConfig({ extensions: [mail({ module: './src/mail' })] })
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

In production it sends over SMTP and reads `MAIL_URL` (required, `smtp://user:pass@host:port`, the login and the port optional) and `MAIL_FROM` (optional: `noreply@` the site's host when the site is set, unless `from` is set). It stops the boot naming a required one that is missing; `kay env` lists them all. A mail naming no recipient, such as a contact form's, goes to `MAIL_TO`. In development and under `bun test` mails stay in the process's outbox, and the development pages send one for real, to an address you type, over the SMTP the environment names.

The full reference, for people and for LLMs, is [llms.txt](./llms.txt), which lists its topic files in [llms/](./llms).

## Contributing

This library is developed in [kay's repository](https://github.com/Kayno0o/kayjs), whose [CONTRIBUTING.md](https://github.com/Kayno0o/kayjs/blob/main/CONTRIBUTING.md) says how to work on it.
