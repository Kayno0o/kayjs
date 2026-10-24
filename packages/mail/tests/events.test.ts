import type { Action } from 'kay'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { outbox } from '../src/outbox'

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
    const [bounced, dropped, reported, blocked, forged, tampered] = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh()]

    expect((await sendgridPost([{ email: bounced, event: 'bounce', type: 'bounce', reason: '500 unknown recipient', status: '5.0.0' }, { email: dropped, event: 'dropped', reason: 'Bounced Address', status: '5.0.0' }, { email: reported, event: 'spamreport' }, { email: blocked, event: 'bounce', type: 'blocked' }])).status).toBe(200)

    expect((await mail.suppression(bounced))?.reason).toBe('bounce')
    expect((await mail.suppression(dropped))?.reason).toBe('bounce')
    expect((await mail.suppression(reported))?.reason).toBe('complaint')
    expect(await mail.suppression(blocked)).toBeUndefined()

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

    expect((await resendPost({ type: 'email.bounced', created_at: '2026-02-22T23:41:12.126Z', data: { email_id: 'x', to: [first, second], bounce: { type: 'Permanent', subType: 'General', message: 'no' } } })).status).toBe(200)
    expect((await resendPost({ type: 'email.complained', data: { email_id: 'x', to: [complained] } })).status).toBe(200)
    expect((await resendPost({ type: 'email.bounced', data: { to: [transient], bounce: { type: 'Transient' } } })).status).toBe(200)

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

function dsn(address: string, { action = 'failed', status = '5.1.1' } = {}): string {
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
    `To: ${address}`,
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
  it('suppresses the recipient of a permanent failure, not a delay or a temporary one', async () => {
    const [dead, delayed, temporary] = [fresh(), fresh(), fresh()]

    expect((await inbound(dsn(dead))).status).toBe(200)
    expect((await inbound(dsn(delayed, { action: 'delayed', status: '4.4.1' }))).status).toBe(200)
    expect((await inbound(dsn(temporary, { status: '4.2.2' }))).status).toBe(200)

    expect((await mail.suppression(dead))?.source).toBe('dsn')
    expect(await mail.suppression(delayed)).toBeUndefined()
    expect(await mail.suppression(temporary)).toBeUndefined()
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
