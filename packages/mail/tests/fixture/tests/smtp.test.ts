import { generateKeyPairSync } from 'node:crypto'
import process from 'node:process'
import { mailer, smtp } from '@kaynooo/kayjs-mail'
import { afterAll, describe, expect, it } from 'bun:test'
import { bodyText, startSmtp } from '../../helpers/smtp'
import Welcome from '../src/mails/welcome.kay'
import { logged } from './logged'

const server = startSmtp()
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

afterAll(() => server.stop())

describe('smtp', () => {
  it('sends text and html as one multipart mail, greeting the server with the name given', async () => {
    const transport = smtp({ host: '127.0.0.1', port: server.port, name: 'fixture.test' })
    const mail = mailer({ from: { name: 'Fixture', address: 'hello@fixture.test' }, transport })

    const delivery = await mail.send({ to: 'ada@example.com', replyTo: { name: 'Visitor', address: 'visitor@example.com' }, subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: 'https://fixture.test/confirm' } })
    const received = server.received.at(-1)!

    expect(delivery.accepted).toEqual(['ada@example.com'])
    expect(server.greetings.at(-1)).toBe('fixture.test')
    expect(received.from).toBe('<hello@fixture.test>')
    expect(received.to).toEqual(['<ada@example.com>'])
    expect(received.data).toContain('Reply-To: Visitor <visitor@example.com>')
    expect(received.data).toContain('multipart/alternative')
    expect(bodyText(received)).toContain('Confirm my address (https://fixture.test/confirm)')
    expect(bodyText(received, 'text/html')).toContain('Welcome, Ada</h1>')
  })

  it('writes no header of a sender\'s own, from a name or a subject holding a line break', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port }) })

    await mail.send({ to: 'ada@example.com', replyTo: { name: 'Ada\r\nBcc: spam@example.com', address: 'ada@example.com' }, subject: 'Hi\r\nBcc: spam@example.com', text: 'Hello\r\nBcc: spam@example.com' })

    const received = server.received.at(-1)!

    expect(received.to).toEqual(['<ada@example.com>'])
    expect(received.data.slice(0, received.data.indexOf('\n\n'))).not.toMatch(/^Bcc:/im)
  })

  it('logs each mail sent with the server\'s answer, its subject\'s line breaks escaped', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port }) })
    const lines = await logged(async () => mail.send({ to: 'ada@example.com', cc: 'bob@example.com', subject: 'Hi\nforged line', text: 'Hello' }))

    expect(lines).toEqual([['info', 'kayjs-mail: "Hi\\nforged line" sent to ada@example.com, bob@example.com: 250 queued']])
  })

  it('never sends a password over a connection that did not upgrade to TLS', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, user: 'site', pass: 'secret' }) })
    const before = server.received.length

    await expect(mail.send({ to: 'ada@example.com', subject: 'S', text: 'T' })).rejects.toThrow('STARTTLS')
    expect(server.received).toHaveLength(before)
  })

  it('reuses one connection for mails sent one after another, and closes it once they stop', async () => {
    const own = startSmtp()
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: own.port }) })

    try {
      for (const subject of ['One', 'Two', 'Three'])
        await mail.send({ to: 'ada@example.com', subject, text: 'Hi' })

      expect(own.received).toHaveLength(3)
      expect(own.connections).toEqual({ opened: 1, closed: 0 })

      await Bun.sleep(1200)
      expect(own.connections).toEqual({ opened: 1, closed: 1 })
    }
    finally {
      own.stop()
    }
  })

  it('holds sends to the rate limit', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, maxConnections: 1, rateLimit: 1 }) })
    const started = performance.now()

    await Promise.all([1, 2].map(async n => mail.send({ to: 'ada@example.com', subject: `Limited ${n}`, text: 'Hi' })))

    expect(performance.now() - started).toBeGreaterThan(900)
  })

  it('refuses a connection count or a rate limit that is no whole number of at least 1', () => {
    expect(() => smtp({ host: '127.0.0.1', maxConnections: 0 })).toThrow('maxConnections is 0')
    expect(() => smtp({ host: '127.0.0.1', rateLimit: 0.5 })).toThrow('rateLimit is 0.5')
  })

  it('signs each mail with DKIM when given a key, and refuses a key that is none where the transport is made', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, dkim: { domain: 'fixture.test', selector: 'mail', privateKey } }) })

    await mail.send({ to: 'ada@example.com', subject: 'Signed', text: 'Hi' })

    const { data } = server.received.at(-1)!
    const headers = data.slice(0, data.indexOf('\n\n'))

    expect(headers).toStartWith('DKIM-Signature: ')
    expect(headers).toContain('d=fixture.test;')
    expect(headers).toContain('s=mail;')
    expect(() => smtp({ host: '127.0.0.1', dkim: { domain: 'fixture.test', selector: 'mail', privateKey: 'not a key' } })).toThrow('dkim.privateKey is no private key')
  })

  it('refuses a timeout that is no positive duration where the transport is made', () => {
    expect(() => smtp({ host: '127.0.0.1', timeout: 'soon' as '10s' })).toThrow('takes a positive duration')
    expect(() => smtp({ host: '127.0.0.1', timeout: 0 })).toThrow('takes a positive duration')
    expect(() => smtp({ host: '127.0.0.1', timeout: '1.5m' })).not.toThrow()
  })

  it('reads its settings from the environment in production, the greeting named after the sender\'s domain', async () => {
    const saved = { ...process.env }

    Object.assign(process.env, { NODE_ENV: 'production', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_FROM: 'site@env.test' })

    try {
      await mailer({ fromName: 'Site, Env' }).send({ to: 'bob@example.com', subject: 'From env', text: 'Hello' })
    }
    finally {
      process.env = saved
    }

    expect(server.greetings.at(-1)).toBe('env.test')
    expect(server.received.at(-1)?.from).toBe('<site@env.test>')
    expect(server.received.at(-1)?.data).toContain('From: "Site, Env" <site@env.test>')
    expect(bodyText(server.received.at(-1)!)).toBe('Hello\n')
  })

  it('signs with the DKIM key the environment gives, its line breaks written \\n, for the sender\'s domain', async () => {
    const saved = { ...process.env }

    Object.assign(process.env, { NODE_ENV: 'production', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_FROM: 'site@env.test', SMTP_DKIM_SELECTOR: 'mail', SMTP_DKIM_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n') })

    try {
      await mailer({ queue: { name: 'dkim-env' } }).send({ to: 'bob@example.com', subject: 'Signed from env', text: 'Hello' })
    }
    finally {
      process.env = saved
    }

    expect(server.received.at(-1)!.data).toContain('d=env.test;')
  })

  it('stops the boot on a DKIM selector without a key, or a key that is none', () => {
    const saved = { ...process.env }

    Object.assign(process.env, { NODE_ENV: 'production', SMTP_HOST: '127.0.0.1', SMTP_FROM: 'site@env.test', SMTP_DKIM_SELECTOR: 'mail' })

    try {
      expect(() => mailer({ queue: { name: 'dkim-half' } })).toThrow('SMTP_DKIM_SELECTOR and SMTP_DKIM_PRIVATE_KEY go together')
      process.env.SMTP_DKIM_PRIVATE_KEY = 'not a key'
      expect(() => mailer({ queue: { name: 'dkim-broken' } })).toThrow('SMTP_DKIM_PRIVATE_KEY is no private key')
    }
    finally {
      process.env = saved
    }
  })
})
