import process from 'node:process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { mailer, mailExtension } from '../src/mailer'
import { outbox } from '../src/outbox'

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

async function get(app: { handle: (request: Request) => Promise<Response> }, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`))
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
