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

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc` (a project made by `kay new` has it). kay and Elysia are peers. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together. An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

In a kay project, `kay add mail` does the install and the two files below for you.

`src/mail.ts` creates the mailer. `from` is your own address, a visitor's address goes in `replyTo`:

```ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'en' })
```

Listed in `kay.config.ts`, the server uses it to run the queue and, under `kay dev`, serve the outbox at `/_kay/mail`:

```ts
import { mailExtension } from '@kaynooo/kayjs-mail'

export default defineConfig({
  extensions: [
    mailExtension('./src/mail'),
  ],
})
```

The path is the file exporting the mailer as `mail`, relative to the project root. kay imports it only as the server starts, and `kay build --compile` bakes it into the executable.

In production the mailer reads `SMTP_HOST` (required), `SMTP_PORT` (465 by default), `SMTP_USER` and `SMTP_PASS`, and `SMTP_FROM` unless `from` is set. A missing one stops the boot. On a port other than 465 a server not offering STARTTLS is refused, unless `SMTP_INSECURE=true`, for a local Mailpit, which a set `SMTP_PASS` overrides; the error says so, at the first mail and in a warning when the server starts. Each mail sent is logged with its subject and how many recipients it went to at which domains, `mailer({ logRecipients: true })` naming them in full. `MAIL_TO` is where a mail naming no recipient goes, such as a contact form's, and DKIM signing and a rate limit have variables of their own.

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

Besides `Layout`, `Heading`, `Paragraph` and `Button`, it ships `Code`, `Divider`, `Image`, `Link`, and `Row` with `Column` for columns that stack on a phone. They hold in Outlook for Windows, and switch to dark colours in a client's dark mode, derived from the light ones unless `settings.dark` gives them.

<Callout type="note">

Tailwind classes do nothing in a mail. Style with `style` attributes.

</Callout>

## Sending

`enqueue` renders the mail now and queues it, so a mail server outage never fails the visitor's action. `send` sends before it answers and throws on failure, an `Error` with the original value as its `cause` when the transport throws something that is not one. `mail.failed()` lists the queued mails given up on, and `mail.remove({ recipient: 'ada@example.com' })` deletes every queued or failed mail to that address, for a person who asked to be erased.

```kay
--- server
import { s } from 'kay'
import { mail } from '../mail'
import Welcome from '../mails/welcome.kay'

const newUser = s.Object({
  name: s.String({ maxLength: 100 }),
  email: s.String({ format: 'email', maxLength: 254 }),
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

A message also takes `cc`, `bcc`, `replyTo`, `attachments`, `lang`, `unsubscribe` for one-click unsubscribe, or `html` and `text` in place of `view`. Left without `to`, it goes to `MAIL_TO`. Each address holds one mailbox: a visitor's `a@x.com,b@y.com` is refused, and several recipients go as a list. An empty `cc`, `bcc`, `replyTo` or `from`, as a form's blank field gives, is left out; an empty `to` is refused.

## A contact form

`contactForm(mail, options)` gives the arguments of `action` for a contact form, so a site writes no schema, no error mapping and no mail wrapper:

```kay
--- server
import { contactForm } from '@kaynooo/kayjs-mail'
import { s } from 'kay'
import { mail } from '../mail'

export const contact = action(...contactForm(mail, {
  fields: { phone: s.Optional(s.String({ maxLength: 30 })) },
  reach: 'hello@example.com',
}))
---
```

The page shows it with [ContactForm](/ui/contact-form) from kayjs-ui, or with its own `form(action={contact})` and `input(field="name")`, `input(field="email")` and `textarea(field="message")`.

- The action checks a one-line `name`, an `email` and a `message` of at most 5000 characters, then the `fields` you add, whose schemas are yours. It mails them to `to`, or `MAIL_TO` when left out, with the visitor in `replyTo` and the message quoted. `labels` renames a field in the mail, `subject` and `view` replace the subject and the mail's component, which gets `ContactMailProps`.
- A message with more than `maxLinks` links (3 by default) is refused. `rateLimit` allows 30 posts and 5 that went through every 10 minutes, `honeypot` is the `website` field, answered as if it worked, and `minTime` is 3 seconds. `protection` replaces the limits.
- A mailer that is `optional` and not set up answers 503, a mail that fails to send answers 502, each with a worded refusal the form shows; `reach` adds how else to reach the site, `hello@example.com` or a phone number. The refusals read the `mail.contact` messages in the page's language, in English and French, which your own `src/messages` override key by key. They come with `mailExtension`, so a mailer used with `.use(mail)` alone has none. The mail itself is written in the page's language, not the recipient's.
- The schema's own field messages and ContactForm's labels (`mail.contact.errors` and `mail.contact.form`) are in the page's language too, with the same override. `errors: { name, email, message }` replaces the field messages with a text or a function, and ContactForm's label props replace its labels. Without `mailExtension` the field messages and the labels read English.

## Previewing

Under `kay dev`, `/_kay/mail` lists the mails sent, each with its html at desktop or phone width, its text and its size. `/_kay/mail/samples` renders every mail under `src/mails` without sending it, with the props a `.preview.ts` beside it default-exports:

```ts
// src/mails/welcome.preview.ts
import type Welcome from './welcome.kay'

export default {
  name: 'Ada',
  url: 'https://example.com/confirm',
} satisfies Parameters<typeof Welcome>[0]
```

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

`outbox.waitFor(address)` waits for a mail to arrive, and `outbox.links(mail)` gives the links it carries, such as a confirmation link to visit next.

## With kayjs-auth

`authMailer` sends [kayjs-auth](/libraries/kayjs-auth)'s mails (verification, reset, magic links, security notices) through your mailer, themed by your mail settings. It needs `mailExtension` in `kay.config.ts`, as above. A view written from scratch can take its default wording from `authWords(mail)`, which throws for a `mail.kind` kayjs-auth does not send.

```ts
// src/auth.ts
import { createAuth } from '@kaynooo/kayjs-auth'
import { authMailer } from '@kaynooo/kayjs-mail'
import { mail } from './mail'

export const auth = createAuth({
  // ...
  email: { mailer: authMailer(mail.enqueue) },
})
```

## In the dev tool

Under `kay dev`, the dev tool has a Mail tab with nothing to set up. It lists the mails sent to the outbox, newest first. A click on one previews it in place, and Open shows its page.

<ReadMore href="/llms/kayjs-mail">Optional mail setup, other transports, attachments, the queue's retry options and the settings are in the full kayjs-mail reference.</ReadMore>
