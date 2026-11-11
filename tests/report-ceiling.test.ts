import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'

const SEO = 'tests/fixtures/seo'

describe('the anonymous report sinks', () => {
  it('answer 429 once all clients together pass 600 CSP reports a minute, each client being far under its own limit', async () => {
    const app = await pages({ requireGuards: false, root: SEO, prebuilt: false, security: { reports: true }, proxy: { header: 'x-real-ip' } })
    const post = async (address: string) => (await app.handle(new Request('http://localhost/_kay/csp', { method: 'POST', headers: { 'content-type': 'application/reports+json', 'x-real-ip': address }, body: '[]' }))).status

    for (let client = 0; client < 600; client++)
      expect(await post(`10.1.${Math.floor(client / 250)}.${client % 250 + 1}`)).toBe(204)

    expect(await post('10.2.0.1')).toBe(429)
  })

  it('answer 429 once all clients together pass 600 error reports a minute', async () => {
    const app = await pages({ requireGuards: false, root: SEO, prebuilt: false, observe: { onError: () => undefined }, proxy: { header: 'x-real-ip' } })
    const post = async (address: string) => (await app.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': address }, body: '{}' }))).status

    for (let client = 0; client < 600; client++)
      expect(await post(`10.1.${Math.floor(client / 250)}.${client % 250 + 1}`)).not.toBe(429)

    expect(await post('10.2.0.1')).toBe(429)
  })
})
