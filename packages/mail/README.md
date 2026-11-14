# kayjs-mail

Mail for kay apps: SMTP configured from typed environment variables, mails written as `.kay` components rendered to html and text, an outbox shown at `/_kay/mail` under `kay dev` and read by tests instead of a real server, and sending through kay's queue with retries. It works from kay pages, actions and jobs, and from a plain Elysia app.

## Install

kayjs-mail is published to npm as `@kayjs/mail`, beside kay, and as a mirror to the Forgejo registry at git.kaynooo.fr.

```sh
bun add @kayjs/mail
```

kay and Elysia are peers. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together.

## Use

```ts
// kay.config.ts: the server runs the queue, and lists the outbox at /_kay/mail under kay dev
import { mail } from '@kayjs/mail'

export default defineConfig({ extensions: [mail({ from: 'Site <contact@example.com>', locale: 'fr' })] })
```

`send(message)` and `enqueue(message)` from `@kayjs/mail` use that mailer. A transport or views of your own go in a `src/mail.ts` exporting `mailer({ ... })` as `mail`, listed with `mail({ module: './src/mail' })`.

```kay
--- server
import { enqueue } from '@kayjs/mail'
import Welcome from '../mails/welcome.kay'

export const signUp = action(schema, async ({ name, email }) => {
  await enqueue({ to: email, subject: `Welcome, ${name}`, view: Welcome, props: { name } })
})
---
```

In production it sends over SMTP and reads `MAIL_URL` (required, `smtp://user:pass@host:port`, the login and the port optional) and `MAIL_FROM` (optional: `noreply@` the site's host when the site is set, unless `from` is set). It stops the boot naming a required one that is missing; `kay env` lists them all. A mail naming no recipient, such as a contact form's, goes to `MAIL_TO`. In development and under `bun test` mails stay in the process's outbox, and the development pages send one for real, to an address you type, over the SMTP the environment names.

The full reference, for people and for LLMs, is [llms.txt](./llms.txt), which lists its topic files in [llms/](./llms).

## Contributing

This library is developed in [kay's repository](https://github.com/Kayno0o/kayjs), whose [CONTRIBUTING.md](https://github.com/Kayno0o/kayjs/blob/main/CONTRIBUTING.md) says how to work on it.
