import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const MB = 1024 * 1024
const site = await testSite({ root: 'tests/fixtures/body-uploads', islands: false })

afterAll(site.close)

async function upload(bytes: number): Promise<Response> {
  const form = new FormData()

  form.append('file', new File([new Uint8Array(bytes)], 'photo.bin'))

  return site.fetch('/api/uploads', { method: 'POST', body: form })
}

describe('a module raising its body limit above the app\'s', () => {
  it('takes an upload over 1 MB and refuses one over its own limit', async () => {
    const taken = await upload(3 * MB)

    expect(taken.status).toBe(200)
    expect(await taken.json()).toEqual({ size: 3 * MB })
    expect((await upload(6 * MB)).status).toBe(413)
  })
})
