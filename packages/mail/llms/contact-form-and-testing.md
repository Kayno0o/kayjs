# kayjs-mail: The contact form, testing, development and kayjs-auth

## Common tasks

### A contact form

`contactForm(mail, options)` gives the arguments of `action` for a contact form, so a site writes no schema, error mapping or mail wrapper; spread into `action(...)`, which kay finds by name:

```kay
--- server
import { contactForm } from '@kaynooo/kayjs-mail'
import { s } from 'kay'
import { mail } from '../mail'

export const contact = action(...contactForm(mail, { fields: { phone: s.Optional(s.String({ maxLength: 30 })) }, reach: 'hello@example.com' }))
---
```

- Pair it with `ContactForm(action={contact})` from kayjs-ui, or a form of your own with `field="name"`, `field="email"`, `field="message"` and one per extra field; `kay check` cannot read the schema through the spread, so it does not run `unbounded-string` on the extras: give them a `maxLength`.
- The action checks a one-line `name` (100 characters), an `email` and a `message` (`maxLength`, 5000 by default), then `fields`, a record of schemas of yours, listed in the mail in order after the email. It sends to `to` or `MAIL_TO`, `replyTo` the visitor, the message quoted. `labels` names an extra field in the mail (its key with a capital by default), `subject` is `(input) => string`, `view` a `.kay` component given `ContactMailProps` (`subject`, `name`, `email`, `message`, `fields`, `origin`).
- More than `maxLinks` links (3) is refused with 422. `protection` replaces the defaults: `rateLimit` 30 posts and 5 that went through every 10 minutes, `minTime` `'3s'`; the honeypot is the `website` field, with `pretend`, which `honeypot: 'nectar'` renames (a name no autofill knows; the form renders it by itself, and `website` is then free as a field of yours).
- `consent: true` adds a required `consent` checkbox for a form collecting personal data: an unticked or missing one is refused with the `mail.contact.errors.consent` message (`errors.consent` replaces it), it is checked by the server and left out of the mail. `ContactForm` draws it for this field only (not for an extra field of yours named `consent`; its `consent` prop forces the box), with a `privacy="/privacy"` link; a form of your own writes `input(field="consent" type="checkbox")`.
- `MailNotConfiguredError` answers 503 and any other send failure 502, as a refusal the form shows through `contact.error()`; the cause is logged, by the mailer for a delivery that failed and by the form for a mail that never got to it (not configured, a view that does not render). `reach` is named in the 503, the 502 and the rate-limit refusal.
- The refusals, subject and mail footer read the `mail.contact` messages, which the package declares in its package.json, so every kay app installing it reads them, `mail()` or not (an Elysia app not run through kay reads English), in the page's language (English and French shipped), overridden key by key in the app's `src/messages`. The mail is written in the page's language, not the recipient's. The schema's field messages (`mail.contact.errors`) and `ContactForm`'s labels (`mail.contact.form`, with `consent` and `privacy`, read when the messages exist, else English) are in the page's language too, English and French shipped. `errors: { name, email, message, consent }` replaces the field messages with a text or a `() => string`, and ContactForm's label props replace its labels.

### Testing

Under `bun test` mails go to the outbox, with no SMTP server to stub:

```ts
import { mailTest } from '@kaynooo/kayjs-mail/test'
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { signUp } from '../src/routes/index.kay'

const site = await testSite()
const mail = mailTest(site)

it('welcomes a new account', async () => {
  await site.submit(signUp, { name: 'Ada', email: 'ada@example.com' }, { from: '/' })
  await site.runJobs()

  expect(mail.to('ada@example.com')[0]?.subject).toBe('Welcome, Ada')
})
```

`mailTest(site)` reads the mails the site sent, from an outbox that is empty at the start of every test, so no test clears it by hand; call it at the top of a file, as `testSite()`. It has `mails`, `last()`, `to(address)`, `find(id)`, `links(mail)`, `link(mail, match)`, `token(mail, match)` and `waitFor(address, { find, timeout })`, which runs the site's queues until the mail is there. The bullets below name the same methods on `outbox`, the process's own, which a test of the dev tool, `watch` or `clear()` reaches for.

- `outbox.mails` lists the mails sent, oldest first, each a `Mail` with `id` and `sentAt`; `last()`, `to(address)` (among `to`, `cc` and `bcc`, any case), `find(id)` and `clear()` read it. It keeps the last 500.
- `outbox.links(mail)` gives the addresses a mail links to, in order, each once, as a confirmation test needs: its html's links, or the URLs its text holds. `await outbox.waitFor(address, { timeout })` resolves with the newest mail to that address once one is there, failing after `timeout`, 5 seconds by default, for a mail a server sends on its own time. `outbox.watch(listener)` calls `listener` with each mail sent from then on, until the function it returns is called.
- A browser test driving `kay dev` from another process, as Playwright does, reads the outbox from `/_kay/mail.json`, served under `kay dev` only, never by a server started with `NODE_ENV=development` some other way: every mail, oldest first, with its html, text and headers, an attachment's bytes in base64 (`encoding: 'base64'`); `?to=<address>` keeps the mails to that address.
- An enqueued mail reaches the outbox once the queue runs: `site.runJobs()` from `kay/test`, or the mailer's `drain()`, which does not wait for a send or enqueue the app left unawaited, as `site.runJobs()` does. Pass the site to wait for it instead: `await outbox.waitFor(address, { site, find, timeout })` runs the site's queues, the jobs they enqueue included, until the newest mail to that address that `find` (a predicate on the mail, optional) accepts is delivered, and fails after `timeout` with the mails the outbox holds. It needs only a `runJobs()`, so `kay/test`'s `testSite()` fits and kayjs-mail does not import kay's test module.
- `outbox.link(mail, match)` gives the first link of a mail whose address holds `match` (a string or a pattern; the first link without one) and `outbox.token(mail, match)` its `token` query parameter, as a confirmation, magic-link or reset test needs; both fail naming the links the mail holds when none matches:

```ts
await site.submit(request, { email }, { from: '/auth/reset-password' })

const token = outbox.token(await outbox.waitFor(email, { site }), '/auth/reset-password')
```

### Development

Under `kay dev`, which sets `NODE_ENV=development`, each mail sent is logged with its subject and kept in the outbox, and `/_kay/mail` lists them, newest first, each with its headers, its size, its html in a sandboxed frame and its text. The list reloads as mails arrive and can be cleared, a mail's html shows at desktop or phone width (`?view=phone`), its size warns past the 102 KB of html Gmail clips at, and it downloads as the `.eml` SMTP would send. Under `kay dev` the outbox is kept in `.kay/mail-outbox.json` for the checkout (written aside and renamed, so a crash never leaves half a file), the last 500, so the mails survive a page refresh and `kay dev` restarting the server for an edit; the Mail tab's Clear button, `/_kay/mail/clear` and `outbox.clear()` empty the file too. `outbox.waitFor` under `kay dev` finds a mail kept from an earlier run as well. Only the server `kay dev` runs reads or writes it: under `bun test`, in production and in a server merely started with `NODE_ENV=development` the outbox stays in memory, so each test run starts empty. The file holds each mail in full, reset links included, and `.kay` stays out of git.

`/_kay/mail/samples` shows the app's mails without sending any: every `.kay` file under `src/mails`, each rendered as the mailer renders it, html at desktop or phone width and text, with the props its `<name>.preview.ts` beside it default-exports, or none without one; a mail that throws shows why. The page reloads when `kay dev` restarts the server for a changed file.

A mail in the outbox and a sample can each be sent for real from its page, to an address typed in its form, over the SMTP the environment names: `MAIL_URL`, and `MAIL_FROM` unless `mailer({ from })` or the site gives the sender, read on the first send. It goes to that address alone, its `cc` and `bcc` dropped, and nothing else leaves the outbox. `MAIL_URL` naming a local mailpit puts it there; a real relay puts it in a real inbox, to see what Gmail or Outlook make of it. Without them the page names the variables missing instead of the form, and a post from another site is refused.

The dev tool's Mail tab has a Send for real switch: turned on with an address typed beside it, every mail sent or queued from then on is also delivered to that one address over the same SMTP, never to its own recipients and with its `cc` and `bcc` dropped, and still lands in the outbox, noted there as delivered to the address or with the SMTP error (a send that cannot reach the server does not throw). The switch and its address are kept in `.kay/mail-delivery.json` for the checkout, so they survive `kay dev` restarting the server, until turned off. Only the server `kay dev` runs reads it, never one with `NODE_ENV=production` or `test`. The tab's bar badge shows it is on from any tab; without the SMTP variables the switch is off and the tab names the ones missing, and a post from another site is refused. The tab also lists the app's templates, the `.kay` files `/_kay/mail/samples` renders, each opening its preview. While the switch is on a slow or unreachable relay delays `send()` by up to the SMTP `timeout` (10 seconds by default) at each step of the connection, since the mail is handed to the relay before it returns; settings that cannot be read are logged once and deliver nothing.

```ts
// src/mails/welcome.preview.ts
import type Welcome from './welcome.kay'

export default { name: 'Ada', url: 'https://example.com/confirm' } satisfies Parameters<typeof Welcome>[0]
```

### Other transports

`transport` takes any `{ send(mail) }` resolving with a `Delivery`, such as a provider's HTTP API. `smtp({ host, port, insecure, user, pass, name, timeout, maxConnections, rateLimit, dkim: { domain, selector, privateKey } })` is the SMTP one, for settings read some other way. `outbox` is a transport too, for a staging server that must never send. In production a custom `transport` still needs a sender, `from` or `SMTP_FROM`, or the boot stops naming both (an `optional` mailer throws `MailNotConfiguredError` per send); development and tests keep `kay@localhost`.

### kayjs-auth

`authMailer(send)` is kayjs-auth's `email.mailer`, rendering its verification, password reset, magic link, code, security, invitation and account-exists mails through the components above, in wording the app overrides line by line, themed by the app's mail settings, rather than kayjs-auth's own html. It needs `mail({ module })` in `kay.config.ts`'s `extensions`, which brings its wording:

```ts
// src/auth.ts
import { createAuth } from '@kaynooo/kayjs-auth'
import { authMailer } from '@kaynooo/kayjs-mail'
import { mail } from './mail'

export const auth = createAuth({
  // ...
  email: { mailer: authMailer(mail.enqueue), links: { /* ... */ } },
})
```

- `authMailer(mail.enqueue)` renders each mail at once and leaves it to the queue, which retries a mail server that is away; `authMailer(mail.send)` sends it at once, before kayjs-auth's call answers for the mails it awaits.
- A mail with a link shows a button, the link written out and the code when it carries one; news of a change to the account shows the link to review it when it carries one. Each ends on how long the link or code works, then on what to do when it was not asked for or not the user. The text part is drawn from the html, as for any view.
- The mail's `locale` becomes its `lang`, its `<html lang>` and the locale its subject and view render `t()` in, so kayjs-auth's `email.locales` must be among the site's. kayjs-auth's `templates` and `translations` options do not reach these mails.

Overriding a line: the wording is kayjs-mail's `mail.auth` messages, in English and French, which the app's `src/messages/<locale>.ts` overrides key by key; a site in another language writes them all in its own file, as `kay check` asks. Each kind (`verify-email`, `reset-password`, `magic-link`, `change-email`, `invitation`, `account-exists`, and the events `new-sign-in`, `sign-in-locked`, `password-changed`, `email-changed`, `two-factor-enabled`, `two-factor-disabled`, `recovery-code-used`, `recovery-codes-regenerated`, `provider-linked`, `provider-unlinked`, `passkey-added`, `passkey-removed`, `token-created`, `signed-out-everywhere`, `account-deleted`, `organization-handed-over`) has a `subject`, a `lead` and an `ending`, and a link's a `button` and `lasts`, how long it works (empty to leave it unsaid); `orPaste`, `yourCode`, `orTypeCode`, `linkWorks`, `codeWorks` and `review` are shared. Placeholders are `{site}`, `{email}`, the address written to, and `{detail}`, the organization, provider, passkey, token or new address the mail is about:

```ts
// src/messages/en.ts
export default defineMessages({
  mail: { auth: { 'reset-password': { lead: 'Forgot your {site} password? It happens.' } } },
})
```

Keeping the layout around the app's own lines: `AuthLink` (a link or a code) and `AuthNotice` (news of a change) are the views `authMailer` ships, taking `mail` and any line as a prop over the default wording (`heading`, `lead`, `button` or `review`, `ending`), and children, which go under the lead. `authWords(mail)` gives the default wording of a mail in the language it renders in, for a view written from scratch; it throws for a `mail.kind` kayjs-auth does not send, so a view reading `kind` as any string checks it first.

Replacing a kind: `views` takes the app's own `.kay` view for any kind, imported once its first mail goes, as a module imported with kay.config.ts cannot load a `.kay` file. The view gets `{ mail }` (the `AuthMail` type): `mail.site`, `mail.to`, `mail.url`, `mail.code`, `mail.detail` and `mail.kind`; its subject stays the messages' `subject`:

```ts
authMailer(mail.enqueue, { views: { 'reset-password': () => import('./mails/auth/reset-password.kay') } })
```

```kay
---
// src/mails/auth/reset-password.kay
import type { AuthMail } from '@kaynooo/kayjs-mail'
import AuthLink from '@kaynooo/kayjs-mail/auth-link.kay'
import Paragraph from '@kaynooo/kayjs-mail/paragraph.kay'

const { mail } = props<{ mail: AuthMail }>()
---
AuthLink(mail={mail} lead={t('resetLead', { site: mail.site })})
  Paragraph {t('neverByMail')}
```

- A kind kayjs-mail does not know, as one a later kayjs-auth adds, goes as kayjs-auth wrote it.
- Once an app uses it, `/_kay/mail/samples` lists every kind as `kayjs-auth/<kind>`, rendered through the app's own views in the site's default language with sample data, and gives the app's view of a kind under `src/mails/auth/<kind>.kay` that sample as its props when it has no `.preview.ts`.

`{ send: mail.enqueue }` also fits `email.mailer` as it is, sending kayjs-auth's own html.

### Dev tool

- `mail()` adds a Mail tab to the dev tool under `kay dev`, with nothing to add in the app: the outbox newest first, each mail previewed in place (its html in a sandboxed frame, or its text) or opened on its page at `/_kay/mail/<id>`, kept up to date as mails are sent, with a Clear button. It reads `/_kay/mail.json`.

## Reference

- In development (`NODE_ENV=development`) and under `bun test` (`NODE_ENV=test`) no mail leaves the process: they go to the outbox, which `kay dev` lists at `/_kay/mail` and a test reads through `outbox`; a server started with `NODE_ENV=development` outside `kay dev` serves no such page. Only another `NODE_ENV`, production, sends over SMTP.
