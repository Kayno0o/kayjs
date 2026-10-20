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

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay and Elysia are peers. kayjs-mail is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

In a kay project, `kay add mail` does the install, writes `src/mail.ts` with a bare `mailer()` that reads SMTP from the environment, and lists `mailExtension('./src/mail')` in `kay.config.ts`. Set `from` and `lang` there as below.

`src/mail.ts` creates the mailer. `from` is your own address. A visitor's address goes in `replyTo`.

```ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'en' })
```

List it in `kay.config.ts`. The server then runs the queue and, under `kay dev`, serves the outbox at `/_kay/mail`.

```ts
import { mailExtension } from '@kaynooo/kayjs-mail'

export default defineConfig({
  extensions: [
    mailExtension('./src/mail'),
  ],
})
```

The path is the file exporting the mailer as `mail`, relative to the project root. kay imports it only as the server starts, and `kay build --compile` bakes it into the executable.

## Production settings

In production the mailer reads its settings from the environment. `SMTP_HOST` is required, and so is `SMTP_FROM` unless `from` is set. A missing required one stops the boot. `kay env` lists them with no wiring.

| Variable | Use |
| --- | --- |
| `SMTP_HOST` | The server to send through. Required. |
| `SMTP_PORT` | Optional, 465 by default. |
| `SMTP_USER`, `SMTP_PASS` | Optional, both or neither, for a server needing no login. |
| `SMTP_RATE_LIMIT` | Optional. The most mails sent a second, for a provider capping the rate. |
| `SMTP_DKIM_SELECTOR`, `SMTP_DKIM_PRIVATE_KEY` | Optional, both or neither. Sign each mail with DKIM, for a relay that does not. The PEM key's line breaks may be written `\n`. |
| `SMTP_DKIM_DOMAIN` | Optional. The domain the signature vouches for, the sender's by default. |
| `SMTP_FROM` | The sender, unless `from` is set. |
| `SMTP_INSECURE` | Optional. `true` sends in clear to a server without STARTTLS, such as a local Mailpit. |
| `MAIL_TO` | Optional. Where a mail naming no recipient goes, such as a contact form's. |

On a port other than 465 a server not offering STARTTLS is refused, at the first mail and in a warning when the server starts. Set `SMTP_INSECURE=true` for a local Mailpit. A set `SMTP_PASS` overrides it, so a password never goes in clear.

Each mail sent is logged with how many recipients it went to at which domains, and not its subject, which can hold a visitor's name. Set `mailer({ logSubjects: true })` to log it, and `mailer({ logRecipients: true })` to name the recipients in full.

What the environment has no variable for goes in `mailer({ smtp })`, merged over the SMTP it builds: `name` (the name the client greets the server with, the sender's domain by default), `timeout` (seconds or a string such as `'30s'`, 10 seconds by default), `maxConnections` (5 by default) and `rateLimit` (the most mails a second, unlimited by default). An option left out keeps the default.

A name, a timeout or a count that cannot be used stops the boot. `smtp` cannot go with a `transport`, which replaces the SMTP: give them to `smtp()` instead.

```ts
export const mail = mailer({ smtp: { timeout: '30s', maxConnections: 2 } })
```

<ReadMore href="/llms/kayjs-mail-writing-and-sending">Every variable, DKIM signing, the rate limit and a mailer that boots without SMTP set up.</ReadMore>

## Writing a mail

A mail is a `.kay` component. Clients drop stylesheets, so the components kayjs-mail ships use inline styles, themed through the library settings.

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

`Layout` shows its `@header` above the card, a logo say. To put the same logo on every mail, the built-in auth and contact ones included, set `logo` in the settings instead: `{ ...defaults, logo: { src: 'https://example.com/logo.png', alt: 'Example', width: 120 } }`, with an optional `height` and `href`.

A `@header` replaces it for one mail, and an empty one shows nothing. The text part writes the logo's `alt`.

It also ships `Code`, `Divider`, `Fields`, `Image`, `Link`, `Quote`, and `Row` with `Column` for columns that stack on a phone. `Fields` lays out a form's answers as label and value pairs, and `Quote` sets a visitor's message apart. They hold in Outlook for Windows.

Mail clients read no CSS custom properties, so the settings need real colours. To take them from the site's stylesheet instead of typing them again, use `cssColours`. It gives a function that turns a custom property into its colour, as hex, following any `var()`.

```ts
import { cssColours, defaults } from '@kaynooo/kayjs-mail'
import stylesheet from './styles/global.css' with { type: 'text' }

const colour = cssColours(stylesheet, 'styles/global.css')

export default { ...defaults, text: colour('--color-ink'), accent: colour('--color-wine') }
```

Import the stylesheet's text as above, which also works in an executable. A URL, `new URL('./styles/global.css', import.meta.url)`, reads the file as the server boots, and an executable has no such file. A property that is missing, or that is no opaque colour, stops the boot and names it.

### Dark mode

In a client's dark mode, such as Apple Mail's or Outlook.com's, the components switch to dark colours. Each is derived from its light colour, with the lightness turned over and the accent lightened until it reads on the card.

Set `dark` in the settings to choose any of them. A colour you leave out is still derived.

```ts
// src/mail-settings.ts
import type { Settings } from '@kaynooo/kayjs-mail'
import { defaults } from '@kaynooo/kayjs-mail'

export default { ...defaults, accent: '#0047ff', dark: { background: '#101014', accent: '#7aa2ff' } } satisfies Settings
```

`dark` takes `text`, `muted`, `background`, `surface`, `border`, `accent` and `onAccent`. Only hex colours are derived. `darkPalette(settings)` gives the colours a mail would switch to. The Gmail apps apply their own dark mode whatever the mail says.

<Callout type="note">

Tailwind classes do nothing in a mail. Style with `style` attributes.

</Callout>

## Sending

Use `enqueue` in an action. It renders the mail now and queues it, so a mail server outage never fails the visitor's action.

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

`send` sends before it answers and throws on failure. Use it where you need to know the mail went out.

A message also takes `cc`, `bcc`, `replyTo`, `attachments`, `lang` and `unsubscribe` for one-click unsubscribe. Give `html` and `text` in place of `view` to skip the component. Left without `to`, a message goes to `MAIL_TO`.

Each address holds one mailbox. A visitor's `a@x.com,b@y.com` is refused, and several recipients go as a list. An empty `cc`, `bcc`, `replyTo` or `from`, as a form's blank field gives, is left out. An empty `to` is refused.

To list the queued mails given up on, call `mail.failed()`.

A mail given up is kept 7 days, and its body, links, headers and attachments are dropped at once, so a reset link does not stay in the job store.

Its recipients, subject and the server's error stay, the error as it came: a refusal may quote a URL. Set `queue: { keepFailed: '30d' }` to keep it longer, or `redact` to keep something else. `onFailed` still gets the whole mail.

To erase a person, call `mail.remove({ recipient: 'ada@example.com' })`, which deletes every queued or failed mail to that address.

### Unsubscribe links

Gmail and Yahoo require one-click unsubscribe from bulk senders. `unsubscribe` takes an https URL that unsubscribes the recipient when it gets a POST.

```ts
await mail.enqueue({
  to: email,
  subject: 'This week',
  view: Digest,
  unsubscribe: 'https://example.com/unsubscribe?u=abc',
})
```

It is written as the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Pass `{ url, address }` to offer an address to write to as well. A URL that is not https is refused.

### Attachments

An attachment is `{ filename, content }`, with `content` a string or bytes. Set `contentType` when the file name does not say it.

A `cid` lets the mail's html show the file inline.

```ts
await mail.enqueue({
  to: email,
  subject: 'Your invoice',
  html: '<p>Attached.</p><img src="cid:logo" alt="Logo">',
  attachments: [
    { filename: 'invoice.pdf', content: await Bun.file('invoice.pdf').bytes() },
    { filename: 'logo.png', content: await Bun.file('logo.png').bytes(), cid: 'logo' },
  ],
})
```

### The recipient's language

A message's `lang`, else the mailer's, is the `<html lang>` of the mail and the locale its component renders in. `t()` and the formatters from `kay/i18n` then read the recipient's language, not the site's.

```ts
await mail.enqueue({ to: user.email, subject: 'Bienvenue', view: Welcome, props: { name }, lang: user.locale })
```

`lang` must be one of the site's locales. Without one on the message or the mailer, the component renders in the site's default locale, or the request's, and the `<html lang>` says that locale.

### Plain text

Every mail with html also goes out with a text part. Give `text` to write it yourself. Otherwise it is made from the html, with links followed by their address.

`htmlToText(html)` does the same conversion on its own.

### Mails given up

A failed send is retried, 5 times by default, each wait twice the last. A mail given up after its last attempt is logged. `queue.onFailed` is called with it as well, to alert someone.

```ts
export const mail = mailer({
  from: 'Site <contact@example.com>',
  queue: { onFailed: async (mail, error) => reportError(error) },
})
```

### Other transports

By default mails go over SMTP, or to the outbox in development. `transport` takes any `{ send(mail) }` that resolves with a delivery, such as a provider's HTTP API.

```ts
export const mail = mailer({
  from: 'Site <contact@example.com>',
  transport: {
    async send(mail) {
      const response = await fetch('https://api.example.com/send', { method: 'POST', body: JSON.stringify(mail) })

      return { messageId: await response.text(), accepted: [], rejected: [] }
    },
  },
})
```

In production a mailer with a custom `transport` still needs a sender, `from` or `SMTP_FROM`, or the boot stops naming both. Development and tests keep sending from `kay@localhost`.

`smtp({ host, port, user, pass })` is the SMTP transport, for settings read some other way. It takes the options of `mailer({ smtp })` as well as `insecure` and `dkim: { domain, selector, privateKey }`, which signs each mail for a relay that does not. The private key is PEM, and the public key is published at `<selector>._domainkey.<domain>`. `outbox` is a transport too, for a staging server that must never send.

## A contact form

`contactForm(mail, options)` gives the arguments of `action` for a contact form. A site writes no schema, no error mapping and no mail wrapper.

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

The action checks a one-line `name`, an `email` and a `message` of at most 5000 characters, then the `fields` you add, whose schemas are yours. It mails them to `to`, or `MAIL_TO` when left out, with the visitor in `replyTo` and the message quoted.

Use `labels` to rename a field in the mail. Use `subject` and `view` to replace the subject and the mail's component, which gets `ContactMailProps`.

### Spam protection

A message with more than `maxLinks` links (3 by default) is refused. `rateLimit` allows 30 posts and 5 that went through every 10 minutes. `honeypot` is the `website` field, answered as if it worked, and `minTime` is 3 seconds. Set `protection` to replace the limits.

Set `honeypot: 'nectar'` to name the honeypot field yourself, under a name no browser or password manager autofills, so a person is never refused. The form renders it by itself, and `website` becomes free to be a field of yours.

### Consent

A form collecting personal data often needs a consent checkbox. Set `consent: true` and the action requires a ticked `consent` field: an unticked one is refused with the `mail.contact.errors.consent` message, and the field is checked but never put in the mail.

[ContactForm](/ui/contact-form) draws the checkbox for this field only, not for an extra field of your own named `consent`, and links your privacy page when you give it `privacy="/privacy"`. A form of your own writes `input(field="consent" type="checkbox")`.

### Refusals and wording

A mailer that is `optional` and not set up answers 503. A mail that fails to send answers 502. Each comes with a refusal the form shows, and `reach` adds how else to reach the site, such as `hello@example.com` or a phone number.

The refusals read the `mail.contact` messages in the page's language, in English and French. Your own `src/messages` override them key by key. They come with the package, so a kay app that installs kayjs-mail reads them with or without `mailExtension`; a plain Elysia app with `.use(mail)` reads English. The mail itself is written in the page's language, not the recipient's.

The schema's field messages (`mail.contact.errors`) and ContactForm's labels (`mail.contact.form`) follow the page's language too, with the same override. Set `errors: { name, email, message, consent }` to replace the field messages with a text or a function. ContactForm's label props replace its labels.

## Previewing

Under `kay dev`, `/_kay/mail` lists the mails sent, each with its html at desktop or phone width, its text and its size.

`/_kay/mail/samples` renders every mail under `src/mails` without sending it. It takes the props a `.preview.ts` beside the mail default-exports.

The Mail tab of the dev tool lists the same mails under Templates, each opening its preview.

### Sending for real

A mail's page and a sample's page each have a form that sends that one mail for real. It goes over the SMTP your environment names, to the address you type, and nowhere else. A local Mailpit works, and so does a real relay when you want to see the mail in Gmail or Outlook.

To get every mail that way, turn on Send for real in the Mail tab and type an address. From then on each mail your app sends is delivered to that address alone, never to the person it was written for, with its `cc` and `bcc` dropped. The mail still lands in the outbox, marked as delivered or with the SMTP error.

The switch is kept in `.kay` for your checkout, so it stays on when `kay dev` restarts the server. It works under `kay dev` only, never in production or in tests. Without `SMTP_HOST` and a sender, the tab names what is missing and the switch stays off.

While the switch is on, a relay that is slow or cannot be reached holds up `send()` for up to the SMTP `timeout`, 10 seconds by default, at each step of the connection. The mail is handed to the relay before `send()` returns.

```ts
// src/mails/welcome.preview.ts
import type Welcome from './welcome.kay'

export default {
  name: 'Ada',
  url: 'https://example.com/confirm',
} satisfies Parameters<typeof Welcome>[0]
```

## Testing

Under `bun test`, mails go to the `outbox`. An enqueued mail reaches it once `site.runJobs()` ran.

```ts
import { outbox } from '@kaynooo/kayjs-mail'
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { signUp } from '../src/routes/index.kay'

const site = await testSite()

it('welcomes a new account', async () => {
  await site.submit(signUp, { name: 'Ada', email: 'ada@example.com' }, { from: '/' })
  await site.runJobs()

  expect(outbox.to('ada@example.com')[0]?.subject).toBe('Welcome, Ada')
})
```

`outbox.waitFor(address)` waits for a mail to arrive, and `outbox.links(mail)` gives the links it carries, such as a confirmation link to visit next. `outbox.waitFor(address, { site, find })` runs the test site's queues until the mail is delivered, for a mail an action enqueues, and `outbox.token(mail, path)` reads the token of the link that opens `path`. See [Waiting for a mail](/guides/testing#waiting-for-a-mail).

## With kayjs-auth

`authMailer` sends [kayjs-auth](/libraries/kayjs-auth)'s mails through your mailer, themed by your mail settings. Those are verification, reset, magic links and security notices. It needs `mailExtension` in `kay.config.ts`, as above.

A view written from scratch can take its default wording from `authWords(mail)`. It throws for a `mail.kind` kayjs-auth does not send.

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

The mails are kept in `.kay` for your checkout, the last 500, so they are still there after you refresh the page and after `kay dev` restarts the server for an edit. Clear in the tab empties the list and the file. Under `bun test` and in production the outbox stays in memory, so each test run starts empty. The file holds each mail in full, reset links included, so keep `.kay` out of git.

<ReadMore href="/llms/kayjs-mail-writing-and-sending">Every message field, the queue's retry options, the settings and the full contact form are in the kayjs-mail reference.</ReadMore>
