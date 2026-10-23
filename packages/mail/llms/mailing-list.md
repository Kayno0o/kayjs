# kayjs-mail: A mailing list

## Common tasks

### Let visitors subscribe

`mail.list()` is the site's mailing list, kept in kay's own store with nothing to declare: `data/mail-list.sqlite` (in memory under `bun test`), created by the first query, so building or checking an app makes no file. `.form()` gives the arguments of `action`, as `contactForm` does:

```kay
--- server
import { mail } from '../mail'
import SubscribeForm from '@kaynooo/kayjs-mail/subscribe-form.kay'

export const subscribe = action(...mail.list().form())
---
SubscribeForm(action={subscribe})
```

- A post mails the address a confirmation link (valid 3 days) and lists it only once its page's button is pressed: double opt-in. Opening the link (a mail scanner or prefetch does) shows a page with one button and lists no one; the button's POST confirms. The answer is the same for a new, a pending, a confirmed or an unknown address, and a confirmed one is mailed nothing. The confirmation mail is rendered for every address but queued off the response path, so a listed and a new address answer in the same steps; a queue failure is logged, not shown.
- `SubscribeForm` from `@kaynooo/kayjs-ui/subscribe-form.kay` is the themed one (a FormField tying the refusal to the input); kayjs-mail's own `SubscribeForm` is unstyled markup with `kmail-subscribe*` classes, the honeypot and a notice line saying what the address is used for; a form of your own is `form(action={subscribe})` with `input(field="email")` and, to keep the proof below, a hidden `wording` field. Its props are `label`, `submitLabel`, `sentLabel`, `privacy` (the policy page, linked after the notice), `noticeText` (replaces the stock notice: say who writes, what and how often), `privacyLabel` and `wordingId` (names your notice's version).
- What is kept as the proof of consent: the confirmation date, the `source` (the path of the page the form was on, from the referrer, without its query) and the `wording` (the `wordingId` the form posted; the stock notice is recorded as `mail.list.form.notice:<digest of its text>` and a replaced one as `custom`). `list.subscribers()` returns them with each address; an unsubscribe deletes the row with them.
- Protection: the action's `rateLimit` (10 posts every 10 minutes, per IP), `minTime` 2 seconds and a `website` honeypot, replaced by `list(name, { protection, honeypot })`; and 3 confirmation mails an hour per address, then the post still answers the same and mails nothing, so the form cannot mail-bomb anyone.
- Addresses are stored once, normalised: Unicode NFC, lower case, domain in punycode; a `+tag` stays part of it. Anything that is not one plain address (second `@`, comma list, name with angle brackets, line break, IP domain) is refused with the field's message.
- The links are signed with the app secret (`KAY_SECRET`, one derived for the checkout in development and tests; in production without it the first list throws), never hold an address and cannot be used for each other. A forged, expired, truncated, unknown or already used link answers one "this link does not work" page; a second click on a confirmation answers like the first. A pending address nobody confirmed is forgotten after 7 days, and a broadcast finished 30 days ago with its deliveries: a sweep runs when a SQLite file opens, 10 seconds after the server boots and every hour, so it needs no new subscription and a subscribe post never takes the write lock for it. A `ListStore` of your own implements `sweep(now?)` for it.

### Send to the list

```ts
const { id, recipients } = await mail.list().send({ subject: 'Spring news', view: News, props: { issue: 12 } })

await mail.list().status(id) // { done, sent, failed, retrying, unsure, waiting }
```

- `send` takes a message as `mail.send` does, without recipients and attachments. It is rendered once, stored, and queued in the queue `<mail queue>-list` of the mailer (`mail-list`), which the server using the mailer runs.
- Every mail carries the subscriber's own signed unsubscribe link in a footer (in the subscriber's language) and the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers of RFC 8058.
- `pace: { batch: 20, every: '1m' }` in `mail.list(name, options)` mails a batch, then waits: 1,200 an hour by default. `MAIL_RATE_LIMIT` still caps the SMTP connection.
- Each recipient is claimed in the file before its mail goes, so a restart, a deploy or a crash of the process never mails anyone twice (a power cut can lose the last claims, and a transport that fails after the server took the mail may be retried). A mail the transport refuses is tried 3 times then marked `failed`; a process that dies inside the send leaves that one recipient `unsure`: not mailed again, as it may have left. Only subscribers confirmed before the broadcast get it; one who unsubscribed or was erased meanwhile is skipped. A broadcast and its rows are dropped 30 days after it finished.
- `test(message, address)` sends one mail now to an address (an editor's), subject prefixed `[Test]`, without a broadcast; its unsubscribe link does nothing.
- `preview(message)` renders what a send would mail, with the footer, and answers `{ subject, html, text }` without sending or queueing anything; kayjs-cms shows it before an editor sends an entry.

### Unsubscribe, count and erase

- The unsubscribe link opens a page asking to confirm, so a mail scanner opening links unsubscribes no one; its button, and a POST with `List-Unsubscribe=One-Click` (what Gmail and Yahoo send), unsubscribe at once with no sign-in, and a second one answers the same. The row is deleted: no address is kept.
- `list.count()`, `list.subscribers()` (confirmed, `{ email, confirmedAt, source, wording }`) and `list.unsubscribe(address)`.
- `mail.erase(address)` takes the address off every list of the mailer, with its delivery rows, and removes the mails queued for it; resolves with how many went. Call it where you erase a person (kay's privacy guide); kayjs-auth's `deleteAccount` and `deleteUser` call it for you. `mail.subscriptions(address)` resolves with what the address is on, `{ list, status, askedAt, confirmedAt }` each, pending rows included.

## Reference

- `mail.list(name = 'default', options)` is made on its first call and the same after; a name is letters, digits, dashes and underscores, 40 at most. Several lists share a file, `file` names another.
- `options`: `file`, `store`, `pace`, `view` (the confirmation mail's `.kay` component, given `{ url, site, list, privacy }`), `protection`, `honeypot`, `title` (what the confirmation mail calls the list, its name by default; none for `default`) and `privacy` (a path or URL, linked in the confirmation mail). The confirmation mail names the site and the list, says each mail carries an unsubscribe link, and links the policy.
- The routes `GET` and `POST /_kay/mail/list/confirm`, `GET` and `POST /_kay/mail/list/unsubscribe` (query `token`) are served by the mailer, at the site's origin, whatever the `base`; the pages are worded in the subscriber's language (`mail.list.*` messages, English and French shipped) and sent `no-store`. A valid link whose list has no store in this process yet answers 503 with `retry-after: 60` and a "try again later" page (`mail.list.page.later`), never as done or as broken.
- Tables: `kay_mail_subscribers`, `kay_mail_broadcasts`, `kay_mail_deliveries`. Replicas on several machines need the SQLite file shared, or Postgres:

```ts
import { mailer, pgLists } from '@kaynooo/kayjs-mail'

export const mail = mailer({ listStore: pgLists(db) }) // db: a Bun SQL, a pg-orm Database or a connection URL, as pgData takes
```

- `listStore` on the mailer is where its lists live unless one names `store` or `file`, and where a link of a list this process has not declared yet looks and `mail.erase` reaches; `mail.list(name, { store })` sets one list's alone. It keeps the same three tables in Postgres, created on first use; a role that may not create tables has the owner run `await createMailListTables(db)` and lists `mailListTables` in pg-orm's `ignoreTables`. Give every list the one `pgLists(db)`. Claiming a delivery, unsubscribing and `mail.erase` act the same on both stores. Without `listStore`, a link of an undeclared list finds only the default SQLite file, so a store given per list is declared before its links are served (503 until then); a second `mail.list(name, { store })` naming another store or file than the list was made with throws. Moving a site from SQLite to Postgres copies the three tables over, or old links answer as broken. A confirmation mail is queued just after the answer, so a process stopping in between loses it and the visitor asks again.
