import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { gzipParts, splicePartAsync, splicePartText } from '../src/server/compress'
import { cutOf } from '../src/server/server-islands'

const rows = (count: number, seed: number) => Array.from({ length: count }, (_, index) => `<p class="r${(index * seed) % 97}">item ${index}</p>`).join('\n')

async function unzipped(body: Uint8Array | ReadableStream<Uint8Array>): Promise<string> {
  const bytes = body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : body

  return Buffer.from(gunzipSync(bytes)).toString()
}

describe('page parts kept deflated', () => {
  const texts = [rows(900, 3), rows(1200, 7), '', rows(800, 11), 'tail é']

  it('gunzips to the parts with the markup between them, crc and length matching', async () => {
    const parts = await Promise.all(texts.map(splicePartAsync))

    // gunzipSync checks the trailer's crc and size, so a wrong combined crc throws.
    for (const between of [['<b>a</b>', '', 'é', '<u>z</u>'], ['x'.repeat(40_000), 'k', 'k', 'k'], []])
      expect(await unzipped(await gzipParts(parts, between))).toBe(texts.map((text, index) => text + (between[index] ?? '')).join(''))

    expect(parts.map(splicePartText)).toEqual(texts)
    expect(await unzipped(await gzipParts([], []))).toBe('')
  })

  it('keeps a part by its deflated bytes only', async () => {
    const [part] = await Promise.all([splicePartAsync(rows(2000, 3))])

    expect(Object.keys(part).toSorted()).toEqual(['crc', 'deflated', 'length', 'shift'])
    expect(part.deflated.length).toBeLessThan(part.length / 4)
  })
})

describe('cutting a page', () => {
  it('does not keep a cut that failed, and makes it again for the next request', async () => {
    let reads = 0
    const html = { text: async () => {
      if (++reads === 1)
        throw new Error('page file gone')

      return '<main>page</main>'
    } }
    const page = { html } as never

    await expect(cutOf(page, false)).rejects.toThrow('page file gone')
    expect((await cutOf(page, false)).parts).toHaveLength(1)
    // The good cut stays.
    await cutOf(page, false)
    expect(reads).toBe(2)
  })
})
