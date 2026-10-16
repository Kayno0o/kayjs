# kayjs-mail: Setup, environment, writing and sending mails

## Setup

`kay add mail` does the install and the two files below.

kayjs-mail is published as `@kaynooo/kayjs-mail` to `https://git.kaynooo.fr/api/packages/kaynooo/npm/`, beside kay. kay and Elysia are peer dependencies.

```ts
// src/mail.ts
import { mailer } from '@kaynooo/kayjs-mail'

export const mail = mailer({ from: 'Site <contact@example.com>', lang: 'fr' })
```

```ts
// kay.config.ts
import { mailExtension } from '@kaynooo/kayjs-mail'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [mailExtension('./src/mail')] })
```

- `mailExtension(module)` hands the mailer to `pages()`, which uses it before the pages: `src/server.ts` needs no `.use(mail)`. `module` is the path of the file exporting the mailer as `mail`, relative to the project root, and kay imports it, and bakes it into an executable `kay build --compile` makes, only as `pages()` builds the app, never as `kay check`, the editor or `kay build` read the config: a function `async () => (await import('./src/mail')).mail` in its place loads it the same way, and a `.kay` mail imported while the config loads comes before kay compiles any, so `kay.config.ts` never imports `src/mail.ts` itself. It also brings the `mail.auth` messages kayjs-auth's mails are written in and the `mail.contact` ones of `contactForm`, in English and French (see kayjs-auth below): a site in another language fills them in its own messages for `kay check`.
- An Elysia app not served by `pages()` uses it as a plugin instead: `new Elysia().use(mail)`.

- `mailer(options)` returns an Elysia plugin: the server using it, through `mailExtension` or `.use(mail)`, runs the queue `enqueue` fills and, under `kay dev`, serves the outbox page. A script that only sends need not use it.
- Options: `from`, the default sender, `SMTP_FROM` when left out; `fromName`, the name shown beside a bare `SMTP_FROM`; `to`, the recipient of a mail naming none, `MAIL_TO` when left out, read from the environment in development too; `lang`, the `<html lang>` of the mail documents, `en` by default, which a message's own `lang` replaces; `transport`, where mails go in place of the default; `queue`, kay's `QueueOptions` (`attempts`, `backoff`, `store`, `onFailed`...) plus `name`, `mail` by default, which two mailers in one app set apart; `optional`, see Environment; `logRecipients: true` logs each mail's recipients in full rather than their count and domains.

## Environment

In production the mailer reads, as the server boots, through kay's `defineEnv`; `mailExtension` lists them for `kay env`, `SMTP_HOST` and `SMTP_FROM` as required in production, with nothing wired in the app:

| Variable | |
| --- | --- |
| `SMTP_HOST` | required |
| `SMTP_PORT` | `465` by default: TLS from the start; another port upgrades with STARTTLS, and a server not offering it is refused, at the first send and in a boot warning naming `SMTP_INSECURE`, so a stripped STARTTLS never sends a reset link in clear |
| `SMTP_INSECURE` | `true` sends in clear to a server not offering STARTTLS, such as a local Mailpit; a password still never goes in clear |
| `SMTP_USER`, `SMTP_PASS` | both or neither, for a server needing no login |
| `SMTP_RATE_LIMIT` | optional: the most mails a second, for a provider capping the rate |
| `SMTP_DKIM_SELECTOR`, `SMTP_DKIM_PRIVATE_KEY` | both or neither: signs each mail with DKIM, for a relay that does not, the public key published at `<selector>._domainkey.<domain>`; the PEM key's line breaks may be written `\n` to hold it on one line |
| `SMTP_DKIM_DOMAIN` | the domain the signature vouches for, the sender's by default |
| `SMTP_FROM` | required unless `mailer({ from })` gives the sender: `Name <address>` or a bare address |
| `MAIL_TO` | optional: where a mail naming no `to` goes, such as a contact form's, unless `mailer({ to })` gives it; addresses apart by commas, a name holding none |

A missing or refused variable stops the boot, naming each one. `kay build` runs without them and leaves them to the server. The client greets the server with the sender's domain, not the container's hostname, and gives up on a server silent for 10 seconds. It keeps up to 5 connections open while mails keep coming, so a burst reuses them, and closes them a second after the last mail, so a script ends. Development and tests need none of them.

`mailer({ optional: true })` boots without `SMTP_HOST` and `SMTP_FROM` instead, for a site whose mail can wait to be set up: `mail.configured` reads `false`, and `send` and `enqueue` throw `MailNotConfigured`, whose `missing` names the variables, before rendering or queueing anything, so a contact form can catch it and tell the visitor to write or call instead. A mail naming no `to` while the mailer has none, in any environment, throws it naming `MAIL_TO`, alongside the others, so a contact form sends to `MAIL_TO` with nothing to check itself. An app throws it too for a setting of its own, `new MailNotConfigured(['SUPPORT_PHONE'])`.

## Writing a mail

A mail is a `.kay` component like any other, rendered on the server with `renderToString` from `kay/server`, its `await` blocks waited for. kayjs-mail ships the pieces most mails need, each with inline styles:

```kay
---
import Button from '@kaynooo/kayjs-mail/button.kay'
import Heading from '@kaynooo/kayjs-mail/heading.kay'
import Layout from '@kaynooo/kayjs-mail/layout.kay'
import Paragraph from '@kaynooo/kayjs-mail/paragraph.kay'

const { name, url } = props<{ name: string, url: string }>()
---
Layout(preheader="Your account is ready")
  @footer
    | Sent by Example
  Heading Welcome, {name}
  Paragraph Confirm your address to start.
  Button(href={url}) Confirm my address
  Paragraph(muted) Or paste #[a(href={url}) {url}] into your browser.
```

- `Layout` fills the window with the background colour and centres a card; `preheader` is the line clients show beside the subject, hidden in the mail itself; `@footer` sits under the card.
- They hold in Outlook for Windows, which renders mails with Word: the card keeps its width through a table only Outlook reads, and the button stays padded and clickable as a whole. The document carries the head Outlook needs to keep its scale. Outlook is known to try a stack's first font alone and show Times New Roman when Windows lacks it, as with `system-ui` or a web font, so `Layout` gives it the settings' `font` and `mono` cut down to the fonts Windows has; a stack left with none gets Arial, Georgia or Courier New, by its generic family.
- `Heading` (`level` 1, 2 or 3, 1 by default), `Paragraph` (`muted` for the small print), `Button(href)` and `Link(href)` take their text as children; `Link` sits inside a paragraph: `Paragraph Read #[Link(href={url}) the guide].`
- `Code` shows a one-time or verification code, large, spaced and in `mono`, selected whole by one click where the client allows it: `Code {code}`.
- `Divider` is a line across the card.
- `Image(src alt width height)` takes its width in pixels, which Outlook sizes it by; other clients scale it down to a narrow screen. `height` is optional. It leaves off the `loading` and `decoding` kay gives a page's images, which mail clients ignore.
- `Row` lays `Column`s side by side, stacking them on a screen too narrow for them: `Column` takes half the card's width, or `share`, the fraction it takes, `Column(share={1 / 3})`.
- `Fields(fields)` lays out a form's answers as label and value pairs, `fields` a list of `{ label, value?, href? }` (the `Field` type): a long value wraps, its line breaks kept, `href` links it, a `mailto:` or `tel:` say, and a value blank or left out shows `empty`, `-` by default. The text part writes each as `Label: value`, one to a line.
- `Quote(text)` sets a block of text a visitor wrote apart, its line breaks kept in the html and the text part alike.
- Their colours, fonts, radius and width come from the library's settings, which the app replaces in `kay.config.ts` as with any kay library: `settings: { '@kaynooo/kayjs-mail': './src/mail-settings.ts' }`, a module default-exporting `{ ...defaults, accent: '#0047ff' }`, `defaults` and the `Settings` type imported from `@kaynooo/kayjs-mail`.
- Mail clients read no CSS custom properties, so rather than typing the site's palette again, the settings take it from the site's stylesheet: `cssColours(css, name)` takes the stylesheet's text, imported with `with { type: 'text' }`, which works in a server built with `kay build --compile` too, and gives a function turning a custom property into its colour, its first declaration in the stylesheet, `var()`s and their fallbacks followed, as hex, from which the dark colours derive as from any other. A property missing, no colour or seen through stops the boot naming it and the stylesheet, `name`, else `the stylesheet`. `cssColours(new URL('./styles/global.css', import.meta.url))` reads the file instead, as the server boots, which a compiled server, carrying no source file, cannot.

```ts
// src/mail-settings.ts
import type { Settings } from '@kaynooo/kayjs-mail'
import { cssColours, defaults } from '@kaynooo/kayjs-mail'
import stylesheet from './styles/global.css' with { type: 'text' }

const colour = cssColours(stylesheet, 'styles/global.css')

export default { ...defaults, text: colour('--color-ink'), surface: colour('--color-paper'), accent: colour('--color-wine') } satisfies Settings
```
- In a client's dark mode, Apple Mail and Outlook.com among them, `Layout` and the components switch to dark colours: `settings.dark` gives any of `text`, `muted`, `background`, `surface`, `border`, `accent` and `onAccent`, and each left out is derived from its light colour, lightness turned over and the accent lightened until it reads on the card; only hex colours are derived, another is kept as it is. `darkPalette(settings)` gives the colours a mail would switch to. The rules sit in a `<style>` the document moves into its head, beside `color-scheme` metas saying `light dark`; a mail without them declares `light` alone, so no client inverts part of it. The Gmail apps apply their own dark mode whatever the mail says.
- A component's markup is wrapped in a whole html document, with the charset, the viewport and the subject as its title; markup that already starts with `<html>` or a doctype is kept as it is.

A contact form's mail, the visitor's answers listed and their message quoted:

```kay
---
import Button from '@kaynooo/kayjs-mail/button.kay'
import Fields from '@kaynooo/kayjs-mail/fields.kay'
import Heading from '@kaynooo/kayjs-mail/heading.kay'
import Layout from '@kaynooo/kayjs-mail/layout.kay'
import Quote from '@kaynooo/kayjs-mail/quote.kay'

const { name, email, phone, topic, message } = props<{ name: string, email: string, phone?: string, topic: string, message: string }>()

const fields = [
  { label: 'Name', value: name },
  { label: 'Email', value: email, href: `mailto:${email}` },
  { label: 'Phone', value: phone, href: phone && `tel:${phone.replaceAll(' ', '')}` },
]
---
Layout(preheader={message.slice(0, 120)})
  @footer
    | Sent from the contact form. Replying to this mail writes to {name}.
  Heading {topic}
  Fields(fields={fields} empty="not given")
  Quote(text={message})
  Button(href={`mailto:${email}?subject=${encodeURIComponent(`Re: ${topic}`)}`}) Reply to {name}
```

It goes out with `replyTo: { name, address: email }`, so replying reaches the visitor, and `from` stays the site's own.

## Sending

```kay
--- server
import { s } from 'kay'
import { mail } from '../mail'
import Welcome from '../mails/welcome.kay'

export const signUp = action(s.Object({ name: s.String({ maxLength: 100 }), email: s.String({ format: 'email', maxLength: 254 }) }), async ({ name, email }) => {
  await mail.enqueue({ to: email, subject: `Welcome, ${name}`, view: Welcome, props: { name, url: 'https://example.com/confirm' } })
})
---
```

- A message takes `to` (the mailer's `to` or `MAIL_TO` when left out), `cc` and `bcc` (an address or a list), `replyTo`, `from`, `subject`, `lang`, `headers`, `attachments` (`{ filename, content, contentType?, cid? }`, `content` a string or bytes) and `unsubscribe`, and its content: `view` and `props` for a component (`props` left out when it takes none required), `html` for markup made elsewhere, or `text` alone. Each address, a string or `{ name, address }`, holds one mailbox: one holding several (`a@x.com,b@y.com`, a `;` or a group) or a line break is refused before rendering, so an address a visitor typed cannot relay the mail to others; several recipients go as a list. An empty `cc`, `bcc`, `replyTo` or `from`, as a form's blank field gives, is left out; an empty `to` is refused.
- A message's `lang` is its `<html lang>` and the locale its component renders in, so `t()` and the formatters from `kay/i18n` read the recipient's language: one of the site's locales, `renderToString` refusing another. Without it the component renders in the site's default locale, or the request's while one runs.
- `unsubscribe` offers one-click unsubscribe (RFC 8058), which Gmail and Yahoo require of bulk senders: an https URL that unsubscribes the recipient when it receives a POST, or `{ url, address }` to offer an address to write to as well. It is written as the `List-Unsubscribe` and `List-Unsubscribe-Post` headers; a URL that is not https is refused.
- An address is `'Name <address>'`, a bare address, or `{ name, address }`, which needs no quoting of a name holding a comma.
- Every mail with html goes out with a text part too: the one `text` gives, else one written from the html, links followed by their address, list items dashed, table rows one to a line and a row header written `Label: value`, what the html hides, such as the preheader, left out. `htmlToText(html)` is exported.
- `send(message)` renders and sends now, resolving with `{ messageId, accepted, rejected, response }`. Each mail sent, from `send` or the queue, logs one line naming its subject, how many recipients the server took and their domains (`sent to 2 recipients at example.com`), and its answer, so an app logs nothing of its own. These lines go where the app's `log` setting sends kay's, as text headed `kayjs-mail:`, as JSON with `from: 'kayjs-mail'` or to the app's function, under the request being answered. A mail the server takes for some recipients and refuses for others is sent all the same, and logged counting those refused: it is not retried, which would send it again to those who have it. A send that fails logs the mail and the reason before it throws. `enqueue(message, { delay })` renders now and queues it, resolving with the job's id; a failed send is retried as kay's queues retry, 5 attempts by default, each wait twice the last from 10 seconds, and a mail given up after its last attempt is logged naming it and the reason, then handed to `queue.onFailed` if given. `render(message)` gives the rendered `Mail` without sending it. `drain()` sends every queued mail due, here and now, for a script. `failed()` lists the mails given up on, with why, and `remove(id)`, `remove({ recipient })` or `remove(match)` deletes queued and failed mails, a person's to, cc or bcc once they asked to be erased, resolving with how many went.
