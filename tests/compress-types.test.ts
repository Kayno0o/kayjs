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
