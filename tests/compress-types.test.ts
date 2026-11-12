import { describe, expect, it } from 'bun:test'
import { compressResponse } from '../src/server/compress'

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
  it('names the encoding and Vary its GET does, with no length, and reads nothing', async () => {
    const make = () => new Response(body, { headers: { 'content-type': 'text/html', 'content-length': String(body.length) } })
    const headers = { 'accept-encoding': 'gzip' }
    const get = (await compressResponse(new Request('http://localhost/x', { headers }), make()))!
    const source = make()
    const head = (await compressResponse(new Request('http://localhost/x', { method: 'HEAD', headers }), source))!

    expect(source.bodyUsed).toBe(false)
    expect(head.body).toBeNull()
    expect(head.headers.get('content-length')).toBeNull()

    for (const name of ['content-encoding', 'vary', 'content-type'])
      expect([name, head.headers.get(name)]).toEqual([name, get.headers.get(name)])
  })

  it('leaves a HEAD alone when its GET would not be compressed, naming Vary', async () => {
    const small = new Response('tiny', { headers: { 'content-type': 'text/html', 'content-length': '4' } })

    expect(await compressResponse(new Request('http://localhost/x', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }), small)).toBeUndefined()
    expect(await compressResponse(new Request('http://localhost/x', { method: 'HEAD' }), new Response(body, { headers: { 'content-type': 'text/html', 'content-length': '2000' } }))).toBeUndefined()
  })
})
