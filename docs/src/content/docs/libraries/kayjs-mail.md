---
title: kayjs-mail
order: 2
description: Send mail from kay apps with SMTP, mails written as .kay components, and an outbox in development.
---
`@kaynooo/kayjs-mail` sends mail over SMTP, renders mails written as `.kay` components to html and text, and queues them with retries through kay's queue. In development and tests nothing leaves the process: mails go to an outbox.

## Install

```sh
bun add @kaynooo/kayjs-mail
```

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc`. kay and Elysia are peers.

## Setup

`src/mail.ts` creates the mailer. `from` is your own address, a visitor's address goes in `replyTo`:

```ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'en' })
```

It is an Elysia plugin, so the server uses it to run the queue and, in development, serve the outbox at `/_kay/mail`:

```ts
export const app = new Elysia().use(mail).use(await pages()).listen(3000)
```

In production the mailer reads `SMTP_HOST` (required), `SMTP_PORT` (465 by default), `SMTP_USER` and `SMTP_PASS`, and `SMTP_FROM` unless `from` is set. A missing one stops the boot.

## Writing a mail

A mail is a `.kay` component. Clients drop stylesheets, so the components kayjs-mail ships use inline styles, themed through the library settings:

```kay
---
import Button from '@kaynooo/kayjs-mail/button.kay'
import Heading from '@kaynooo/kayjs-mail/heading.kay'
import Layout from '@kaynooo/kayjs-mail/layout.kay'
import Paragraph from '@kaynooo/kayjs-mail/paragraph.kay'

const { name, url } = props<{ name: string, url: string }>()
---
Layout(preheader="Your account is ready")
  Heading Welcome, {name}
  Paragraph Confirm your address to start.
  Button(href={url}) Confirm my address
```

<Callout type="note">

Tailwind classes do nothing in a mail. Style with `style` attributes.

</Callout>

## Sending

`enqueue` renders the mail now and queues it, so a mail server outage never fails the visitor's action. `send` sends before it answers and throws on failure.

```kay
--- server
import { t } from 'kay'
import { mail } from '../mail'
import Welcome from '../mails/welcome.kay'

const newUser = t.Object({
  name: t.String({ maxLength: 100 }),
  email: t.String({ format: 'email', maxLength: 254 }),
})

export const signUp = action(newUser, async ({ name, email }) => {
  await mail.enqueue({
    to: email,
    subject: `Welcome, ${name}`,
    view: Welcome,
    props: { name, url: 'https://example.com/confirm' },
  })
})
---
```

A message also takes `cc`, `bcc`, `replyTo`, `attachments`, or `html` and `text` in place of `view`.

## Testing

Under `bun test`, mails go to the `outbox`. An enqueued mail reaches it once `site.runJobs()` ran:

```ts
import { outbox } from '@kaynooo/kayjs-mail'
import { testSite } from 'kay/test'

const site = await testSite()

await site.submit(
  signUp,
  { name: 'Ada', email: 'ada@example.com' },
  { from: '/' },
)
await site.runJobs()

expect(outbox.to('ada@example.com')[0]?.subject).toBe('Welcome, Ada')
```

[kayjs-auth](/libraries/kayjs-auth) takes the mailer's `enqueue` as its `email.mailer.send`.

<ReadMore href="/llms/kayjs-mail">Optional mail setup, other transports, attachments, the queue's retry options and the settings are in the full kayjs-mail reference.</ReadMore>
