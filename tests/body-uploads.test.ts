import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const MB = 1024 * 1024
const APP = 'https://app.example.com'
const site = await testSite({ root: 'tests/fixtures/body-uploads', islands: false })
const overridden = await testSite({ root: 'tests/fixtures/body-uploads', islands: false, cors: { origins: [APP] }, maxSizes: { '/api/uploads': '8mb' } })
const lowered = await testSite({ root: 'tests/fixtures/body-uploads', islands: false, maxSizes: { '/api/uploads': '1kb' } })

afterAll(async () => {
  await Promise.all([site, overridden, lowered].map(async open => open.close()))
})

async function upload(bytes: number, on: typeof site = site, headers: Record<string, string> = {}): Promise<Response> {
  const form = new FormData()

  form.append('file', new File([new Uint8Array(bytes)], 'photo.bin'))

  return on.fetch('/api/uploads', { method: 'POST', body: form, headers })
}

describe('a module raising its body limit above the app\'s', () => {
  it('takes an upload over 1 MB and refuses one over its own limit', async () => {
    const taken = await upload(3 * MB)

    expect(taken.status).toBe(200)
    expect(await taken.json()).toEqual({ size: 3 * MB })
    expect((await upload(6 * MB)).status).toBe(413)
  })
})

describe('a maxSizes entry at the path of an API module', () => {
  it('wins over the module\'s own maxSize, raising or lowering it', async () => {
    expect((await upload(6 * MB, overridden)).status).toBe(200)
    expect((await upload(9 * MB, overridden)).status).toBe(413)
    expect((await upload(3 * MB, lowered)).status).toBe(413)
  })

  it('keeps the module\'s cors grant on its 413', async () => {
    const refused = await upload(9 * MB, overridden, { origin: APP })

    expect(refused.status).toBe(413)
    expect(refused.headers.get('access-control-allow-origin')).toBe(APP)
  })
})
