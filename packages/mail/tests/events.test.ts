import type { Action } from 'kay'
import type { ListStore } from '../src/list-store'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { scratchDir, testSite } from 'kay/test'
import { createLists } from '../src/list'
import { openLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'
import { sqliteSuppressions } from '../src/suppressions'
import { logged } from './fixture/tests/logged'
import { untilHolds } from './until'

const site = await testSite({ root: 'tests/fixture' })
const { mail, replies } = await import(`${import.meta.dir}/fixture/src/mail`) as typeof import('./fixture/src/mail')

let counter = 0
const fresh = (): string => `gone${++counter}-${Math.random().toString(36).slice(2, 8)}@example.com`
const now = (): number => Math.floor(Date.now() / 1000)

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const SENDGRID_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const SVIX_SECRET = `whsec_${Buffer.from('a-test-secret-of-some-length').toString('base64')}`
const INBOUND = 'inbound-test-secret'

beforeAll(() => {
  process.env.MAIL_EVENTS_POSTMARK = 'hook:s3cret'
  process.env.MAIL_EVENTS_MAILGUN = 'mailgun-signing-key'
  process.env.MAIL_EVENTS_SENDGRID = SENDGRID_KEY
  process.env.MAIL_EVENTS_RESEND = SVIX_SECRET
  process.env.MAIL_INBOUND_SECRET = INBOUND
})

const post = async (path: string, body: BodyInit, headers: Record<string, string> = {}) => site.fetch(path, { method: 'POST', body, headers })

const postmarkAuth = { authorization: `Basic ${Buffer.from('hook:s3cret').toString('base64')}` }
const postmarkBounce = (email: string, extra: object = {}) => JSON.stringify({ RecordType: 'Bounce', MessageStream: 'outbound', Type: 'HardBounce', TypeCode: 1, Name: 'Hard bounce', Email: email, From: 'hello@fixture.test', Inactive: true, CanActivate: false, ...extra })

function mailgunBody(event: object, key = 'mailgun-signing-key', timestamp = String(now())): string {
  const token = 'e0b5477167110d68991efc6b9f89f0a11066af27834600e123'

  return JSON.stringify({ 'signature': { timestamp, token, signature: createHmac('sha256', key).update(timestamp + token).digest('hex') }, 'event-data': event })
}

async function sendgridPost(events: object[], timestamp = String(now()), key = privateKey) {
  const body = JSON.stringify(events)
  const signature = sign('sha256', Buffer.from(timestamp + body), key).toString('base64')

  return post('/_kay/mail/events/sendgrid', body, { 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': timestamp })
}

async function resendPost(event: object, { secret = SVIX_SECRET, timestamp = String(now()) } = {}) {
  const body = JSON.stringify(event)
  const id = 'msg_2Lh9KRb0pzN3LePPocbbe9aWJUo'
  const signature = createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')

  return post('/_kay/mail/events/resend', body, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` })
}

describe('provider webhooks', () => {
  it('postmark: a hard bounce and a spam complaint suppress, a soft bounce does not, a forged post does nothing', async () => {
    const [hard, complaint, soft, forged] = [fresh(), fresh(), fresh(), fresh()]

    expect((await post('/_kay/mail/events/postmark', postmarkBounce(hard), postmarkAuth)).status).toBe(200)
    expect((await post('/_kay/mail/events/postmark', JSON.stringify({ RecordType: 'SpamComplaint', Type: 'SpamComplaint', TypeCode: 100001, Email: complaint }), postmarkAuth)).status).toBe(200)
    expect((await post('/_kay/mail/events/postmark', postmarkBounce(soft, { Type: 'SoftBounce', TypeCode: 4096 }), postmarkAuth)).status).toBe(200)

    expect((await mail.suppression(hard))?.reason).toBe('bounce')
    expect((await mail.suppression(hard))?.source).toBe('postmark')
    expect((await mail.suppression(complaint))?.reason).toBe('complaint')
    expect(await mail.suppression(soft)).toBeUndefined()

    expect((await post('/_kay/mail/events/postmark', postmarkBounce(forged))).status).toBe(401)
    expect((await post('/_kay/mail/events/postmark', postmarkBounce(forged), { authorization: `Basic ${Buffer.from('hook:wrong').toString('base64')}` })).status).toBe(401)
    expect(await mail.suppression(forged)).toBeUndefined()
  })

  it('postmark: a signed body that is no JSON, or names no address, suppresses nothing', async () => {
    expect((await post('/_kay/mail/events/postmark', 'not json', postmarkAuth)).status).toBe(400)
    expect((await post('/_kay/mail/events/postmark', postmarkBounce('a@b@c, d@e.test'), postmarkAuth)).status).toBe(200)
    expect(await mail.suppression('a@b@c, d@e.test')).toBeUndefined()
  })

  it('mailgun: a permanent failure and a complaint suppress, a temporary failure and a forged signature do not', async () => {
    const [failed, complained, temporary, forged, stale] = [fresh(), fresh(), fresh(), fresh(), fresh()]
    const permanent = { 'event': 'failed', 'severity': 'permanent', 'reason': 'bounce', 'delivery-status': { code: 550 } }

    expect((await post('/_kay/mail/events/mailgun', mailgunBody({ ...permanent, recipient: failed }))).status).toBe(200)
    expect((await post('/_kay/mail/events/mailgun', mailgunBody({ event: 'complained', recipient: complained }))).status).toBe(200)
    expect((await post('/_kay/mail/events/mailgun', mailgunBody({ ...permanent, severity: 'temporary', recipient: temporary }))).status).toBe(200)

    expect((await mail.suppression(failed))?.reason).toBe('bounce')
    expect((await mail.suppression(complained))?.reason).toBe('complaint')
    expect(await mail.suppression(temporary)).toBeUndefined()

    expect((await post('/_kay/mail/events/mailgun', mailgunBody({ ...permanent, recipient: forged }, 'another-key'))).status).toBe(401)
    expect((await post('/_kay/mail/events/mailgun', mailgunBody({ ...permanent, recipient: stale }, 'mailgun-signing-key', String(now() - 3600)))).status).toBe(401)
    expect(await mail.suppression(forged)).toBeUndefined()
    expect(await mail.suppression(stale)).toBeUndefined()
  })

  it('sendgrid: a bounce, a drop and a spam report suppress, a blocked one does not, a wrong key or body does nothing', async () => {
    const [bounced, dropped, reported, blocked, forged, tampered, unrelated] = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh(), fresh()]

    expect((await sendgridPost([{ email: bounced, event: 'bounce', type: 'bounce', reason: '500 unknown recipient', status: '5.0.0' }, { email: dropped, event: 'dropped', reason: 'Bounced Address', status: '5.0.0' }, { email: unrelated, event: 'dropped', reason: 'Invalid' }, { email: reported, event: 'spamreport' }, { email: blocked, event: 'bounce', type: 'blocked' }])).status).toBe(200)

    expect((await mail.suppression(bounced))?.reason).toBe('bounce')
    expect((await mail.suppression(dropped))?.reason).toBe('bounce')
    expect((await mail.suppression(reported))?.reason).toBe('complaint')
    expect(await mail.suppression(blocked)).toBeUndefined()
    expect(await mail.suppression(unrelated)).toBeUndefined()

    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey

    expect((await sendgridPost([{ email: forged, event: 'bounce', type: 'bounce' }], String(now()), other)).status).toBe(401)
    expect((await sendgridPost([{ email: forged, event: 'bounce', type: 'bounce' }], String(now() - 3600))).status).toBe(401)

    const body = JSON.stringify([{ email: tampered, event: 'bounce', type: 'bounce' }])
    const timestamp = String(now())
    const signature = sign('sha256', Buffer.from(timestamp + JSON.stringify([{ email: forged, event: 'bounce', type: 'bounce' }])), privateKey).toString('base64')

    expect((await post('/_kay/mail/events/sendgrid', body, { 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': timestamp })).status).toBe(401)
    expect(await mail.suppression(forged)).toBeUndefined()
    expect(await mail.suppression(tampered)).toBeUndefined()
  })

  it('resend: a permanent bounce and a complaint suppress every recipient, a transient bounce and a forged post do not', async () => {
    const [first, second, complained, transient, forged] = [fresh(), fresh(), fresh(), fresh(), fresh()]

    expect((await resendPost({ type: 'email.bounced', created_at: '2026-11-22T23:41:12.126Z', data: { broadcast_id: '8b146471-e88e-4322-86af-016cd36fd216', created_at: '2026-11-22T23:41:11.894Z', email_id: '56761188-7520-42d8-8898-ff6fc54ce618', message_id: '<111-222-333@email.example.com>', from: 'Acme <onboarding@resend.dev>', to: [first, second], subject: 'Sending this example', template_id: '43f68331-0622-4e15-8202-246a0388854b', bounce: { message: 'The recipient\'s email address is on the suppression list because it has a recent history of producing hard bounces.', subType: 'Suppressed', type: 'Permanent' }, tags: { category: 'confirm_email' } } })).status).toBe(200)
    expect((await resendPost({ type: 'email.complained', created_at: '2026-02-22T23:41:12.126Z', data: { broadcast_id: '8b146471-e88e-4322-86af-016cd36fd216', created_at: '2026-02-22T23:41:11.894Z', email_id: '56761188-7520-42d8-8898-ff6fc54ce618', message_id: '<111-222-333@email.example.com>', from: 'Acme <onboarding@resend.dev>', to: [complained], subject: 'Sending this example', template_id: '43f68331-0622-4e15-8202-246a0388854b', tags: { category: 'confirm_email' } } })).status).toBe(200)
    expect((await resendPost({ type: 'email.bounced', data: { to: [transient], bounce: { type: 'Temporary', subType: 'MessageRejected', message: 'The mailbox is full.' } } })).status).toBe(200)

    expect((await mail.suppression(first))?.source).toBe('resend')
    expect((await mail.suppression(second))?.reason).toBe('bounce')
    expect((await mail.suppression(complained))?.reason).toBe('complaint')
    expect(await mail.suppression(transient)).toBeUndefined()

    const wrong = `whsec_${Buffer.from('another-secret').toString('base64')}`

    expect((await resendPost({ type: 'email.bounced', data: { to: [forged] } }, { secret: wrong })).status).toBe(401)
    expect((await resendPost({ type: 'email.bounced', data: { to: [forged] } }, { timestamp: String(now() - 3600) })).status).toBe(401)
    expect(await mail.suppression(forged)).toBeUndefined()
  })

  it('answers 404 for a provider with no secret, and takes only POST', async () => {
    const saved = process.env.MAIL_EVENTS_MAILGUN

    delete process.env.MAIL_EVENTS_MAILGUN

    try {
      const email = fresh()

      expect((await post('/_kay/mail/events/mailgun', mailgunBody({ event: 'complained', recipient: email }))).status).toBe(404)
      expect(await mail.suppression(email)).toBeUndefined()
    }
    finally {
      process.env.MAIL_EVENTS_MAILGUN = saved
    }

    expect((await site.fetch('/_kay/mail/events/postmark')).status).not.toBe(200)
    expect((await post('/_kay/mail/events/unknown', '{}')).status).not.toBe(200)
  })

  it('refuses a body over a megabyte', async () => {
    expect((await post('/_kay/mail/events/postmark', `{"pad":"${'x'.repeat(1_100_000)}"}`, postmarkAuth)).status).toBe(413)
  })
})

// The Message-ID the app wrote on a mail it sent to the address.
async function sentIdTo(address: string): Promise<string> {
  await mail.send({ to: address, subject: 'Sent', text: 'x' })

  return outbox.to(address).at(-1)!.headers['Message-ID']!
}

function dsn(address: string, { action = 'failed', status = '5.1.1', id = '<forged@fixture.test>', to = address } = {}): string {
  return [
    'From: MAILER-DAEMON@mx.example.org',
    'To: hello@fixture.test',
    'Subject: Undelivered Mail Returned to Sender',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your message could not be delivered.',
    '',
    '--BOUND',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.org',
    'Arrival-Date: Mon, 20 Jul 2026 10:00:00 +0000',
    '',
    `Final-Recipient: rfc822; ${address}`,
    `Action: ${action}`,
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '',
    '--BOUND',
    'Content-Type: message/rfc822',
    '',
    'From: hello@fixture.test',
    `To: ${to}`,
    `Message-ID: ${id}`,
    'Subject: Hello',
    '',
    'Hi',
    '',
    '--BOUND--',
    '',
  ].join('\r\n')
}

const inboundAuth = { authorization: `Bearer ${INBOUND}` }
const inbound = async (message: string, headers: Record<string, string> = inboundAuth) => post('/_kay/mail/inbound', message, { 'content-type': 'message/rfc822', ...headers })

describe('delivery status notifications', () => {
  it('suppresses the recipient of a permanent address failure on a mail this app sent, not a delay, a temporary failure or a policy block', async () => {
    const [dead, delayed, temporary, blocked, full] = [fresh(), fresh(), fresh(), fresh(), fresh()]

    expect((await inbound(dsn(dead, { id: await sentIdTo(dead) }))).status).toBe(200)
    expect((await inbound(dsn(delayed, { action: 'delayed', status: '4.4.1', id: await sentIdTo(delayed) }))).status).toBe(200)
    expect((await inbound(dsn(temporary, { status: '4.2.2', id: await sentIdTo(temporary) }))).status).toBe(200)
    expect((await inbound(dsn(blocked, { status: '5.7.1', id: await sentIdTo(blocked) }))).status).toBe(200)
    expect((await inbound(dsn(full, { status: '5.2.2', id: await sentIdTo(full) }))).status).toBe(200)

    expect((await mail.suppression(dead))?.source).toBe('dsn')

    for (const address of [delayed, temporary, blocked, full])
      expect(await mail.suppression(address)).toBeUndefined()
  })

  it('believes no report that returns a mail this app did not send, or one sent to someone else', async () => {
    const [victim, attacker] = [fresh(), fresh()]
    const own = await sentIdTo(attacker)

    expect((await inbound(dsn(victim))).status).toBe(200)
    expect((await inbound(dsn(victim, { id: own, to: attacker }))).status).toBe(200)
    expect((await inbound(dsn(victim, { id: `<${crypto.randomUUID()}.AAAAAAAAAAAAAAAA@fixture.test>` }))).status).toBe(200)
    expect(await mail.suppression(victim)).toBeUndefined()
  })

  it('is not handed to the reply function, and is refused without the secret', async () => {
    const before = replies.length
    const forged = fresh()

    expect((await inbound(dsn(fresh()))).status).toBe(200)
    expect(replies.length).toBe(before)
    expect((await inbound(dsn(forged), {})).status).toBe(401)
    expect((await inbound(dsn(forged), { authorization: 'Bearer wrong' })).status).toBe(401)
    expect(await mail.suppression(forged)).toBeUndefined()
  })
})

describe('suppressed recipients', () => {
  it('are skipped and logged by a direct send, a queued one and a list mail', async () => {
    const [dead, alive] = [fresh(), fresh()]

    await mail.suppress(dead)
    outbox.clear()

    const skipped = await mail.send({ to: dead, subject: 'Skipped', text: 'x' })

    expect(skipped).toMatchObject({ accepted: [], rejected: [dead], response: 'suppressed' })
    expect(outbox.to(dead)).toHaveLength(0)

    await mail.enqueue({ to: dead, subject: 'Queued', text: 'x' })
    expect(await mail.drain()).toBeGreaterThanOrEqual(1)
    expect(outbox.to(dead)).toHaveLength(0)
    expect(await mail.failed()).toHaveLength(0)

    await mail.send({ to: [dead, alive], cc: dead.toUpperCase(), subject: 'Partial', text: 'x' })
    expect(outbox.to(alive)).toHaveLength(1)
    expect(outbox.to(dead)).toHaveLength(0)

    expect(await mail.unsuppress(dead)).toBe(true)
    expect(await mail.unsuppress(dead)).toBe(false)
    await mail.send({ to: dead, subject: 'Back', text: 'x' })
    expect(outbox.to(dead)).toHaveLength(1)
  })

  it('leave every list at once, and a broadcast skips them', async () => {
    const [dead, alive] = [fresh(), fresh()]
    const list = mail.list()

    for (const email of [dead, alive]) {
      const { subscribe } = await import(`${import.meta.dir}/fixture/src/routes/subscribe.kay`) as { subscribe: Action<{ email: string }, unknown> }

      await site.call(subscribe, { email })

      const sent = await outbox.waitFor(email, { site, find: item => item.subject.startsWith('Confirm') })

      expect((await post(`/_kay/mail/list/confirm?token=${outbox.token(sent, '/confirm')}`, '')).status).toBe(200)
    }

    expect((await list.subscribers()).map(row => row.email)).toContain(dead)

    expect((await post('/_kay/mail/events/postmark', postmarkBounce(dead), postmarkAuth)).status).toBe(200)
    expect((await list.subscribers()).map(row => row.email)).not.toContain(dead)
    expect((await list.subscribers()).map(row => row.email)).toContain(alive)

    outbox.clear()
    await list.send({ subject: 'News', text: 'Hello' })
    await mail.drain()
    expect(outbox.to(dead)).toHaveLength(0)
    expect(outbox.to(alive)).toHaveLength(1)
  })

  it('a complaint stops list and bulk mail only, a bounce stops every mail', async () => {
    const [complained, bounced, alive] = [fresh(), fresh(), fresh()]
    const unsubscribe = 'https://fixture.test/unsubscribe'

    await mail.suppress(complained, 'complaint')
    await mail.suppress(bounced, 'bounce')
    outbox.clear()

    // A transactional mail (a reset link, a sign-in code) still reaches an address that reported a newsletter as spam.
    await mail.send({ to: complained, subject: 'Reset', text: 'x' })
    expect(outbox.to(complained)).toHaveLength(1)
    await mail.enqueue({ to: complained, subject: 'Queued reset', text: 'x' })
    await mail.drain()
    expect(outbox.to(complained)).toHaveLength(2)

    // A mail carrying a one-click unsubscribe is bulk mail.
    const bulk = await mail.send({ to: complained, subject: 'News', text: 'x', unsubscribe })

    expect(bulk).toMatchObject({ accepted: [], rejected: [complained], response: 'suppressed' })
    await mail.send({ to: [complained, alive], subject: 'News 2', text: 'x', unsubscribe })
    expect(outbox.to(complained)).toHaveLength(2)
    expect(outbox.to(alive)).toHaveLength(1)

    // A bounce stops both.
    expect((await mail.send({ to: bounced, subject: 'Reset', text: 'x' })).response).toBe('suppressed')
    expect((await mail.send({ to: bounced, subject: 'News', text: 'x', unsubscribe })).response).toBe('suppressed')
    expect(outbox.to(bounced)).toHaveLength(0)
  })

  it('a complaint leaves the lists and gets no confirmation mail when it signs up again', async () => {
    const email = fresh()
    const { subscribe } = await import(`${import.meta.dir}/fixture/src/routes/subscribe.kay`) as { subscribe: Action<{ email: string }, unknown> }

    await mail.suppress(email, 'complaint')
    outbox.clear()

    // The confirmation is queued off the response path, and a skipped one says so.
    await logged(async (lines) => {
      await site.call(subscribe, { email })
      await untilHolds(() => lines.some(([, line]) => line.includes('confirmation mail was skipped')))
    })
    await mail.drain()
    expect(outbox.to(email)).toHaveLength(0)
  })

  it('are lifted by an erase', async () => {
    const email = fresh()

    await mail.suppress(email, 'complaint')
    expect((await mail.suppression(email))?.reason).toBe('complaint')
    await mail.erase(email)
    expect(await mail.suppression(email)).toBeUndefined()
  })
})

const CRLF = '\r\n'

describe('inbound replies', () => {
  it('hands a reply, decoded, to the mailer\'s inbound function', async () => {
    const message = [
      'From: =?UTF-8?Q?Am=C3=A9lie?= <Amelie@Example.com>',
      'To: Fixture <hello@fixture.test>',
      'Subject: =?UTF-8?B?UmU6IELDqW7DqWZpY2U=?=',
      'Message-ID: <reply-1@example.com>',
      'In-Reply-To: <sent-1@fixture.test>',
      'References: <a@x> <sent-1@fixture.test>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUT"',
      '',
      '--OUT',
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Merci beaucoup, =C3=A7a marche=\r\n !',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Merci</p>',
      '--ALT--',
      '--OUT',
      'Content-Type: application/pdf; name="devis.pdf"',
      'Content-Disposition: attachment; filename="devis.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4').toString('base64'),
      '--OUT--',
      '',
    ].join(CRLF)

    const before = replies.length

    expect((await inbound(message)).status).toBe(200)
    expect(replies).toHaveLength(before + 1)

    const reply = replies.at(-1)!

    expect(reply).toMatchObject({ from: 'amelie@example.com', fromName: 'Amélie', to: ['hello@fixture.test'], subject: 'Re: Bénéfice', messageId: '<reply-1@example.com>', inReplyTo: '<sent-1@fixture.test>', references: ['<a@x>', '<sent-1@fixture.test>'], html: '<p>Merci</p>' })
    expect(reply.text).toBe('Merci beaucoup, ça marche !')
    expect(reply.attachments).toHaveLength(1)
    expect(reply.attachments[0]).toMatchObject({ filename: 'devis.pdf', contentType: 'application/pdf' })
    expect(new TextDecoder().decode(reply.attachments[0]!.content)).toBe('%PDF-1.4')
  })

  it('takes a raw message labelled as a form, as curl --data-binary sends it, and keeps 8bit UTF-8 whole', async () => {
    const before = replies.length
    const message = 'From: a@example.com\r\nTo: hello@fixture.test\r\nSubject: Prix\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nPrix: 5 € – l’été'

    expect((await inbound(message, { ...inboundAuth, 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(200)
    expect(replies).toHaveLength(before + 1)
    expect(replies.at(-1)!.text).toBe('Prix: 5 € – l’été')
  })

  it('takes the raw message from the form of a provider\'s inbound parse', async () => {
    const form = new FormData()
    const before = replies.length

    form.set('email', 'From: a@example.com\r\nTo: hello@fixture.test\r\nSubject: Form\r\n\r\nBody')
    expect((await post('/_kay/mail/inbound', form, inboundAuth)).status).toBe(200)
    expect(replies).toHaveLength(before + 1)
    expect(replies.at(-1)).toMatchObject({ subject: 'Form', text: 'Body' })

    const empty = new FormData()

    empty.set('other', 'x')
    expect((await post('/_kay/mail/inbound', empty, inboundAuth)).status).toBe(400)
    expect(replies).toHaveLength(before + 1)
  })

  it('takes a message with Basic credentials whose password is the secret, refuses others and a huge one', async () => {
    const before = replies.length
    const message = 'From: a@example.com\r\nSubject: Basic\r\n\r\nx'

    expect((await inbound(message, { authorization: `Basic ${Buffer.from(`any:${INBOUND}`).toString('base64')}` })).status).toBe(200)
    expect((await inbound(message, { authorization: `Basic ${Buffer.from('any:wrong').toString('base64')}` })).status).toBe(401)
    expect((await inbound(message, {})).status).toBe(401)
    expect(replies).toHaveLength(before + 1)
    expect((await inbound(`Subject: big\r\n\r\n${'x'.repeat(5_300_000)}`)).status).toBe(413)
  })

  it('survives a hostile structure', async () => {
    const deep = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${'--b\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n'.repeat(50)}`

    expect((await inbound(deep)).status).toBe(200)
    expect((await inbound('Content-Type: multipart/report; report-type=delivery-status; boundary=x\r\n\r\n--x\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: nonsense\r\n')).status).toBe(200)
  })

  it('answers 404 while no secret is set', async () => {
    const saved = process.env.MAIL_INBOUND_SECRET

    delete process.env.MAIL_INBOUND_SECRET

    try {
      expect((await inbound('Subject: x\r\n\r\ny')).status).toBe(404)
    }
    finally {
      process.env.MAIL_INBOUND_SECRET = saved
    }
  })
})

describe('a store of the app\'s own', () => {
  it('keeps its suppressions in the default file, which a restarted process reads again', async () => {
    const file = join(await scratchDir('mail-custom-store'), 'lists.sqlite')
    const own = openLists(':memory:')
    // A store that implements none of the suppression methods, as one written before them.
    const custom: ListStore = { ...own, suppress: undefined, suppressed: undefined, lift: undefined }
    const host = { configured: () => true, render: async () => {
      throw new Error('unused')
    }, deliver: async () => undefined }
    const address = fresh()

    await createLists(host, { store: custom, file }).suppress(address, 'bounce', 'test')

    const restarted = createLists(host, { store: custom, file })

    expect([...(await restarted.suppressed([address])).keys()]).toEqual([address])
  })
})

describe('suppressions of a mailer with no list', () => {
  const host = { configured: () => true, render: async () => {
    throw new Error('unused')
  }, deliver: async () => undefined }

  const tables = (file: string): string[] => {
    const db = new Database(file, { readonly: true })

    try {
      return db.query<{ name: string }, []>('SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name').all().map(row => row.name)
    }
    finally {
      db.close()
    }
  }

  it('keeps a bounce in the default file, in its table alone, and looks it up, erases or exports a person without making a file before it', async () => {
    const file = join(await scratchDir('mail-no-list'), 'mail-list.sqlite')
    const lists = createLists(host, { file })
    const address = fresh()

    expect((await lists.suppressed([address])).size).toBe(0)
    expect(await lists.lift(address)).toBe(false)
    expect(await lists.erase(address)).toBe(0)
    expect(await lists.subscriptions(address)).toEqual([])
    expect(existsSync(file)).toBe(false)

    await lists.suppress(address, 'bounce', 'test')

    const restarted = createLists(host, { file })

    expect([...(await restarted.suppressed([address])).keys()]).toEqual([address])
    expect(await restarted.subscriptions(address)).toEqual([])
    expect(await restarted.erase(address)).toBe(0)
    expect((await restarted.suppressed([address])).size).toBe(0)
    expect(tables(file)).toEqual(['kay_mail_suppressions'])
  })

  it('reads, lifts and erases what a default file holding lists kept before suppressions had a store of their own', async () => {
    const file = join(await scratchDir('mail-old-file'), 'mail-list.sqlite')
    const old = openLists(file)
    const [bounced, subscribed] = [fresh(), fresh()]

    old.suppress(bounced, 'bounce', 'dsn')
    old.ask('news', subscribed, 'n1', 'en')
    old.close()

    const lists = createLists(host, { file })

    expect([...(await lists.suppressed([bounced, subscribed])).keys()]).toEqual([bounced])
    expect((await lists.subscriptions(subscribed)).map(row => row.list)).toEqual(['news'])
    expect(await lists.lift(bounced)).toBe(true)
    expect(await lists.erase(subscribed)).toBe(1)
  })

  it('writes to the mailer\'s suppressionStore alone, and keeps in force what a list store kept', async () => {
    const own = openLists(':memory:')
    const kept = sqliteSuppressions(join(await scratchDir('mail-suppression-store'), 'suppressions.sqlite'))
    const [before, after] = [fresh(), fresh()]

    own.suppress(before, 'complaint', 'old')

    const lists = createLists(host, { store: own, suppressions: kept })

    await lists.suppress(after, 'bounce', 'test')

    expect((await kept.suppressed([after])).map(row => row.email)).toEqual([after])
    expect(own.suppressed([after])).toEqual([])
    expect([...(await lists.suppressed([before, after])).keys()].sort()).toEqual([before, after].sort())
    expect(await lists.lift(before)).toBe(true)
    expect(own.suppressed([before])).toEqual([])
  })

  it('is given to the mailer as suppressionStore', async () => {
    const kept = sqliteSuppressions(':memory:')
    const app = mailer({ from: 'a@fixture.test', suppressionStore: kept, queue: { store: memoryJobs(), name: 'suppression-store' } })
    const address = fresh()

    expect(await app.suppress(address)).toBe(true)
    expect((await kept.suppressed([address])).map(row => row.reason)).toEqual(['bounce'])
    expect((await app.suppression(address))?.source).toBe('manual')
  })
})
