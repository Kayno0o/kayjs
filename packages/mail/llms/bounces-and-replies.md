# kayjs-mail: Bounces, complaints and replies

A mail address that bounces or reports spam is not mailed again, and a reply to a mail can reach an app function. Both come with the mailer: nothing is declared except the secret of each route you use.

## Common tasks

### Stop mailing a dead address

Point the provider's webhook at `https://<site>/_kay/mail/events/<provider>` and set its secret in the environment. A route whose secret is not set answers 404, so nothing unsigned is ever taken.

| Provider | Route | Secret | Checked by | Suppresses |
| --- | --- | --- | --- | --- |
| Postmark | `/_kay/mail/events/postmark` | `MAIL_EVENTS_POSTMARK=user:password` | HTTP Basic credentials in the webhook URL (Postmark signs nothing) | a `Bounce` of `HardBounce`, `BadEmailAddress` or TypeCode 1, a `SpamComplaint` |
| Mailgun | `/_kay/mail/events/mailgun` | `MAIL_EVENTS_MAILGUN` the webhook signing key | HMAC-SHA256 of timestamp and token, within 5 minutes | `failed` with `severity: permanent`, `complained` |
| SendGrid | `/_kay/mail/events/sendgrid` | `MAIL_EVENTS_SENDGRID` the Event Webhook's public key (base64) | ECDSA over timestamp and raw body, within 5 minutes | `bounce` (not `blocked`), `dropped` for a bounced or spam-reporting address, `spamreport` |
| Resend | `/_kay/mail/events/resend` | `MAIL_EVENTS_RESEND` the `whsec_` secret | Svix HMAC over id, timestamp and body, within 5 minutes | `email.bounced` (permanent), `email.complained` |
| Amazon SES (through SNS) | `/_kay/mail/events/ses` | `MAIL_EVENTS_SES` the ARN of the SNS topic (several, comma separated) | the SNS signature (RSA, version 1 SHA1 or 2 SHA256) over the canonical string, and the `TopicArn` being one of the secret's | a `Bounce` of type `Permanent`, a `Complaint` (`notificationType`, or `eventType` with event publishing) |

- A soft or temporary bounce is ignored: the mail may still arrive.
- SES: publish the bounce and complaint notifications of the identity, or of a configuration set's event destination, to an SNS topic, and subscribe `https://<site>/_kay/mail/events/ses` to it as HTTPS. The route answers the `SubscriptionConfirmation` by visiting its `SubscribeURL`, so the subscription confirms itself once `MAIL_EVENTS_SES` is set; until then the route is 404 and SNS retries. Amazon signs the messages of every topic, so the topic's ARN is the secret: a message of another topic is refused. The signing certificate and the `SubscribeURL` are fetched only from https `sns.<region>.amazonaws.com` (the certificate is kept 24 hours), and a message with another host is refused unread. A complaint lists everyone the original mail went to at the complaining provider, as ISPs hide who complained, so send one mail per recipient to suppress the right address. China regions (`.amazonaws.com.cn`) are not supported. A signed message is not refused for its age, as SNS may retry late, so replaying an old one suppresses an address you lifted again.
- A complaint blocks bulk mail only, a mail carrying `List-Unsubscribe` (a list's, or one sent with `unsubscribe`) or a list's confirmation; a password reset, a sign-in code or any other mail still reaches the address. A bounce blocks every mail. Nothing is declared on a message.
- `mailer({ events: { mailgun: key, ... } })` gives a secret in code instead; the environment is read when a request comes.
- A forged or stale post answers 401 and changes nothing; a body over 1 MB, 413. Answers are plain text.

What a suppression does:

- Later mails to the address (every mail after a bounce, bulk mail after a complaint) are skipped and logged, whatever sends them (`send`, the queue, a list, kayjs-auth's mails): the mail resolves as `{ accepted: [], rejected: [address], response: 'suppressed' }` rather than throwing, so the queue neither retries it nor lists it in `failed()`. With other recipients left the mail goes to them alone. The log names the count and domains, the address itself under `logRecipients`.
- The address leaves every mailing list at once, with its delivery rows, as an unsubscribe does, so a broadcast under way mails it no more.
- It is kept in a `kay_mail_suppressions` table: in the mailer's `suppressionStore` when given, else in the list stores (`listStore`, a list's `store`), else in `data/mail-list.sqlite`, made by the first suppression with that table alone, so a mailer with no list opens no list store. A lookup before it makes no file, and what a list store kept stays in force. The first reason and time stay.
- On several servers with no list, `mailer({ suppressionStore: pgSuppressions(db) })` keeps them in Postgres, `db` as `pgLists` takes it, the table made by the first one; a role that may not create it has the owner run `createMailListTables(db)`. `sqliteSuppressions(path)` names another SQLite file. Any object with `suppress`, `suppressed` and `lift` (`SuppressionStore`) works.
- `mail.suppress(address, reason = 'bounce')`, `mail.unsuppress(address)` and `mail.suppression(address)` (`{ email, reason, source, at }`) do by hand what a webhook does; `mail.erase(address)` lifts it with the rest of a person.
- A subscriber who bounced or complained and signs up again gets no confirmation mail; `mail.unsuppress` once the address is fixed.

### Read delivery reports and replies

`POST /_kay/mail/inbound` takes a raw message, from a mail server piping to `curl --data-binary @-` with `Authorization: Bearer $MAIL_INBOUND_SECRET` (a body labelled as a form is read as the raw message when it has no `email` field), or from a provider's inbound parse: a form field `email` (SendGrid, raw) or `body-mime` (Mailgun), authenticated by the secret as the password of the webhook URL's Basic credentials. Without `MAIL_INBOUND_SECRET` (or `events.inbound`) the route is 404; a message over 5 MB is refused with 413.

- A delivery report (RFC 3464, `multipart/report; report-type=delivery-status`) suppresses each recipient with `Action: failed` and a status of a bad address (`5.1.x`) or a disabled mailbox (`5.2.1`); a full mailbox or a policy block (`5.7.x`) says nothing of the address. Anyone can write to the bounce mailbox, so a report counts only when it returns a mail this app sent (the `Message-ID` kayjs-mail writes carries a tag keyed with the app secret, `KAY_SECRET`; without one no report is believed) to that very address in its `To` or `Cc`. Mails sent before this version, or with a `Message-ID` of your own, and `bcc` recipients are not matched. Point the bounce address (the envelope sender, `Return-Path`) at the same pipe.
- Any other message goes to the mailer's one option, called with the decoded reply:

```ts
export const mail = mailer({
  inbound: async (reply) => {
    // reply.inReplyTo is the Message-ID of the mail it answers
    await db.insert(replies).values({ from: reply.from, subject: reply.subject, text: reply.text })
  },
})
```

- A `Reply` is `{ from, fromName, to, subject, date, messageId, inReplyTo, references, text, html, headers, attachments }`, headers read and bodies decoded (quoted-printable, base64, charsets), `attachments` being `{ filename, contentType, content }`, a `filename` decoded (RFC 2231 `filename*=` and RFC 2047 words) and always a bare file name: a directory part (`/` or `\`; a `:` becomes `_`), a control or direction-override character, or a name of dots alone is dropped, `attachment` standing for what is left of none. The `Message-ID` of every mail kayjs-mail sends is in its `headers` and the outbox, so a reply can be matched to it. Without `inbound` a reply is acknowledged and dropped.
- The function runs for whoever holds the secret: treat the message as untrusted input, the sender's address and the attachments' file names included (a name is bare, but still pick your own storage name rather than trust it).

## Reference

- Types: `EventSecrets`, `Suppression`, `SuppressionReason`, `Reply`, `ReplyAttachment`.
- Not understood yet: Amazon SES (SNS notifications need the signing certificate fetched).
