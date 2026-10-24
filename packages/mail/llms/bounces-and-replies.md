# kayjs-mail: Bounces, complaints and replies

A mail address that bounces or reports spam is not mailed again, and a reply to a mail can reach an app function. Both come with the mailer: nothing is declared except the secret of each route you use.

## Common tasks

### Stop mailing a dead address

Point the provider's webhook at `https://<site>/_kay/mail/events/<provider>` and set its secret in the environment. A route whose secret is not set answers 404, so nothing unsigned is ever taken.

| Provider | Route | Secret | Checked by | Suppresses |
| --- | --- | --- | --- | --- |
| Postmark | `/_kay/mail/events/postmark` | `MAIL_EVENTS_POSTMARK=user:password` | HTTP Basic credentials in the webhook URL (Postmark signs nothing) | a `Bounce` of `HardBounce`, `BadEmailAddress` or TypeCode 1, a `SpamComplaint` |
| Mailgun | `/_kay/mail/events/mailgun` | `MAIL_EVENTS_MAILGUN` the webhook signing key | HMAC-SHA256 of timestamp and token, within 5 minutes | `failed` with `severity: permanent`, `complained` |
| SendGrid | `/_kay/mail/events/sendgrid` | `MAIL_EVENTS_SENDGRID` the Event Webhook's public key (base64) | ECDSA over timestamp and raw body, within 5 minutes | `bounce` (not `blocked`), `dropped`, `spamreport` |
| Resend | `/_kay/mail/events/resend` | `MAIL_EVENTS_RESEND` the `whsec_` secret | Svix HMAC over id, timestamp and body, within 5 minutes | `email.bounced` (permanent), `email.complained` |

- A soft or temporary bounce is ignored: the mail may still arrive.
- `mailer({ events: { mailgun: key, ... } })` gives a secret in code instead; the environment is read when a request comes.
- A forged or stale post answers 401 and changes nothing; a body over 1 MB, 413. Answers are plain text.

What a suppression does:

- Later mails to the address are skipped and logged, whatever sends them (`send`, the queue, a list, kayjs-auth's mails): the mail resolves as `{ accepted: [], rejected: [address], response: 'suppressed' }` rather than throwing, so the queue neither retries it nor lists it in `failed()`. With other recipients left the mail goes to them alone. The log names the count and domains, the address itself under `logRecipients`.
- The address leaves every mailing list at once, with its delivery rows, as an unsubscribe does, so a broadcast under way mails it no more.
- It is kept in a `kay_mail_suppressions` table beside the lists' (SQLite or Postgres: `mailListTables` lists it; a database from before it gets the table on first use). The first reason and time stay.
- `mail.suppress(address, reason = 'bounce')`, `mail.unsuppress(address)` and `mail.suppression(address)` (`{ email, reason, source, at }`) do by hand what a webhook does; `mail.erase(address)` lifts it with the rest of a person.
- A subscriber who bounced and signs up again gets no confirmation mail (it is skipped like any other); `mail.unsuppress` once the address is fixed.

### Read delivery reports and replies

`POST /_kay/mail/inbound` takes a raw message, from a mail server piping to `curl --data-binary @-` with `Authorization: Bearer $MAIL_INBOUND_SECRET`, or from a provider's inbound parse: a form field `email` (SendGrid, raw) or `body-mime` (Mailgun), authenticated by the secret as the password of the webhook URL's Basic credentials. Without `MAIL_INBOUND_SECRET` (or `events.inbound`) the route is 404; a message over 5 MB is refused with 413.

- A delivery report (RFC 3464, `multipart/report; report-type=delivery-status`) suppresses each recipient with `Action: failed` and a `5.x.x` status. Point the bounce address (the envelope sender, `Return-Path`) at the same pipe.
- Any other message goes to the mailer's one option, called with the decoded reply:

```ts
export const mail = mailer({
  inbound: async (reply) => {
    // reply.inReplyTo is the Message-ID of the mail it answers
    await db.insert(replies).values({ from: reply.from, subject: reply.subject, text: reply.text })
  },
})
```

- A `Reply` is `{ from, fromName, to, subject, date, messageId, inReplyTo, references, text, html, headers, attachments }`, headers read and bodies decoded (quoted-printable, base64, charsets), `attachments` being `{ filename, contentType, content }`. The `Message-ID` of every mail kayjs-mail sends is in its `headers` and the outbox, so a reply can be matched to it. Without `inbound` a reply is acknowledged and dropped.
- The function runs for whoever holds the secret: treat the message as untrusted input, the sender's address included.

## Reference

- Types: `EventSecrets`, `Suppression`, `SuppressionReason`, `Reply`, `ReplyAttachment`.
- Not understood yet: Amazon SES (SNS notifications need the signing certificate fetched).
