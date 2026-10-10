import { createHash } from 'node:crypto'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { mailer, mailExtension } from '../src/mailer'
import { outbox } from '../src/outbox'
import { startSmtp } from './helpers/smtp'

const saved = process.env.NODE_ENV

beforeAll(() => {
  process.env.NODE_ENV = 'development'
})

afterAll(() => {
  if (saved === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = saved
})

beforeEach(() => outbox.clear())

async function get(app: { handle: (request: Request) => Promise<Response> }, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, init))
}

describe('the development outbox page', () => {
  it('lists the mails sent, newest first, and shows each one\'s headers, html and text', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'First <one>', unsubscribe: 'https://example.com/unsubscribe', html: '<p>Hello <a href="https://example.com">there</a></p>' })
    await mail.send({ to: 'bob@example.com', replyTo: 'visitor@example.com', subject: 'Second', text: 'Only text' })

    const list = await (await get(mail, '/_kay/mail')).text()

    expect(list.indexOf('Second')).toBeLessThan(list.indexOf('First &lt;one&gt;'))

    const first = outbox.to('ada@example.com')[0]!
    const detail = await get(mail, `/_kay/mail/${first.id}`)
    const page = await detail.text()

    expect(detail.status).toBe(200)
    expect(page).toContain('<th>From</th><td>dev@example.com</td>')
    expect(page).toContain('<th>List-Unsubscribe</th><td>&lt;https://example.com/unsubscribe&gt;</td>')
    expect(page).toContain(`src="/_kay/mail/${first.id}/html"`)
    expect(page).toContain('<pre>Hello there (https://example.com)</pre>')
    // Its own, so a site's narrower frame-src cannot blank the mail's frame.
    expect(detail.headers.get('content-security-policy')).toContain('frame-src \'self\'')

    const html = await get(mail, `/_kay/mail/${first.id}/html`)

    expect(await html.text()).toContain('<p>Hello <a href="https://example.com">there</a></p>')
    expect(html.headers.get('content-security-policy')).toStartWith('sandbox')

    const second = await (await get(mail, `/_kay/mail/${outbox.last()!.id}`)).text()

    expect(second).toContain('<th>Reply-To</th><td>visitor@example.com</td>')
    expect(second).not.toContain('<iframe')
  })

  it('is served by an app listing the mailer as an extension, with no .use of its own', async () => {
    const mail = mailer({ from: 'dev@example.com' })
    const site = await testSite({ root: 'tests/fixture', extensions: [mailExtension(async () => mail)] })

    await mail.send({ to: 'ada@example.com', subject: 'Through the app', text: 'Hello' })

    expect((await site.visit('/_kay/mail')).html).toContain('Through the app')
  })

  it('lists the outbox as JSON, oldest first, each mail whole, for a browser test in another process', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'First', html: '<p>Hi</p>', headers: { 'X-Kind': 'welcome' }, attachments: [{ filename: 'a.bin', content: new Uint8Array([1, 2, 3]) }] })
    await mail.send({ to: 'bob@example.com', subject: 'Second', text: 'Only text' })

    const all = await (await get(mail, '/_kay/mail.json')).json() as { subject: string }[]
    const response = await get(mail, '/_kay/mail.json?to=Ada@Example.com')
    const [ada] = await response.json() as Record<string, unknown>[]

    expect(all.map(each => each.subject)).toEqual(['First', 'Second'])
    expect(response.headers.get('content-type')).toStartWith('application/json')
    expect(ada).toMatchObject({ subject: 'First', text: 'Hi', headers: { 'X-Kind': 'welcome' }, attachments: [{ filename: 'a.bin', content: 'AQID', encoding: 'base64' }] })
    expect(ada!.html).toContain('<p>Hi</p>')
  })

  it('shows a mail at phone width from the URL, and its size, warning past the html Gmail clips', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'Small', html: '<p>Hi</p>' })

    const small = outbox.last()!
    const desktop = await (await get(mail, `/_kay/mail/${small.id}`)).text()
    const phone = await (await get(mail, `/_kay/mail/${small.id}?view=phone`)).text()

    expect(desktop).toContain(`<a href="/_kay/mail/${small.id}" aria-current="page">Desktop</a>`)
    expect(desktop).not.toContain('class="phone"')
    expect(phone).toContain('<iframe class="phone"')
    expect(phone).toContain(`<a href="/_kay/mail/${small.id}?view=phone" aria-current="page">Phone</a>`)
    expect(desktop).toMatch(/<th>Size<\/th><td>[\d.]+ KB, html [\d.]+ KB<\/td>/)

    await mail.send({ to: 'ada@example.com', subject: 'Big', html: `<p>${'x'.repeat(110 * 1024)}</p>` })
    expect(await (await get(mail, `/_kay/mail/${outbox.last()!.id}`)).text()).toContain('Gmail clips it')
  })

  it('reloads the list as mails arrive, through a script its policy allows by hash and a stream of their ids', async () => {
    const mail = mailer({ from: 'dev@example.com' })
    const list = await get(mail, '/_kay/mail')
    const script = (/<script>([^<]*)<\/script>/).exec(await list.text())![1]!

    expect(list.headers.get('content-security-policy')).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`)

    const events = await get(mail, '/_kay/mail/events')
    const reader = events.body!.getReader()

    expect(events.headers.get('content-type')).toBe('text/event-stream')
    await mail.send({ to: 'ada@example.com', subject: 'Live', text: 'Hi' })
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`data: ${outbox.last()!.id}\n\n`)
    await reader.cancel()
  })

  it('clears the outbox once confirmed, from its own page only', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'One', text: 'Hi' })
    expect(await (await get(mail, '/_kay/mail?clear')).text()).toContain('<button type="submit">Clear 1 mail</button>')
    expect((await get(mail, '/_kay/mail/clear', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect(outbox.mails).toHaveLength(1)

    const cleared = await get(mail, '/_kay/mail/clear', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })

    expect(cleared.status).toBe(303)
    expect(cleared.headers.get('location')).toBe('/_kay/mail')
    expect(outbox.mails).toEqual([])
  })

  it('downloads a mail as the .eml SMTP would send', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'Raw', html: '<p>Hi</p>' })

    const raw = await get(mail, `/_kay/mail/${outbox.last()!.id}/eml`)
    const message = await raw.text()

    expect(raw.headers.get('content-type')).toBe('message/rfc822')
    expect(raw.headers.get('content-disposition')).toBe(`attachment; filename="mail-${outbox.last()!.id}.eml"`)
    expect(message).toContain('Subject: Raw')
    expect(message).toContain('To: ada@example.com')
    expect(message).toContain('multipart/alternative')
  })

  it('answers 404 for a mail no longer kept', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    expect((await get(mail, '/_kay/mail/gone')).status).toBe(404)
    expect((await get(mail, '/_kay/mail/gone/html')).status).toBe(404)
  })

  it('is left out of a server that delivers, or under bun test', async () => {
    process.env.NODE_ENV = 'test'

    try {
      expect((await get(mailer({ from: 'dev@example.com' }), '/_kay/mail')).status).toBe(404)
      expect((await get(mailer({ from: 'dev@example.com' }), '/_kay/mail.json')).status).toBe(404)
    }
    finally {
      process.env.NODE_ENV = 'development'
    }
  })
})

describe('the mail samples page', () => {
  const root = process.cwd()

  beforeAll(() => process.chdir(`${root}/tests/fixture`))
  afterAll(() => process.chdir(root))

  it('lists the app\'s mails, linked from the outbox, reloading once kay dev restarts the server', async () => {
    const mail = mailer({ from: 'dev@example.com' })
    const list = await get(mail, '/_kay/mail/samples')
    const html = await list.text()
    const script = (/<script>([^<]*)<\/script>/).exec(html)![1]!

    expect(await (await get(mail, '/_kay/mail')).text()).toContain('<a href="/_kay/mail/samples">Mail samples</a>')
    expect(html).toContain('<a href="/_kay/mail/samples?mail=welcome.kay">welcome.kay</a>')
    expect(html).toContain('<a href="/_kay/mail/samples?mail=plain.kay">plain.kay</a>')
    expect(script).toContain('/_kay/dev/events')
    expect(list.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`)
  })

  it('renders a mail as the mailer does, with the props its .preview.ts default-exports, at desktop or phone width', async () => {
    const mail = mailer({ from: 'dev@example.com' })
    const page = await (await get(mail, '/_kay/mail/samples?mail=welcome.kay&view=phone')).text()
    const frame = await get(mail, '/_kay/mail/samples/html?mail=welcome.kay')

    expect(page).toContain('<iframe class="phone" title="The mail\'s html" src="/_kay/mail/samples/html?mail=welcome.kay">')
    expect(page).toContain('Welcome, Ada')
    expect(page).toContain('<th>Props</th><td>welcome.preview.ts</td>')
    expect(await (await get(mail, '/_kay/mail/samples?mail=plain.kay')).text()).toContain('<th>Props</th><td>none, as there is no plain.preview.ts</td>')
    expect(frame.headers.get('content-security-policy')).toStartWith('sandbox')
    expect(await frame.text()).toContain('<!doctype html><html lang="en"')
    expect(outbox.mails).toEqual([])
  })

  it('says why a mail taking props without a .preview.ts did not render, and knows no file outside the mails', async () => {
    const mail = mailer({ from: 'dev@example.com' })
    const failed = await get(mail, '/_kay/mail/samples?mail=receipt.kay')

    expect(failed.status).toBe(500)
    expect(await failed.text()).toContain('receipt.preview.ts default-exports beside it')
    expect((await get(mail, '/_kay/mail/samples?mail=../server.ts')).status).toBe(404)
    expect((await get(mail, '/_kay/mail/samples/html?mail=../server.ts')).status).toBe(404)
  })
})

describe('sending a development mail for real', () => {
  const server = startSmtp()
  const root = process.cwd()

  beforeAll(() => process.chdir(`${root}/tests/fixture`))
  afterAll(() => {
    process.chdir(root)
    server.stop()
  })
  afterEach(() => {
    delete process.env.SMTP_HOST
    delete process.env.SMTP_PORT
  })

  function post(app: { handle: (request: Request) => Promise<Response> }, path: string, to: string, site = 'same-origin'): Promise<Response> {
    return get(app, path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site }, body: new URLSearchParams({ to }) })
  }

  it('names what the environment lacks instead of offering the form', async () => {
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', subject: 'Unsent', text: 'Hello' })

    const page = await (await get(mail, `/_kay/mail/${outbox.last()!.id}`)).text()

    expect(page).toContain('Set SMTP_HOST to send this mail over SMTP')
    expect(page).not.toContain('<form')
  })

  it('sends an outbox mail to the typed address alone, over the environment\'s SMTP', async () => {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port) })
    const mail = mailer({ from: 'dev@example.com' })

    await mail.send({ to: 'ada@example.com', cc: 'cc@example.com', bcc: 'bcc@example.com', subject: 'For real', text: 'Hello' })

    const { id } = outbox.last()!
    const form = await (await get(mail, `/_kay/mail/${id}`)).text()

    expect(form).toContain(`<form class="bar" method="post" action="/_kay/mail/${id}/send"><label>Over 127.0.0.1:${server.port} to <input type="email" name="to" required value=""></label>`)

    const sent = await post(mail, `/_kay/mail/${id}/send`, 'me@example.com')

    expect(sent.status).toBe(303)
    expect(sent.headers.get('location')).toBe(`/_kay/mail/${id}?sent=me%40example.com`)
    expect(server.received.at(-1)?.to).toEqual(['<me@example.com>'])
    expect(server.received.at(-1)?.data).not.toContain('cc@example.com')
    expect(await (await get(mail, sent.headers.get('location')!)).text()).toContain(`<p class="sent">Sent to me@example.com over 127.0.0.1:${server.port}.</p>`)
  })

  it('sends a sample, rendered with its preview props', async () => {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port) })
    const mail = mailer({ from: 'dev@example.com' })
    const sent = await post(mail, '/_kay/mail/samples/send?mail=welcome.kay', 'me@example.com')

    expect(sent.headers.get('location')).toBe('/_kay/mail/samples?mail=welcome.kay&sent=me%40example.com')
    expect(server.received.at(-1)?.data).toContain('Welcome, Ada')
    expect(outbox.mails).toEqual([])
  })

  it('refuses another site, an address that is not one, and says why a server refused it', async () => {
    const closed = startSmtp()

    closed.stop()
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port) })
    const mail = mailer({ from: 'dev@example.com' })
    const received = server.received.length

    await mail.send({ to: 'ada@example.com', subject: 'Guarded', text: 'Hello' })

    const { id } = outbox.last()!

    expect((await post(mail, `/_kay/mail/${id}/send`, 'me@example.com', 'cross-site')).status).toBe(403)
    expect((await post(mail, '/_kay/mail/samples/send?mail=welcome.kay', 'me@example.com', 'cross-site')).status).toBe(403)

    const several = await post(mail, `/_kay/mail/${id}/send`, 'me@example.com, you@example.com')

    expect(several.status).toBe(400)
    expect(await several.text()).toContain('Not sent: type one address to send it to')
    expect(server.received.length).toBe(received)

    process.env.SMTP_PORT = String(closed.port)
    const unreachable = mailer({ from: 'dev@example.com' })

    await unreachable.send({ to: 'ada@example.com', subject: 'Unreachable', text: 'Hello' })

    const failed = await post(unreachable, `/_kay/mail/${outbox.last()!.id}/send`, 'me@example.com')

    expect(failed.status).toBe(502)
    expect(await failed.text()).toContain('<p class="warning">Not sent: ')
  })
})
