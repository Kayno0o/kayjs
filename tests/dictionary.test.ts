import { zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { compressResponse, wholeResponse } from '../src/server/compress'
import { dictionaryAsked, dictionaryLink, servedDictionary, useAsDictionary, writeDictionary } from '../src/server/dictionary'
import { scratchDir } from './scratch'

const MAGIC = Buffer.from([0x5E, 0x2A, 0x4D, 0x18, 0x20, 0, 0, 0])

// A layout's worth of markup, as a 404 page and every other page of a site share it.
const CHROME = `<nav>${Array.from({ length: 60 }, (_, i) => `<a class="link" href="/section-${i}">Section number ${i}</a>`).join('')}</nav><footer>${'Built with kay. '.repeat(20)}</footer>`
const dictionaryHtml = `<!doctype html><html lang="en"><head><title>Not found</title></head><body>${CHROME}<h1>Nothing here</h1></body></html>`
// A page of the same site: the chrome around words of its own.
const pageHtml = (topic: string) => `<!doctype html><html lang="en"><head><title>${topic}</title></head><body>${CHROME}<main>${Array.from({ length: 80 }, (_, i) => `<p>${topic} paragraph ${i} says ${(i * 2654435761 % 1e9).toString(36)}</p>`).join('')}</main></body></html>`

async function served(base = '') {
  const dir = await scratchDir('dictionary-')
  const ref = (await writeDictionary(dir, dictionaryHtml))!
  const dictionary = servedDictionary({ dir, dictionary: ref } as never, base)!

  return { dir, ref, dictionary }
}

function asking(hash: string | undefined, encoding = 'gzip, deflate, br, zstd, dcb, dcz'): Request {
  const headers: Record<string, string> = { 'accept-encoding': encoding }

  if (hash !== undefined)
    headers['available-dictionary'] = hash

  return new Request('http://localhost/page', { headers })
}

async function compress(request: Request, html = pageHtml('Topic'), dictionary?: Awaited<ReturnType<typeof served>>['dictionary'], type = 'text/html; charset=utf-8') {
  return (await compressResponse(request, wholeResponse(html, { headers: { 'content-type': type } }), undefined, undefined, dictionary))!
}

describe('dictionaries for compression', () => {
  it('writes the 404 page as a text file named by its hash, none for a page too small to help', async () => {
    const { dir, ref } = await served()
    const bytes = await Bun.file(`${dir}/${ref.file}`).bytes()

    expect(ref.file).toMatch(/^dictionary-[\da-f]{16}\.txt$/)
    expect(new TextDecoder().decode(bytes)).toBe(dictionaryHtml)
    expect(ref.hash).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('base64'))
    expect(await writeDictionary(dir, '<h1>Not found</h1>')).toBeUndefined()
  })

  it('answers a page against the dictionary to a browser holding it: the magic, the hash, then a zstd frame', async () => {
    const { dictionary, ref } = await served()
    const page = pageHtml('Topic')
    const plain = await compress(asking(undefined), page)
    const reply = await compress(asking(`:${ref.hash}:`), page, dictionary)
    const body = Buffer.from(await reply.arrayBuffer())

    expect(plain.headers.get('content-encoding')).toBe('zstd')
    expect(reply.headers.get('content-encoding')).toBe('dcz')
    expect(body.subarray(0, 8)).toEqual(MAGIC)
    expect(body.subarray(8, 40)).toEqual(Buffer.from(ref.hash, 'base64'))
    expect(zstdDecompressSync(body.subarray(40), { dictionary: Buffer.from(dictionaryHtml) }).toString()).toBe(page)
    expect(body.length).toBeLessThan(Buffer.from(await plain.arrayBuffer()).length)
    expect(reply.headers.get('vary')).toBe('accept-encoding, available-dictionary')
    expect(reply.headers.get('link')).toBe(dictionary.link)
    expect(reply.headers.get('content-length')).toBeNull()
  })

  it('answers every other request with the encoding it has today, the dictionary named all the same', async () => {
    const { dictionary, ref } = await served()
    const other = new Bun.CryptoHasher('sha256').update('another build').digest('base64')
    const cases: [string, Request][] = [
      ['no dictionary', asking(undefined)],
      ['another build\'s dictionary', asking(`:${other}:`)],
      ['dcz not accepted', asking(`:${ref.hash}:`, 'gzip, br, zstd')],
      ['dcz refused', asking(`:${ref.hash}:`, 'gzip, br, zstd, dcz;q=0')],
      ['dcz refused with decimals', asking(`:${ref.hash}:`, 'gzip, dcz;q=0.0')],
      ['only a lookalike token', asking(`:${ref.hash}:`, 'gzip, br, zstd, dcz2, xdcz')],
      ['an empty value', asking('')],
      ['a bare hash', asking(ref.hash)],
      ['the hash and more', asking(`:${ref.hash}:x`)],
      ['the hash cut short', asking(`:${ref.hash.slice(0, -2)}:`)],
      ['upper case', asking(`:${ref.hash.toUpperCase()}:`)],
      ['two hashes', asking(`:${ref.hash}:, :${other}:`)],
      ['colons alone', asking('::')],
      ['a hash in the wrong form', asking(`:${Buffer.from(ref.hash, 'base64').toString('hex')}:`)],
      ['a megabyte', asking(`:${'A'.repeat(1_000_000)}:`)],
      ['control characters', asking(`:${ref.hash.slice(0, 20)}\t${ref.hash.slice(21)}:`)],
    ]

    for (const [name, request] of cases) {
      const reply = await compress(request, pageHtml('Topic'), dictionary)

      expect(dictionaryAsked(request, ref), name).toBe(false)
      expect(reply.headers.get('content-encoding'), name).toBe(request.headers.get('accept-encoding')?.includes('zstd') ? 'zstd' : 'gzip')
      expect(reply.headers.get('link'), name).toBe(dictionary.link)
      expect(reply.headers.get('vary'), name).toContain('available-dictionary')
    }
  })

  it('takes dcz written in any case or order of the accepted encodings', () => {
    const ref = { file: 'x', hash: new Bun.CryptoHasher('sha256').update('x').digest('base64') }

    for (const accept of ['dcz', 'DCZ', 'gzip,dcz', 'dcz, gzip', 'gzip, dcz;q=0.5', 'gzip,  dcz ; q=1', 'br,dcb,dcz'])
      expect(dictionaryAsked(asking(`:${ref.hash}:`, accept), ref), accept).toBe(true)
  })

  it('leaves a response that is not a page alone, and a streamed page to the encodings that stream', async () => {
    const { dictionary, ref } = await served()
    const asked = () => asking(`:${ref.hash}:`)
    const json = await compress(asked(), JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => `row ${i}`) }), dictionary, 'application/json')

    expect(json.headers.get('content-encoding')).toBe('zstd')
    expect(json.headers.get('link')).toBeNull()
    expect(json.headers.get('vary')).toBe('accept-encoding')

    const chunks = pageHtml('Streamed').match(/.{1,4000}/gs)!
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent > 0)
          await Bun.sleep(5)

        controller.enqueue(new TextEncoder().encode(chunks[sent++]))

        if (sent === chunks.length)
          controller.close()
      },
    })
    const streamed = (await compressResponse(asked(), new Response(body, { headers: { 'content-type': 'text/html' } }), undefined, undefined, dictionary))!

    expect(streamed.headers.get('content-encoding')).toBe('br')
    expect(streamed.headers.get('link')).toBe(dictionary.link)
    expect(await streamed.arrayBuffer()).toBeInstanceOf(ArrayBuffer)
  })

  it('names the dictionary on a page too small to compress, and on none of the bodiless answers', async () => {
    const { dictionary, ref } = await served()
    const small = wholeResponse('<p>Hi</p>', { headers: { 'content-type': 'text/html' } })

    // Left alone, so the response a route made goes out with the header added to it.
    expect(compressResponse(asking(`:${ref.hash}:`), small, undefined, undefined, dictionary)).toBeUndefined()
    expect(small.headers.get('link')).toBe(dictionary.link)

    for (const status of [204, 304]) {
      const reply = compressResponse(asking(`:${ref.hash}:`), new Response(null, { status, headers: { 'content-type': 'text/html' } }), undefined, undefined, dictionary)

      expect(reply).toBeUndefined()
    }

    const response = new Response(null, { status: 304, headers: { 'content-type': 'text/html' } })

    void compressResponse(asking(`:${ref.hash}:`), response, undefined, undefined, dictionary)
    expect(response.headers.get('link')).toBeNull()
  })

  it('varies on the dictionary once, whatever case and company the page\'s own Vary keeps', async () => {
    const { dictionary, ref } = await served()

    for (const [vary, expected] of [[undefined, ['accept-encoding', 'available-dictionary']], ['cookie', ['accept-encoding', 'available-dictionary', 'cookie']], ['Accept-Encoding, Available-Dictionary', ['accept-encoding', 'available-dictionary']], ['Cookie, AVAILABLE-DICTIONARY', ['accept-encoding', 'available-dictionary', 'cookie']]] as const) {
      const response = wholeResponse(pageHtml('Vary'), { headers: { 'content-type': 'text/html', ...vary === undefined ? {} : { vary } } })
      const reply = (await compressResponse(asking(`:${ref.hash}:`), response, undefined, undefined, dictionary))!

      expect(reply.headers.get('vary')!.toLowerCase().split(', ').sort(), String(vary)).toEqual([...expected])
    }
  })

  it('compresses a page past what the tick takes on zlib\'s threads, a body repeated from the copy it kept', async () => {
    const { dictionary, ref } = await served()
    // Past the 128 KB compressed within the request's tick.
    const large = pageHtml('Large').replace('</main>', `${Array.from({ length: 9000 }, (_, i) => `<p>row ${i} ${(i * 40503 % 65521).toString(36)}</p>`).join('')}</main>`)
    const bodies: Buffer[] = []

    expect(large.length).toBeGreaterThan(128 * 1024)

    for (let time = 0; time < 3; time++) {
      const reply = await compress(asking(`:${ref.hash}:`), large, dictionary)

      expect(reply.headers.get('content-encoding')).toBe('dcz')
      bodies.push(Buffer.from(await reply.arrayBuffer()))
    }

    expect(bodies[1]!.equals(bodies[0]!)).toBe(true)
    expect(bodies[2]!.equals(bodies[0]!)).toBe(true)
    expect(zstdDecompressSync(bodies[0]!.subarray(40), { dictionary: Buffer.from(dictionaryHtml) }).toString()).toBe(large)
  })

  it('serves a late reply the way it serves the others: corked, as a stream already holding its bytes', async () => {
    const { dictionary, ref } = await served()
    const large = pageHtml('Late').replace('</main>', `${Array.from({ length: 9000 }, (_, i) => `<p>row ${i} ${(i * 40503 % 65521).toString(36)}</p>`).join('')}</main>`)
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => {
      await Bun.sleep(2)

      return compress(asking(`:${ref.hash}:`), large, dictionary)
    } })

    try {
      for (let time = 0; time < 2; time++) {
        const reply = await fetch(`http://127.0.0.1:${server.port}/`, { decompress: false })
        const body = Buffer.from(await reply.arrayBuffer())

        expect(reply.headers.get('content-encoding')).toBe('dcz')
        expect(reply.headers.get('transfer-encoding')).toBe('chunked')
        expect(zstdDecompressSync(body.subarray(40), { dictionary: Buffer.from(dictionaryHtml) }).toString()).toBe(large)
      }
    }
    finally {
      await server.stop(true)
    }
  })

  it('names the dictionary under the mount point, and matches the mount point itself with everything below it', () => {
    const ref = { file: 'dictionary-0123456789abcdef.txt', hash: '' }

    expect(dictionaryLink('', ref)).toBe('</_kay/dictionary-0123456789abcdef.txt>; rel="compression-dictionary"')
    expect(dictionaryLink('/docs', ref)).toBe('</docs/_kay/dictionary-0123456789abcdef.txt>; rel="compression-dictionary"')
    expect(useAsDictionary('')).toBe('match="/*"')
    expect(useAsDictionary('/docs')).toBe('match="/docs{/*}?"')

    const pattern = new URLPattern({ pathname: '/docs{/*}?' })

    for (const path of ['/docs', '/docs/', '/docs/a/b'])
      expect(pattern.test({ pathname: path }), path).toBe(true)

    for (const path of ['/docsx', '/', '/other/docs'])
      expect(pattern.test({ pathname: path }), path).toBe(false)
  })
})
