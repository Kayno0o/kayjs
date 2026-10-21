import { generateKeyPairSync } from 'node:crypto'
import process from 'node:process'
import { mailer, smtp } from '@kaynooo/kayjs-mail'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { memoryJobs } from 'kay/server'
import { bodyText, startSmtp } from '../../helpers/smtp'
import Welcome from '../src/mails/welcome.kay'
import { logged } from './logged'

const server = startSmtp()
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

afterAll(() => server.stop())

describe('smtp', () => {
  it('sends text and html as one multipart mail, greeting the server with the name given', async () => {
    const transport = smtp({ host: '127.0.0.1', port: server.port, insecure: true, name: 'fixture.test' })
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
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, insecure: true }) })

    await mail.send({ to: 'ada@example.com', replyTo: { name: 'Ada\r\nBcc: spam@example.com', address: 'ada@example.com' }, subject: 'Hi\r\nBcc: spam@example.com', text: 'Hello\r\nBcc: spam@example.com' })

    const received = server.received.at(-1)!

    expect(received.to).toEqual(['<ada@example.com>'])
    expect(received.data.slice(0, received.data.indexOf('\n\n'))).not.toMatch(/^Bcc:/im)
  })

  it('logs each mail sent with the server\'s answer, its subject\'s line breaks escaped', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, insecure: true }), logSubjects: true })
    const lines = await logged(async () => mail.send({ to: 'ada@example.com', cc: 'bob@example.com', subject: 'Hi\nforged line', text: 'Hello' }))

    expect(lines).toEqual([['info', 'kayjs-mail: "Hi\\nforged line" sent to 2 recipients at example.com: 250 queued']])
  })

  it('refuses a server not offering STARTTLS, a reset link going in clear otherwise, unless told it is insecure', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port }) })
    const before = server.received.length

    await expect(mail.send({ to: 'ada@example.com', subject: 'S', text: 'T' })).rejects.toThrow(`kayjs-mail: 127.0.0.1:${server.port} did not upgrade to TLS with STARTTLS, which kayjs-mail requires on every port but 465, so nothing was sent; a relay taking mail in clear, as on a private network, needs MAIL_INSECURE=true`)
    expect(server.received).toHaveLength(before)
  })

  it('names a relay without STARTTLS in the boot log, with the setting that allows it, and says nothing of one that is allowed', async () => {
    const saved = { ...process.env }
    // The boot check ran once its connection to the stub closed.
    const boot = async (insecure: string) => logged(async () => {
      const closed = server.connections.closed

      Object.assign(process.env, { NODE_ENV: 'production', MAIL_URL: `smtp://127.0.0.1:${server.port}`, MAIL_INSECURE: insecure, MAIL_FROM: 'site@env.test' })

      const app = new Elysia().use(mailer({ queue: { name: 'boot-check', store: memoryJobs() } }))

      app.listen(0)

      for (const start = Date.now(); server.connections.closed === closed && Date.now() - start < 10_000;)
        await Bun.sleep(20)

      // The warning follows the connection's close by a tick.
      await Bun.sleep(200)
      await app.stop()
    })

    try {
      const refused = (await boot('false')).map(([level, line]) => `${level} ${line}`).join('\n')

      expect(refused).toContain(`warn kayjs-mail: 127.0.0.1:${server.port} did not upgrade to TLS with STARTTLS`)
      expect(refused).toContain('so no mail would be sent')
      expect(refused).toContain('MAIL_INSECURE=true')
      expect(await boot('true')).toEqual([])
    }
    finally {
      process.env = saved
    }
  })

  it('never sends a password over a connection that did not upgrade to TLS', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, insecure: true, user: 'site', pass: 'secret' }) })
    const before = server.received.length

    await expect(mail.send({ to: 'ada@example.com', subject: 'S', text: 'T' })).rejects.toThrow('which is ignored while a password is set')
    expect(server.received).toHaveLength(before)
  })

  it('reuses one connection for mails sent one after another, and closes it once they stop', async () => {
    const own = startSmtp()
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: own.port, insecure: true }) })

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

  it.each([[{ max: 1, window: '1s' }], [1]] as const)('holds sends to the rate limit, as %j', async (rateLimit) => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, insecure: true, maxConnections: 1, rateLimit }) })
    const started = performance.now()

    await Promise.all([1, 2].map(async n => mail.send({ to: 'ada@example.com', subject: `Limited ${n}`, text: 'Hi' })))

    expect(performance.now() - started).toBeGreaterThan(900)
  })

  it('refuses a connection count or a rate limit that is no whole number of at least 1', () => {
    expect(() => smtp({ host: '127.0.0.1', maxConnections: 0 })).toThrow('maxConnections is 0')
    expect(() => smtp({ host: '127.0.0.1', rateLimit: 0.5 })).toThrow('rateLimit is 0.5')
    expect(() => smtp({ host: '127.0.0.1', rateLimit: { max: 0, window: '1s' } })).toThrow('rateLimit.max is 0')
    expect(() => smtp({ host: '127.0.0.1', rateLimit: { max: 1, window: 'soon' as '1s' } })).toThrow('rateLimit.window')
  })

  it('signs each mail with DKIM when given a key, and refuses a key that is none where the transport is made', async () => {
    const mail = mailer({ from: 'hello@fixture.test', transport: smtp({ host: '127.0.0.1', port: server.port, insecure: true, dkim: { domain: 'fixture.test', selector: 'mail', privateKey } }) })

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

    Object.assign(process.env, { NODE_ENV: 'production', MAIL_URL: `smtp://127.0.0.1:${server.port}`, MAIL_INSECURE: 'true', MAIL_FROM: 'site@env.test' })

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

    Object.assign(process.env, { NODE_ENV: 'production', MAIL_URL: `smtp://127.0.0.1:${server.port}`, MAIL_INSECURE: 'true', MAIL_FROM: 'site@env.test', MAIL_DKIM_SELECTOR: 'mail', MAIL_DKIM_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n') })

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

    Object.assign(process.env, { NODE_ENV: 'production', MAIL_URL: 'smtp://127.0.0.1', MAIL_FROM: 'site@env.test', MAIL_DKIM_SELECTOR: 'mail' })

    try {
      expect(() => mailer({ queue: { name: 'dkim-half' } })).toThrow('MAIL_DKIM_SELECTOR and MAIL_DKIM_PRIVATE_KEY go together')
      process.env.MAIL_DKIM_PRIVATE_KEY = 'not a key'
      expect(() => mailer({ queue: { name: 'dkim-broken' } })).toThrow('MAIL_DKIM_PRIVATE_KEY is no private key')
    }
    finally {
      process.env = saved
    }
  })
})

describe('mailer({ smtp })', () => {
  const production = { NODE_ENV: 'production', MAIL_INSECURE: 'true', MAIL_FROM: 'site@env.test' }

  // Runs `run` with the environment a production server has, restoring it after.
  async function inProduction(port: number, run: () => Promise<unknown>, extra: Record<string, string> = {}): Promise<void> {
    const saved = { ...process.env }

    Object.assign(process.env, production, { MAIL_URL: `smtp://127.0.0.1:${port}` }, extra)

    try {
      await run()
    }
    finally {
      process.env = saved
    }
  }

  it('keeps the environment\'s setup untouched without it, the greeting the sender\'s domain', async () => {
    await inProduction(server.port, async () => mailer({ queue: { name: 'smtp-none' } }).send({ to: 'bob@example.com', subject: 'Env only', text: 'Hi' }))

    expect(server.greetings.at(-1)).toBe('env.test')
  })

  it('merges its name over the environment\'s, which still sets the rest', async () => {
    await inProduction(server.port, async () => mailer({ queue: { name: 'smtp-name' }, smtp: { name: 'mail.example.com' } }).send({ to: 'bob@example.com', subject: 'Named', text: 'Hi' }))

    expect(server.greetings.at(-1)).toBe('mail.example.com')
    expect(server.received.at(-1)?.from).toBe('<site@env.test>')
  })

  it('adds only the options it names, an undefined one leaving the environment\'s name', async () => {
    await inProduction(server.port, async () => mailer({ queue: { name: 'smtp-undefined' }, smtp: { name: undefined, maxConnections: 2 } }).send({ to: 'bob@example.com', subject: 'Partial', text: 'Hi' }))

    expect(server.greetings.at(-1)).toBe('env.test')
  })

  it('keeps a sender whose domain is no valid greeting sending, with no greeting of its own', async () => {
    await inProduction(server.port, async () => mailer({ queue: { name: 'smtp-odd' } }).send({ to: 'bob@example.com', subject: 'Odd', text: 'Hi' }), { MAIL_FROM: 'site@bücher.test' })

    expect(server.received.at(-1)?.from).toContain('site@')
  })

  it('lets its rate limit replace SMTP_RATE_LIMIT', async () => {
    const started = performance.now()

    await inProduction(server.port, async () => {
      const mail = mailer({ queue: { name: 'smtp-rate' }, smtp: { rateLimit: { max: 1000, window: '1s' }, maxConnections: 1 } })

      await Promise.all([1, 2].map(async n => mail.send({ to: 'bob@example.com', subject: `Rate ${n}`, text: 'Hi' })))
    }, { SMTP_RATE_LIMIT: '1/1s' })

    expect(performance.now() - started).toBeLessThan(900)
  })

  it('caps the connections the pool opens', async () => {
    const own = startSmtp()

    try {
      await inProduction(own.port, async () => {
        const mail = mailer({ queue: { name: 'smtp-pool' }, smtp: { maxConnections: 1 } })

        await Promise.all([1, 2, 3].map(async n => mail.send({ to: 'bob@example.com', subject: `Pooled ${n}`, text: 'Hi' })))
      })

      expect(own.received).toHaveLength(3)
      expect(own.connections.opened).toBe(1)
    }
    finally {
      own.stop()
    }
  })

  it('gives up on a server staying silent after its timeout, the environment\'s default being 10 seconds', async () => {
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })

    try {
      const started = performance.now()

      await inProduction(silent.port, async () => {
        const mail = mailer({ queue: { name: 'smtp-timeout' }, smtp: { timeout: '1s' } })

        await expect(mail.send({ to: 'bob@example.com', subject: 'Slow', text: 'Hi' })).rejects.toThrow()
      })

      expect(performance.now() - started).toBeLessThan(5000)
    }
    finally {
      silent.stop(true)
    }
  })

  it('refuses a name, a timeout or a count that cannot be used where the mailer is made, whatever the environment', () => {
    expect(() => mailer({ smtp: { name: '' } })).toThrow('mailer({ smtp })\'s name is ""')
    expect(() => mailer({ smtp: { name: 'example.com\r\nMAIL FROM:<a@b.c>' } })).toThrow('mailer({ smtp })\'s name is')
    expect(() => mailer({ smtp: { name: 'two words' } })).toThrow('mailer({ smtp })\'s name is')
    expect(() => mailer({ smtp: { timeout: 0 } })).toThrow('mailer({ smtp })\'s timeout is 0; it takes a positive duration')
    expect(() => mailer({ smtp: { timeout: -5 } })).toThrow('takes a positive duration')
    expect(() => mailer({ smtp: { timeout: '-1m' as '1m' } })).toThrow('takes a positive duration')
    expect(() => mailer({ smtp: { maxConnections: 0 } })).toThrow('mailer({ smtp })\'s maxConnections is 0')
    expect(() => mailer({ smtp: { rateLimit: -1 } })).toThrow('rateLimit is -1')
    expect(() => smtp({ host: '127.0.0.1', name: ' ' })).toThrow('smtp()\'s name is')
  })

  it('refuses an explicit transport next to it, with or without the environment', async () => {
    const transport = { send: async () => ({ accepted: [], rejected: [] }) }

    expect(() => mailer({ transport, smtp: { name: 'mail.example.com' } })).toThrow('takes `smtp` or `transport`, not both')

    await inProduction(server.port, async () => {
      expect(() => mailer({ transport, smtp: { name: 'mail.example.com' }, queue: { name: 'smtp-both' } })).toThrow('not both')
    })
  })

  it('leaves an explicit transport the environment is not read for alone', async () => {
    const before = server.received.length
    const sent: string[] = []

    await inProduction(server.port, async () => {
      const mail = mailer({ transport: { send: async (m) => {
        sent.push(m.subject)

        return { accepted: [], rejected: [] }
      } }, queue: { name: 'smtp-transport' } })

      await mail.send({ to: 'bob@example.com', subject: 'Custom', text: 'Hi' })
    })

    expect(sent).toEqual(['Custom'])
    expect(server.received).toHaveLength(before)

    // Without the environment either: the transport is used as it is.
    await mailer({ transport: { send: async (m) => {
      sent.push(m.subject)

      return { accepted: [], rejected: [] }
    } }, from: 'a@b.test', queue: { name: 'smtp-transport-dev' } }).send({ to: 'bob@example.com', subject: 'No env', text: 'Hi' })
    expect(sent).toEqual(['Custom', 'No env'])
  })
})
