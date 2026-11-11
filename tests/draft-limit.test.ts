import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { previewUrl } from '../src/server/preview'

const SECRET = 'a'.repeat(40)
const COOKIE = /kay_preview=([^;]+)/

describe('/_kay/draft', () => {
  it('answers 429 with Retry-After to an editor past 300 drafts a minute, and an outsider is refused before it counts', async () => {
    const app = await pages({ root: 'tests/fixtures/production', prebuilt: false, preview: { secret: SECRET } })
    const link = await app.handle(new Request(`http://localhost${previewUrl('/', { edit: true })}`))
    const cookie = `kay_preview=${COOKIE.exec(link.headers.get('set-cookie') ?? '')![1]}`
    const post = async (headers: Record<string, string>) => app.handle(new Request('http://localhost/_kay/draft', { method: 'POST', headers, body: '{}' }))

    for (let outsider = 0; outsider < 301; outsider++)
      expect((await post({})).status).toBe(403)

    for (let draft = 0; draft < 300; draft++)
      expect((await post({ cookie })).status).toBe(400)

    const over = await post({ cookie })

    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
