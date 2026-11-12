import { describe, expect, it } from 'bun:test'
import { compressResponse, fixedTexts, wholeResponse } from '../src/server/compress'

const body = 'x'.repeat(2000)

async function encodingOf(type: string): Promise<string | null> {
  const request = new Request('http://localhost/x', { headers: { 'accept-encoding': 'br' } })
  const compressed = await compressResponse(request, new Response(body, { headers: { 'content-type': type } }))

  return compressed?.headers.get('content-encoding') ?? null
}

describe('compressResponse types', () => {
  it('compresses text, data, scripts, svg, fonts without their own compression and ndjson', async () => {
    for (const type of ['text/html; charset=utf-8', 'application/json', 'image/svg+xml', 'font/ttf', 'font/otf', 'application/x-ndjson', 'application/ndjson', 'application/x-ndjson; charset=utf-8', 'FONT/TTF'])
      expect(await encodingOf(type), type).toBe('br')
  })

  it('leaves already compressed formats alone', async () => {
    for (const type of ['font/woff2', 'font/woff', 'image/png', 'application/octet-stream', 'video/mp4'])
      expect(await encodingOf(type), type).toBeNull()
  })
})

describe('compressResponse on HEAD', () => {
  const html = { 'content-type': 'text/html' }
  const asked = (accept: string, method = 'GET') => new Request('http://localhost/x', { method, headers: { 'accept-encoding': accept } })
  // A body that arrives over several ticks, so it is streamed.
  const streamed = () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (let chunk = 0; chunk < 3; chunk++) {
        await Bun.sleep(5)
        controller.enqueue(new TextEncoder().encode(body))
      }

      controller.close()
    },
  }), { headers: html })

  it('names no encoding where its GET picks one only while compressing, and says Vary', async () => {
    for (const [accept, sent] of [['zstd', null], ['gzip, br', 'br'], ['gzip', 'gzip']] as const) {
      const get = (await compressResponse(asked(accept), streamed()))!
      const source = streamed()
      const head = (await compressResponse(asked(accept, 'HEAD'), source))!

      expect([accept, get.headers.get('content-encoding')]).toEqual([accept, sent])
      expect(source.bodyUsed).toBe(false)
      expect(head.headers.get('content-encoding')).toBeNull()
      expect(head.headers.get('content-length')).toBeNull()
      expect(head.headers.get('vary')).toBe('accept-encoding')
    }
  })

  it('names no encoding for a body whose GET may stay as it is, and keeps Vary', async () => {
    const make = () => new Response(body, { headers: { ...html, 'content-length': String(body.length) } })
    const head = (await compressResponse(asked('gzip', 'HEAD'), make()))!

    expect(head.headers.get('content-encoding')).toBeNull()
    expect(head.headers.get('content-length')).toBeNull()
    expect(head.headers.get('vary')).toBe('accept-encoding')
  })

  it('names gzip where a kept copy of the page decides it, as its GET sends', async () => {
    const texts = fixedTexts([`<style>${'a{color:red}'.repeat(300)}</style>`])
    const pieces = { strings: ['<html><body>', '</body></html>'], texts }
    const page = () => wholeResponse(`<html><body>${texts[0]!.bytes.toString()}</body></html>`, { headers: html }, pieces)
    const before = (await compressResponse(asked('gzip', 'HEAD'), page(), texts))!

    expect(before.headers.get('content-encoding')).toBeNull()

    const get = (await compressResponse(asked('gzip'), page(), texts))!

    expect(get.headers.get('content-encoding')).toBe('gzip')
    await get.arrayBuffer()
    // A copy is kept the second time a page is seen.
    await (await compressResponse(asked('gzip'), page(), texts))!.arrayBuffer()

    const after = (await compressResponse(asked('gzip', 'HEAD'), page(), texts))!

    expect(after.headers.get('content-encoding')).toBe('gzip')
    expect(after.headers.get('vary')).toBe(get.headers.get('vary'))
    expect(after.headers.get('content-length')).toBeNull()
    expect(after.body).toBeNull()
  })
})
