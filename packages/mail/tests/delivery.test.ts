import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { deliveryAddress } from '../src/delivery'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'
import { logged } from './fixture/tests/logged'
import { startSmtp } from './helpers/smtp'

// As `kay dev` runs the server: NODE_ENV=development with its change code, in the fixture app's folder, where the switch is kept under `.kay`.
const saved = process.env.NODE_ENV
const root = process.cwd()
const server = startSmtp()
const closed = startSmtp()
const SWITCH = join(root, 'tests/fixture/.kay/mail-delivery.json')

closed.stop()

beforeAll(() => {
  process.env.NODE_ENV = 'development'
  process.env.KAY_DEV_CODE = '0'
  process.chdir(`${root}/tests/fixture`)
})

afterAll(() => {
  process.chdir(root)
  delete process.env.KAY_DEV_CODE
  server.stop()

  if (saved === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = saved
})

beforeEach(() => {
  outbox.clear()
  Object.assign(process.env, { MAIL_URL: `smtp://127.0.0.1:${server.port}`, MAIL_INSECURE: 'true' })
})

afterEach(async () => {
  await rm(SWITCH, { force: true })

  for (const name of ['MAIL_URL', 'MAIL_INSECURE'])
    delete process.env[name]

  process.env.NODE_ENV = 'development'
  process.env.KAY_DEV_CODE = '0'
})

type App = ReturnType<typeof mailer>

async function request(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, init))
}

async function toggle(app: App, to: string, site = 'same-origin'): Promise<Response> {
  return request(app, '/_kay/mail/delivery', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify({ to }) })
}

const mail = (subject: string) => ({ to: 'ada@example.com', cc: 'cc@example.com', bcc: 'bcc@example.com', subject, text: 'Hello' })

describe('the "Send for real" switch', () => {
  it('delivers nothing while it is off, a mail sent or queued only reaching the outbox', async () => {
    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const received = server.received.length

    await app.send(mail('Sent'))
    await app.enqueue(mail('Queued'))
    await app.drain()

    expect(outbox.mails.map(each => each.subject)).toEqual(['Sent', 'Queued'])
    expect(outbox.mails.every(each => each.relayed === undefined)).toBe(true)
    expect(server.received.length).toBe(received)
    expect(await (await request(app, '/_kay/mail/delivery')).json()).toMatchObject({ on: false, missing: [] })
  })

  it('delivers each mail sent or queued to the typed address alone, keeping it in the outbox marked as delivered', async () => {
    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const turned = await toggle(app, 'me@example.com')

    expect(await turned.json()).toMatchObject({ on: true, to: 'me@example.com', server: `127.0.0.1:${server.port}` })

    const received = server.received.length

    await app.send(mail('Sent'))
    await app.enqueue(mail('Queued'))
    await app.drain()

    const delivered = server.received.slice(received)

    expect(delivered).toHaveLength(2)

    for (const each of delivered) {
      expect(each.to).toEqual(['<me@example.com>'])
      expect(each.data).not.toContain('Cc:')
      expect(each.data).not.toContain('ada@example.com')
    }

    expect(outbox.mails.map(each => each.relayed)).toEqual([{ to: 'me@example.com', error: undefined }, { to: 'me@example.com', error: undefined }])
    expect(outbox.mails[0]!.to).toEqual(['ada@example.com'])

    const page = await (await request(app, `/_kay/mail/${outbox.mails[0]!.id}`)).text()
    const listed = await (await request(app, '/_kay/mail.json')).json() as { relayed?: object }[]

    expect(page).toContain('<th>Delivered</th><td>for real, to me@example.com alone</td>')
    expect(listed[0]!.relayed).toEqual({ to: 'me@example.com' })
  })

  it('delivers a mail carrying its own To, Cc and Bcc headers to the typed address alone', async () => {
    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    await toggle(app, 'me@example.com')

    const received = server.received.length

    await app.send({ ...mail('Hostile'), headers: { To: 'victim@example.com', Cc: 'victim@example.com', Bcc: 'victim@example.com' } })
    expect(server.received.slice(received).map(each => each.to)).toEqual([['<me@example.com>']])
  })

  it('keeps the mail in the outbox with the SMTP error when the server cannot be reached, and sends no error to the caller', async () => {
    process.env.MAIL_URL = `smtp://127.0.0.1:${closed.port}`

    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    await toggle(app, 'me@example.com')
    await app.send(mail('Unreachable'))

    const kept = outbox.last()!

    expect(kept.relayed?.to).toBe('me@example.com')
    expect(kept.relayed?.error).toBeString()
    expect(await (await request(app, `/_kay/mail/${kept.id}`)).text()).toContain('not delivered to me@example.com: ')
  })

  it('stays on across a restart of the server, kept under .kay until turned off', async () => {
    await toggle(mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } }), 'me@example.com')
    expect(JSON.parse(await Bun.file(SWITCH).text())).toEqual({ to: 'me@example.com' })

    const restarted = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const received = server.received.length

    expect(await (await request(restarted, '/_kay/mail/delivery')).json()).toMatchObject({ on: true, to: 'me@example.com' })
    await restarted.send(mail('After a restart'))
    expect(server.received).toHaveLength(received + 1)

    const off = await toggle(restarted, '')

    expect(await off.json()).toMatchObject({ on: false })
    expect(existsSync(SWITCH)).toBe(false)
    await restarted.send(mail('Once off'))
    expect(server.received).toHaveLength(received + 1)
  })

  it('names the SMTP variables missing and delivers nothing without them, whatever the file says', async () => {
    delete process.env.MAIL_URL

    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const state = await (await request(app, '/_kay/mail/delivery')).json() as { on: boolean, missing: string[] }

    expect(state).toMatchObject({ on: false, missing: ['MAIL_URL'] })

    const refused = await toggle(app, 'me@example.com')

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('MAIL_URL')
    expect(existsSync(SWITCH)).toBe(false)

    await Bun.write(SWITCH, JSON.stringify({ to: 'me@example.com' }))

    const received = server.received.length

    await app.send(mail('Nowhere to go'))
    expect(outbox.last()!.relayed).toBeUndefined()
    expect(server.received.length).toBe(received)
    expect(await (await request(app, '/_kay/mail/delivery')).json()).toMatchObject({ on: false, missing: ['MAIL_URL'] })
  })

  it('logs once that settings it cannot read stop the delivery, the mail still reaching the outbox', async () => {
    process.env.MAIL_URL = `smtp://user@127.0.0.1:${server.port}`

    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    await Bun.write(SWITCH, JSON.stringify({ to: 'me@example.com' }))

    const lines = await logged(async () => {
      await app.send(mail('First'))
      await app.send(mail('Second'))
    })

    expect(outbox.mails.map(each => [each.subject, each.relayed])).toEqual([['First', undefined], ['Second', undefined]])
    expect(lines.filter(([level]) => level === 'warn')).toEqual([['warn', expect.stringContaining('the "Send for real" switch is on, but the SMTP settings could not be read, so no mail is delivered to me@example.com: kay: the login in MAIL_URL needs a user and a password')]])
  })

  it('refuses a post from another site, an address that is not one, and several addresses', async () => {
    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    expect((await toggle(app, 'me@example.com', 'cross-site')).status).toBe(403)
    expect((await toggle(app, 'me@example.com', 'same-site')).status).toBe(403)
    expect((await request(app, '/_kay/mail/delivery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'me@example.com' }) })).status).toBe(403)
    expect(existsSync(SWITCH)).toBe(false)
    expect((await toggle(app, 'not an address')).status).toBe(400)
    expect((await toggle(app, 'me@example.com, you@example.com')).status).toBe(400)
    expect((await toggle(app, 'Me <me@example.com>')).status).toBe(400)
    expect(existsSync(SWITCH)).toBe(false)

    await toggle(app, 'me@example.com')
    expect((await toggle(app, '', 'cross-site')).status).toBe(403)
    expect(existsSync(SWITCH)).toBe(true)
  })

  it('is read by the server kay dev runs alone, never under test, in production or outside kay dev', async () => {
    await Bun.write(SWITCH, JSON.stringify({ to: 'me@example.com' }))
    expect(await deliveryAddress()).toBe('me@example.com')

    for (const env of ['test', 'production']) {
      process.env.NODE_ENV = env
      expect(await deliveryAddress()).toBeUndefined()
    }

    process.env.NODE_ENV = 'test'

    const underTest = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const received = server.received.length

    await underTest.send(mail('Under test'))
    expect(outbox.last()!.relayed).toBeUndefined()
    expect(server.received.length).toBe(received)
    expect((await toggle(underTest, 'you@example.com')).status).toBe(409)
    expect(JSON.parse(await Bun.file(SWITCH).text())).toEqual({ to: 'me@example.com' })

    process.env.NODE_ENV = 'development'
    delete process.env.KAY_DEV_CODE
    expect(await deliveryAddress()).toBeUndefined()

    const outside = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    await outside.send(mail('Outside kay dev'))
    expect(outbox.last()!.relayed).toBeUndefined()
    expect(server.received.length).toBe(received)
  })

  it('ignores a file edited into something that is no address', async () => {
    for (const content of ['{"to":"a@b.c, d@e.f"}', '{"to":5}', 'not json', '{}']) {
      await Bun.write(SWITCH, content)
      expect(await deliveryAddress()).toBeUndefined()
    }
  })
})

describe('the templates', () => {
  it('lists every mail under src/mails, each opening its sample', async () => {
    const app = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })
    const files = await (await request(app, '/_kay/mail/samples.json')).json() as string[]

    expect(files).toContain('welcome.kay')
    expect(files).toContain('plain.kay')
    expect((await request(app, `/_kay/mail/samples?mail=${encodeURIComponent(files[0]!)}`)).status).toBeLessThan(500)
    expect(outbox.mails).toEqual([])
  })
})
