/* eslint-disable ts/no-unsafe-member-access, ts/no-unsafe-call -- the stand-in's request bodies are read as the JSON they are */
import type { Mail } from '../src/types'
import { createHash, createHmac } from 'node:crypto'
import process from 'node:process'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { mailer } from '../src/mailer'
import { mailgun, postmark, providerFromUrl, providerOf, resend, sendgrid, ses, signed } from '../src/providers'

await testSite({ root: 'tests/fixture' })

const SINK = Symbol.for('kay.log')

interface Seen {
  method: string
  path: string
  headers: Headers
  body: string
  form: FormData | undefined
}

const seen: Seen[] = []
let answer: (path: string) => Response = () => new Response('{}')
let stall = false

// Stands in for every provider's API: it records the request and answers as `answer` says.
const api = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    const type = request.headers.get('content-type') ?? ''
    const form = type.startsWith('multipart/form-data') ? await request.clone().formData() : undefined

    seen.push({ method: request.method, path: url.pathname, headers: request.headers, body: form === undefined ? await request.text() : '', form })

    if (stall)
      await new Promise(() => undefined)

    return answer(url.pathname)
  },
})
const base = `http://127.0.0.1:${api.port}`

afterAll(async () => {
  await api.stop(true)
})

afterEach(() => {
  seen.length = 0
  stall = false
  answer = () => new Response('{}')
  ;(globalThis as { [SINK]?: unknown })[SINK] = undefined
})

const json = (value: unknown, status = 200): Response => Response.json(value, { status })

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  }
  catch (error) {
    return error as Error
  }

  throw new Error('it did not throw')
}

const mail: Mail = {
  from: { name: 'Site, Inc.', address: 'noreply@example.com' },
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: ['cc@example.com'],
  bcc: ['bcc@example.com'],
  replyTo: 'visitor@example.org',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  headers: { 'Message-ID': '<id@example.com>', 'List-Unsubscribe': '<https://example.com/u>' },
  attachments: [{ filename: 'a.txt', content: 'hello', contentType: 'text/plain' }, { filename: 'logo.png', content: new Uint8Array([1, 2, 3]), contentType: 'image/png', cid: 'logo' }],
}

describe('resend()', () => {
  it('posts the mail with the key and keeps the id Resend answers', async () => {
    answer = () => json({ id: 're_123' })

    const delivery = await resend({ apiKey: 're_key', baseUrl: base }).send(mail)
    const [request] = seen
    const body = JSON.parse(request!.body)

    expect(request).toMatchObject({ method: 'POST', path: '/emails' })
    expect(request!.headers.get('authorization')).toBe('Bearer re_key')
    expect(body).toMatchObject({ from: '"Site, Inc." <noreply@example.com>', to: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], reply_to: 'visitor@example.org', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' })
    expect(body.headers).toEqual(mail.headers)
    expect(body.attachments).toEqual([{ filename: 'a.txt', content: Buffer.from('hello').toString('base64'), content_type: 'text/plain' }, { filename: 'logo.png', content: Buffer.from([1, 2, 3]).toString('base64'), content_type: 'image/png', content_id: 'logo' }])
    expect(delivery).toMatchObject({ messageId: 're_123', accepted: ['ada@example.com', 'grace@example.com', 'cc@example.com', 'bcc@example.com'], rejected: [] })
  })

  it('throws what Resend said for a refusal, without the key', async () => {
    answer = () => json({ name: 'validation_error', message: 'The from address is not verified' }, 422)

    const error = await failure(resend({ apiKey: 're_secret', baseUrl: base }).send(mail))

    expect(error.message).toContain('Resend refused the mail with 422: The from address is not verified')
    expect(error.message).not.toContain('re_secret')
  })

  it('stops with the signal of the queue and sends nothing for one already aborted', async () => {
    stall = true

    const controller = new AbortController()
    const sending = failure(resend({ apiKey: 'k', baseUrl: base }).send(mail, controller.signal))

    while (seen.length === 0)
      await Bun.sleep(5)

    controller.abort(new Error('given up'))
    expect((await sending).message).toBe('given up')

    seen.length = 0
    await expect(resend({ apiKey: 'k', baseUrl: base }).send(mail, AbortSignal.abort())).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it('gives up after its timeout', async () => {
    stall = true

    const error = await failure(resend({ apiKey: 'k', baseUrl: base, timeout: '1s' }).send(mail))

    expect(error.message).toContain('did not answer within 1 seconds')
  })

  it('refuses a missing key where it is made', () => {
    expect(() => resend({ apiKey: '' })).toThrow('apiKey')
  })
})

describe('postmark()', () => {
  it('posts the mail with the server token and keeps the MessageID', async () => {
    answer = () => json({ ErrorCode: 0, Message: 'OK', MessageID: 'pm-1' })

    const delivery = await postmark({ token: 'tok', messageStream: 'broadcast', baseUrl: base }).send(mail)
    const [request] = seen
    const body = JSON.parse(request!.body)

    expect(request).toMatchObject({ method: 'POST', path: '/email' })
    expect(request!.headers.get('x-postmark-server-token')).toBe('tok')
    expect(body).toMatchObject({ From: '"Site, Inc." <noreply@example.com>', To: '"Ada Lovelace" <ada@example.com>, grace@example.com', Cc: 'cc@example.com', Bcc: 'bcc@example.com', ReplyTo: 'visitor@example.org', Subject: 'Hello', HtmlBody: '<p>Hi</p>', TextBody: 'Hi', MessageStream: 'broadcast' })
    expect(body.Headers).toContainEqual({ Name: 'List-Unsubscribe', Value: '<https://example.com/u>' })
    expect(body.Attachments).toEqual([{ Name: 'a.txt', Content: Buffer.from('hello').toString('base64'), ContentType: 'text/plain' }, { Name: 'logo.png', Content: Buffer.from([1, 2, 3]).toString('base64'), ContentType: 'image/png', ContentID: 'cid:logo' }])
    expect(delivery.messageId).toBe('pm-1')
  })

  it('throws for an ErrorCode in a 200 and for a refusal', async () => {
    answer = () => json({ ErrorCode: 406, Message: 'Inactive recipient' })
    await expect(postmark({ token: 'tok', baseUrl: base }).send(mail)).rejects.toThrow('406: Inactive recipient')

    answer = () => json({ ErrorCode: 10, Message: 'Bad or missing API token' }, 401)
    await expect(postmark({ token: 'tok', baseUrl: base }).send(mail)).rejects.toThrow('401: Bad or missing API token')
  })
})

describe('sendgrid()', () => {
  it('posts the mail with the key and keeps x-message-id', async () => {
    answer = () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } })

    const delivery = await sendgrid({ apiKey: 'SG.key', baseUrl: base }).send(mail)
    const [request] = seen
    const body = JSON.parse(request!.body)

    expect(request).toMatchObject({ method: 'POST', path: '/v3/mail/send' })
    expect(request!.headers.get('authorization')).toBe('Bearer SG.key')
    expect(body.personalizations).toEqual([{ to: [{ email: 'ada@example.com', name: 'Ada Lovelace' }, { email: 'grace@example.com' }], cc: [{ email: 'cc@example.com' }], bcc: [{ email: 'bcc@example.com' }] }])
    expect(body.from).toEqual({ email: 'noreply@example.com', name: 'Site, Inc.' })
    expect(body.reply_to).toEqual({ email: 'visitor@example.org' })
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Hi' }, { type: 'text/html', value: '<p>Hi</p>' }])
    expect(body.headers).toEqual(mail.headers)
    expect(body.attachments[1]).toMatchObject({ filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' })
    expect(delivery.messageId).toBe('sg-1')
  })

  it('throws what SendGrid said', async () => {
    answer = () => json({ errors: [{ message: 'The from address does not match a verified Sender Identity' }] }, 403)
    await expect(sendgrid({ apiKey: 'k', baseUrl: base }).send(mail)).rejects.toThrow('403')
  })
})

describe('mailgun()', () => {
  it('posts a form to the domain with Basic credentials and keeps the id', async () => {
    answer = () => json({ id: '<20260101.abc@mg.example.com>', message: 'Queued. Thank you.' })

    const delivery = await mailgun({ apiKey: 'key-1', domain: 'mg.example.com', baseUrl: base }).send(mail)
    const [request] = seen
    const form = request!.form!

    expect(request).toMatchObject({ method: 'POST', path: '/v3/mg.example.com/messages' })
    expect(request!.headers.get('authorization')).toBe(`Basic ${Buffer.from('api:key-1').toString('base64')}`)
    expect(form.get('from')).toBe('"Site, Inc." <noreply@example.com>')
    expect(form.get('to')).toBe('"Ada Lovelace" <ada@example.com>, grace@example.com')
    expect(form.get('cc')).toBe('cc@example.com')
    expect(form.get('bcc')).toBe('bcc@example.com')
    expect(form.get('subject')).toBe('Hello')
    expect(form.get('html')).toBe('<p>Hi</p>')
    expect(form.get('text')).toBe('Hi')
    expect(form.get('h:Reply-To')).toBe('visitor@example.org')
    expect(form.get('h:List-Unsubscribe')).toBe('<https://example.com/u>')
    expect((form.get('attachment') as File).name).toBe('a.txt')
    expect((form.get('inline') as File).name).toBe('logo')
    expect(delivery.messageId).toBe('<20260101.abc@mg.example.com>')
  })

  it('uses the European API for region eu', async () => {
    const calls: string[] = []
    const real = globalThis.fetch

    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input))

      return json({ id: 'x' })
    }) as unknown as typeof fetch

    try {
      await mailgun({ apiKey: 'k', domain: 'mg.example.com', region: 'eu' }).send(mail)
    }
    finally {
      globalThis.fetch = real
    }

    expect(calls).toEqual(['https://api.eu.mailgun.net/v3/mg.example.com/messages'])
  })
})

describe('ses()', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'eu-west-1' }

  it('posts the raw message with a Signature Version 4 header and keeps the MessageId', async () => {
    answer = () => json({ MessageId: 'ses-1' })

    const delivery = await ses({ ...credentials, sessionToken: 'tok', configurationSet: 'events', baseUrl: base }).send(mail)
    const [request] = seen
    const body = JSON.parse(request!.body)
    const raw = Buffer.from(body.Content.Raw.Data, 'base64').toString()

    expect(request).toMatchObject({ method: 'POST', path: '/v2/email/outbound-emails' })
    expect(body).toMatchObject({ FromEmailAddress: 'noreply@example.com', Destination: { ToAddresses: ['ada@example.com', 'grace@example.com'], CcAddresses: ['cc@example.com'], BccAddresses: ['bcc@example.com'] }, ConfigurationSetName: 'events' })
    expect(raw).toContain('Subject: Hello')
    expect(raw).toContain('Message-ID: <id@example.com>')
    expect(raw).toContain('filename=a.txt')
    expect(raw).not.toContain('bcc@example.com')
    expect(request!.headers.get('x-amz-security-token')).toBe('tok')
    expect(request!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[\da-f]{64}$/)
    expect(delivery.messageId).toBe('ses-1')
  })

  it('signs as AWS does: the signature is the HMAC chain over the canonical request', () => {
    const url = new URL('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
    const body = '{"a":1}'
    const now = new Date('2026-01-02T03:04:05.000Z')
    const headers = signed(url, body, credentials, now)
    const hash = (data: string) => createHash('sha256').update(data).digest('hex')
    const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
    const canonical = `POST\n/v2/email/outbound-emails\n\ncontent-type:application/json\nhost:email.eu-west-1.amazonaws.com\nx-amz-date:20260102T030405Z\n\ncontent-type;host;x-amz-date\n${hash(body)}`
    const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, '20260102'), 'eu-west-1'), 'ses'), 'aws4_request')
    const expected = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n20260102T030405Z\n20260102/eu-west-1/ses/aws4_request\n${hash(canonical)}`).digest('hex')

    expect(headers['x-amz-date']).toBe('20260102T030405Z')
    expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/eu-west-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${expected}`)
  })

  it('refuses a region that is none', () => {
    expect(() => ses({ ...credentials, region: 'mars' })).toThrow('region')
  })
})

describe('MAIL_URL naming a provider', () => {
  it('reads each provider from its scheme', () => {
    expect(providerOf('resend://re_Key')).toBe('resend')
    expect(providerOf('SES://a:b@eu-west-1')).toBe('ses')
    expect(providerOf('smtp://mail.example.com')).toBeUndefined()
    expect(providerOf('smtps://mail.example.com')).toBeUndefined()
  })

  it('refuses an address that cannot be used, naming MAIL_URL', () => {
    expect(() => providerFromUrl('resend://')).toThrow('MAIL_URL')
    expect(() => providerFromUrl('mailgun://key')).toThrow('MAIL_URL')
    expect(() => providerFromUrl('mailgun://key@mg.example.com?region=asia')).toThrow('region')
    expect(() => providerFromUrl('ses://onlykey@eu-west-1')).toThrow('MAIL_URL')
    expect(() => providerFromUrl('resend://100%')).toThrow('percent-encoding')
  })

  it('keeps the case of a key and decodes a percent-encoded secret', async () => {
    answer = () => json({ id: 'r1' })
    await providerFromUrl(`resend://Re_MixedCase?baseUrl=${base}`).send(mail)
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer Re_MixedCase')

    seen.length = 0
    answer = () => json({ MessageId: 's1' })
    await providerFromUrl(`ses://AKID:a%2Fb%2Bc@us-east-1?baseUrl=${base}`).send(mail)
    expect(seen[0]!.headers.get('authorization')).toContain('Credential=AKID/')
  })

  it('reads the whole query after its first `?`', async () => {
    answer = () => json({ MessageID: 'p1', ErrorCode: 0 })
    await providerFromUrl(`postmark://tok?baseUrl=${base}&stream=a?b`).send(mail)
    expect(JSON.parse(seen[0]!.body).MessageStream).toBe('a?b')
  })
})

describe('mailer() on a provider\'s MAIL_URL', () => {
  const NAMES = ['NODE_ENV', 'MAIL_URL', 'MAIL_FROM', 'MAIL_EVENTS_POSTMARK']

  it('sends over the provider with no code, through the queue and with its id kept', async () => {
    const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

    process.env.NODE_ENV = 'production'
    process.env.MAIL_URL = `postmark://tok?baseUrl=${base}`
    process.env.MAIL_FROM = 'noreply@example.com'
    answer = () => json({ ErrorCode: 0, MessageID: 'pm-env' })
    ;(globalThis as { [SINK]?: unknown })[SINK] = () => undefined

    try {
      const app = mailer({ queue: { name: 'providers-env' } })

      expect(await app.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })).toMatchObject({ messageId: 'pm-env', accepted: ['ada@example.com'] })
      expect(seen[0]).toMatchObject({ path: '/email' })
      expect(JSON.parse(seen[0]!.body).Headers.some((header: { Name: string }) => header.Name === 'Message-ID')).toBe(true)
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }
    }
  })

  it('stops the boot for a MAIL_URL that is no provider address', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, MAIL_URL: process.env.MAIL_URL }

    process.env.NODE_ENV = 'production'
    process.env.MAIL_URL = 'mailgun://nodomain'

    try {
      expect(() => mailer()).toThrow('MAIL_URL')
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }
    }
  })
})
