import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const ORIGIN = 'http://localhost'
const HEADERS = ['cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'x-permitted-cross-domain-policies']

const STREAM = 'import { api, eventStream } from \'kay/server\'\n\nexport default api().get(\'/\', () => eventStream([\'one\']))\n'
const SOCKET = 'import { api } from \'kay/server\'\n\nexport default api().ws(\'/\', { message(ws) {\n  ws.send(\'pong\')\n} })\n'

describe('the security headers on the answers that are not a page', () => {
  let app: Awaited<ReturnType<typeof pages>>
  let action: string

  // The security headers of an answer, and the policy it carries beside them.
  function secured(response: Response): void {
    for (const name of HEADERS)
      expect([name, response.headers.has(name)]).toEqual([name, true])

    expect(response.headers.get('content-security-policy')).toContain('default-src \'self\'')
    expect(response.headers.get('x-request-id')).toBeTruthy()
  }

  beforeAll(async () => {
    const dir = await fixtureCopy('answers')

    await Promise.all([Bun.write(join(dir, 'src/api/stream.ts'), STREAM), Bun.write(join(dir, 'src/api/socket.ts'), SOCKET), Bun.write(join(dir, 'public/hello.txt'), 'hello')])
    app = await pages({ root: dir, prebuilt: false, observe: { log: false } })

    const html = await (await app.handle(new Request(`${ORIGIN}/`))).text()

    action = (/<form[^>]*action="([^"]+)"/).exec(html)![1]!.replaceAll('&amp;', '&')
  })

  it('a 304 to a public file whose validator the browser sent back', async () => {
    const first = await app.handle(new Request(`${ORIGIN}/hello.txt`))
    const etag = first.headers.get('etag')

    expect(etag).toBeTruthy()

    const revalidated = await app.handle(new Request(`${ORIGIN}/hello.txt`, { headers: { 'if-none-match': etag! } }))

    expect(revalidated.status).toBe(304)
    secured(revalidated)
  })

  it('a 413 to an action post over the body limit', async () => {
    const big = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(50 * 1024 * 1024), 'origin': ORIGIN, 'referer': `${ORIGIN}/` }, body: 'title=x' }
    const refused = await app.handle(new Request(`${ORIGIN}${action}`, big))

    expect(refused.status).toBe(413)
    secured(refused)
  })

  it('an event stream, on its first bytes', async () => {
    const response = await app.handle(new Request(`${ORIGIN}/api/stream`, { headers: { accept: 'text/event-stream' } }))

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    secured(response)
    await response.body?.cancel()
  })

  it('a websocket upgrade another site asked for and was refused', async () => {
    const response = await app.handle(new Request(`${ORIGIN}/api/socket`, { headers: { 'origin': 'https://evil.example', 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', 'sec-fetch-site': 'cross-site' } }))

    expect(response.status).toBe(403)
    secured(response)
  })
})
