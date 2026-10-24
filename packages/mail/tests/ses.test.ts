import type { KeyObject } from 'node:crypto'
import { createSign, generateKeyPairSync } from 'node:crypto'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { isSnsUrl, network } from '../src/sns'

const site = await testSite({ root: 'tests/fixture' })
const { mail } = await import(`${import.meta.dir}/fixture/src/mail`) as typeof import('./fixture/src/mail')

const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:ses-events'
const OTHER_TOPIC = 'arn:aws:sns:eu-west-1:210987654321:ses-events'
let counter = 0
const fresh = (): string => `ses${++counter}-${Math.random().toString(36).slice(2, 8)}@example.com`

// A minimal DER encoder, enough for a self-signed X.509 certificate with no openssl and no dependency.
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts)
  const long = body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xFF]
  const length = Buffer.from(body.length < 128 ? [body.length] : long)

  return Buffer.concat([Buffer.from([tag]), length, body])
}

const sequence = (...parts: Uint8Array[]): Uint8Array => der(0x30, ...parts)
const oid = (bytes: number[]): Uint8Array => der(0x06, Buffer.from(bytes))
const time = (date: Date): Uint8Array => der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replaceAll(/[-:T]/g, '')}Z`))

function certificate(privateKey: KeyObject, publicKey: KeyObject, { expired = false } = {}): string {
  const rsaSha256 = sequence(oid([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]), der(0x05))
  const name = sequence(der(0x31, sequence(oid([0x55, 0x04, 0x03]), der(0x0C, Buffer.from('sns.amazonaws.com')))))
  const day = 86_400_000
  const validity = sequence(time(new Date(Date.now() - (expired ? 20 : 2) * day)), time(new Date(Date.now() + (expired ? -10 : 365) * day)))
  const tbs = sequence(der(0xA0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), rsaSha256, name, validity, name, publicKey.export({ format: 'der', type: 'spki' }))
  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey)
  const certificateDer = sequence(tbs, rsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])))

  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(certificateDer).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}

const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const signer = rsa()
const CERT = '/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem'
// The certificate each path serves.
const served = new Map([[CERT, certificate(signer.privateKey, signer.publicKey)]])
const hits = { cert: 0, subscribe: 0 }
const local = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === '/redirect.pem')
      return new Response(null, { status: 302, headers: { location: new URL(CERT, request.url).href } })

    if (served.has(pathname)) {
      hits.cert++

      return new Response(served.get(pathname))
    }

    if (pathname === '/' && url.searchParams.get('Action') === 'ConfirmSubscription') {
      hits.subscribe++

      return new Response('<ConfirmSubscriptionResponse/>')
    }

    return new Response('no', { status: 404 })
  },
})
const base = `http://127.0.0.1:${local.port}`
const production = network.trusted

// The canonical string by the letter of Amazon's documentation: each field's name and value on lines of their own, in byte order, the last line ending too.
function canonical(message: Record<string, string>, fields: string[]): string {
  return fields.map(field => `${field}\n${message[field]}\n`).join('')
}

const NOTIFICATION = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
const CONFIRMATION = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']

function signed(fields: Record<string, string>, { version = '2', key = signer.privateKey, url = `${base}${CERT}` } = {}): string {
  const names = (fields.Type === 'Notification' ? NOTIFICATION : CONFIRMATION).filter(name => fields[name] !== undefined)
  const signature = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256').update(canonical(fields, names)).sign(key, 'base64')

  return JSON.stringify({ ...fields, SignatureVersion: version, Signature: signature, SigningCertURL: url })
}

const notification = (event: object, extra: Record<string, string> = {}) => ({ Type: 'Notification', MessageId: crypto.randomUUID(), TopicArn: TOPIC, Message: JSON.stringify(event), Timestamp: '2026-02-22T23:41:12.126Z', ...extra })
const bounce = (addresses: string[], bounceType = 'Permanent', key = 'notificationType') => ({ [key]: 'Bounce', bounce: { bounceType, bounceSubType: 'General', bouncedRecipients: addresses.map(emailAddress => ({ emailAddress, status: '5.1.1', action: 'failed', diagnosticCode: 'smtp; 550 user unknown' })), timestamp: '2012-05-25T14:59:38.605Z', feedbackId: '000001378603176d' }, mail: { messageId: '000001378603177f', destination: addresses } })
const complaint = (addresses: string[]) => ({ notificationType: 'Complaint', complaint: { complainedRecipients: addresses.map(emailAddress => ({ emailAddress })), complaintFeedbackType: 'abuse', timestamp: '2012-05-25T14:59:38.623Z', feedbackId: '000001378603177f' }, mail: { messageId: '000001378603177f', destination: addresses } })

const post = async (body: string) => site.fetch('/_kay/mail/events/ses', { method: 'POST', body, headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification' } })

beforeAll(() => {
  process.env.MAIL_EVENTS_SES = TOPIC
  network.trusted = url => url.startsWith(base)
})

afterAll(async () => {
  network.trusted = production
  await local.stop(true)
})

describe('SES through SNS', () => {
  it('suppresses a permanent bounce, signed with version 2 or version 1, and caches the certificate', async () => {
    const [first, second, third] = [fresh(), fresh(), fresh()]
    const before = hits.cert

    expect((await post(signed(notification(bounce([first, second]))))).status).toBe(200)
    expect((await post(signed(notification(bounce([third]), { Subject: 'Amazon SES Email Event Notification' }), { version: '1' }))).status).toBe(200)

    for (const address of [first, second, third])
      expect((await mail.suppression(address))?.reason).toBe('bounce')

    expect((await mail.suppression(first))?.source).toBe('ses')
    expect(hits.cert - before).toBeLessThanOrEqual(1)
  })

  it('reads the eventType of event publishing, and a complaint', async () => {
    const [published, complained] = [fresh(), fresh()]

    expect((await post(signed(notification(bounce([published], 'Permanent', 'eventType'))))).status).toBe(200)
    expect((await mail.suppression(published))?.reason).toBe('bounce')

    expect((await post(signed(notification(complaint([complained]))))).status).toBe(200)
    expect((await mail.suppression(complained))?.reason).toBe('complaint')
  })

  it('ignores a transient bounce, a delivery and a message that is no JSON', async () => {
    const [transient, delivered] = [fresh(), fresh()]

    expect((await post(signed(notification(bounce([transient], 'Transient'))))).status).toBe(200)
    expect((await post(signed(notification({ notificationType: 'Delivery', delivery: { recipients: [delivered] }, mail: { destination: [delivered] } })))).status).toBe(200)
    expect((await post(signed({ ...notification({}), Message: 'not json' }))).status).toBe(200)
    expect(await mail.suppression(transient)).toBeUndefined()
    expect(await mail.suppression(delivered)).toBeUndefined()
  })

  it('refuses a message that is tampered with, signed by another key, or of an unknown version', async () => {
    const [target, other, tampered] = [fresh(), fresh(), fresh()]
    const genuine = JSON.parse(signed(notification(bounce([target])))) as Record<string, string>

    expect((await post(JSON.stringify({ ...genuine, Message: JSON.stringify(bounce([tampered])) }))).status).toBe(401)
    expect((await post(signed(notification(bounce([other])), { key: rsa().privateKey }))).status).toBe(401)
    expect((await post(JSON.stringify({ ...genuine, SignatureVersion: '3' }))).status).toBe(401)
    expect((await post(JSON.stringify({ ...genuine, SignatureVersion: '1' }))).status).toBe(401)
    expect((await post(JSON.stringify({ ...genuine, Signature: undefined }))).status).toBe(401)

    for (const address of [target, other, tampered])
      expect(await mail.suppression(address)).toBeUndefined()
  })

  it('refuses a validly signed message of another topic, before it fetches anything', async () => {
    const email = fresh()
    const before = hits.cert

    expect((await post(signed(notification(bounce([email]), { TopicArn: OTHER_TOPIC })))).status).toBe(401)
    expect(hits.cert).toBe(before)
    expect(await mail.suppression(email)).toBeUndefined()
  })

  it('takes several topics, comma separated', async () => {
    const email = fresh()

    process.env.MAIL_EVENTS_SES = `${OTHER_TOPIC}, ${TOPIC}`

    try {
      expect((await post(signed(notification(bounce([email]))))).status).toBe(200)
      expect((await mail.suppression(email))?.reason).toBe('bounce')
    }
    finally {
      process.env.MAIL_EVENTS_SES = TOPIC
    }
  })

  it('answers a SubscriptionConfirmation by visiting its SubscribeURL, and 502 when it cannot, so SNS retries', async () => {
    const confirmation = (SubscribeURL: string) => ({ Type: 'SubscriptionConfirmation', MessageId: crypto.randomUUID(), Token: '2336412f37', TopicArn: TOPIC, Message: 'You have chosen to subscribe to the topic.', SubscribeURL, Timestamp: '2012-04-26T20:45:04.751Z' })
    const before = hits.subscribe

    expect((await post(signed(confirmation(`${base}/?Action=ConfirmSubscription&Token=2336412f37`)))).status).toBe(200)
    expect(hits.subscribe).toBe(before + 1)

    expect((await post(signed(confirmation('https://evil.example.com/subscribe')))).status).toBe(502)
    expect((await post(signed(confirmation(`${base}/?Action=Other`)))).status).toBe(502)
    expect(hits.subscribe).toBe(before + 1)
  })

  it('does not visit the SubscribeURL of an unsigned confirmation or one of another topic', async () => {
    const before = hits.subscribe
    const body = { Type: 'SubscriptionConfirmation', MessageId: 'a', Token: 't', TopicArn: TOPIC, Message: 'm', SubscribeURL: `${base}/?Action=ConfirmSubscription`, Timestamp: '2012-04-26T20:45:04.751Z' }

    expect((await post(JSON.stringify({ ...body, SignatureVersion: '2', Signature: 'AAAA', SigningCertURL: `${base}${CERT}` }))).status).toBe(401)
    expect((await post(signed({ ...body, TopicArn: OTHER_TOPIC }))).status).toBe(401)
    expect(hits.subscribe).toBe(before)
  })

  it('refuses a certificate that is expired, and answers 400 to what is no JSON object', async () => {
    const expired = rsa()
    const email = fresh()

    // A distinct path, as the cache holds the good certificate under the first.
    served.set('/SimpleNotificationService-expired.pem', certificate(expired.privateKey, expired.publicKey, { expired: true }))
    expect((await post(signed(notification(bounce([email])), { key: expired.privateKey, url: `${base}/SimpleNotificationService-expired.pem` }))).status).toBe(401)

    expect(await mail.suppression(email)).toBeUndefined()
    expect((await post('not json')).status).toBe(400)
    expect((await post('[1]')).status).toBe(400)
  })

  it('fetches a rotated certificate again when a cached one fails, but not within a minute', async () => {
    const rotated = rsa()
    const [early, late] = [fresh(), fresh()]
    const url = `${base}/SimpleNotificationService-rotation.pem`

    // Cached first under the old key.
    served.set('/SimpleNotificationService-rotation.pem', served.get(CERT)!)
    expect((await post(signed(notification(bounce([fresh()])), { url }))).status).toBe(200)
    served.set('/SimpleNotificationService-rotation.pem', certificate(rotated.privateKey, rotated.publicKey))

    try {
      expect((await post(signed(notification(bounce([early])), { key: rotated.privateKey, url }))).status).toBe(401)
      network.refetchAfter = 0
      expect((await post(signed(notification(bounce([late])), { key: rotated.privateKey, url }))).status).toBe(200)
    }
    finally {
      network.refetchAfter = 60_000
    }

    expect(await mail.suppression(early)).toBeUndefined()
    expect((await mail.suppression(late))?.reason).toBe('bounce')
  })

  it('refuses a certificate URL of the wrong shape, a redirect and an oversized file, and takes an UnsubscribeConfirmation as nothing', async () => {
    const email = fresh()
    const before = hits.cert

    for (const url of [`${base}/cert.pem`, `${base}${CERT}?x=1`, `${base}/redirect.pem`])
      expect((await post(signed(notification(bounce([email])), { url }))).status).toBe(401)

    served.set('/SimpleNotificationService-huge.pem', 'A'.repeat(100_000))
    expect((await post(signed(notification(bounce([email])), { url: `${base}/SimpleNotificationService-huge.pem` }))).status).toBe(401)
    expect(hits.cert - before).toBe(1)
    expect(await mail.suppression(email)).toBeUndefined()

    const unsubscribed = { Type: 'UnsubscribeConfirmation', MessageId: 'u', Token: 't', TopicArn: TOPIC, Message: 'm', SubscribeURL: `${base}/?Action=ConfirmSubscription`, Timestamp: '2012-04-26T20:45:04.751Z' }
    const visits = hits.subscribe

    expect((await post(signed(unsubscribed))).status).toBe(200)
    expect(hits.subscribe).toBe(visits)
  })

  it('refuses a body over 1 MB', async () => {
    expect((await post('x'.repeat(1_048_577))).status).toBe(413)
  })

  it('has no route without its topic', async () => {
    delete process.env.MAIL_EVENTS_SES

    try {
      expect((await post(signed(notification(bounce([fresh()]))))).status).toBe(404)
    }
    finally {
      process.env.MAIL_EVENTS_SES = TOPIC
    }
  })

  it('fetches a certificate from nowhere but an SNS endpoint in production', async () => {
    const email = fresh()
    const before = hits.cert

    network.trusted = production

    try {
      expect((await post(signed(notification(bounce([email])), { url: `${base}${CERT}` }))).status).toBe(401)
    }
    finally {
      network.trusted = url => url.startsWith(base)
    }

    expect(hits.cert).toBe(before)
    expect(await mail.suppression(email)).toBeUndefined()
  })
})

describe('the SNS endpoints trusted', () => {
  it('is https on sns.<region>.amazonaws.com and nothing else', () => {
    expect(isSnsUrl('https://sns.us-west-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem')).toBe(true)
    expect(isSnsUrl('https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc')).toBe(true)

    for (const url of [
      'http://sns.us-west-2.amazonaws.com/x.pem',
      'https://sns.us-west-2.amazonaws.com.evil.com/x.pem',
      'https://sns.us-west-2.amazonaws.com@evil.com/x.pem',
      'https://evil.com/sns.us-west-2.amazonaws.com',
      'https://sns.us-west-2.amazonaws.com:8443/x.pem',
      'https://user:pw@sns.us-west-2.amazonaws.com/x.pem',
      'https://sns.amazonaws.com/x.pem',
      'https://amazonaws.com/x.pem',
      'https://s3.us-west-2.amazonaws.com/x.pem',
      'https://notsns.us-west-2.amazonaws.com/x.pem',
      'https://sns.us-west-2.amazonaws.com.cn/x.pem',
      'ftp://sns.us-west-2.amazonaws.com/x.pem',
      'not a url',
      '',
    ])
      expect(isSnsUrl(url)).toBe(false)
  })
})
