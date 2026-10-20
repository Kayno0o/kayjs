import { rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { scratchDir } from './scratch'

// Public text files are compressed on the fly: what a client gets, in every encoding, must not depend on how the server keeps them between requests.
const SMALL = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0 0h4v4z"/></svg>'
const sized = (size: number) => 'ab '.repeat(size).slice(0, size)
const MEDIUM = JSON.stringify({ rows: Array.from({ length: 800 }, (_, index) => ({ index, name: `row ${index}` })) })
const LARGE = 'lorem ipsum dolor sit amet\n'.repeat(40_000)

let dir: string

async function serve(options: { base?: string } = {}) {
  return pages({ routes: 'tests/fixtures/site/src/routes', publicDir: join(dir, 'public'), compress: true, log: false, ...options })
}

async function get(app: Awaited<ReturnType<typeof serve>>, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return app.handle(new Request(`http://localhost${path}`, { method, headers }))
}

async function decoded(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())

  switch (response.headers.get('content-encoding')) {
    case 'zstd':
      return new TextDecoder().decode(await Bun.zstdDecompress(bytes))
    case 'br':
      return brotliDecompressSync(bytes).toString()
    case 'gzip':
      return new TextDecoder().decode(Bun.gunzipSync(bytes))
    case null:
    default:
      return new TextDecoder().decode(bytes)
  }
}

beforeAll(async () => {
  dir = await scratchDir('public-compress-')
  await Bun.write(join(dir, 'public/small.svg'), SMALL)
  await Bun.write(join(dir, 'public/data.json'), MEDIUM)
  await Bun.write(join(dir, 'public/large.txt'), LARGE)
  await Bun.write(join(dir, 'public/under.txt'), sized(255))
  await Bun.write(join(dir, 'public/at.txt'), sized(256))
  await Bun.write(join(dir, 'public/over.txt'), sized(257))
  await Bun.write(join(dir, 'public/logo.png'), new Uint8Array(2000).fill(7))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('compressing a public text file', () => {
  it('answers each Accept-Encoding with the encoding, Vary and tag it always did', async () => {
    const app = await serve()
    const plain = await get(app, '/data.json', { 'accept-encoding': 'identity' })
    const etag = plain.headers.get('etag')

    expect(etag).toMatch(/^W\//)
    expect(await plain.text()).toBe(MEDIUM)
    expect(plain.headers.get('content-type')).toBe('application/json;charset=utf-8')
    expect(plain.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')

    for (const [accept, encoding] of [['zstd, br, gzip', 'zstd'], ['br, gzip', 'gzip'], ['br', 'br'], ['gzip', 'gzip'], ['gzip;q=0.1, br;q=0.9', 'br'], ['deflate', null], ['', null], ['identity', null]] as const) {
      const response = await get(app, '/data.json', { 'accept-encoding': accept })

      expect(response.headers.get('content-encoding'), accept).toBe(encoding)
      expect(response.headers.get('vary'), accept).toBe('accept-encoding')
      expect(response.headers.get('etag'), accept).toBe(etag)
      expect(response.headers.get('content-type'), accept).toBe('application/json;charset=utf-8')
      expect(await decoded(response), accept).toBe(MEDIUM)
    }
  })

  it('compresses a file of 256 bytes and above, not below', async () => {
    const app = await serve()

    for (const [name, size, encoding] of [['under', 255, null], ['at', 256, 'gzip'], ['over', 257, 'gzip']] as const) {
      const response = await get(app, `/${name}.txt`, { 'accept-encoding': 'gzip' })

      expect(response.headers.get('content-encoding'), name).toBe(encoding)
      expect((await decoded(response)).length, name).toBe(size)
    }
  })

  it('leaves a small file as it is, varying on the encoding only for a client that takes none', async () => {
    const app = await serve()
    const taking = await get(app, '/small.svg', { 'accept-encoding': 'zstd, br, gzip' })
    const none = await get(app, '/small.svg', { 'accept-encoding': 'identity' })

    expect(taking.headers.get('content-encoding')).toBeNull()
    expect(taking.headers.get('vary')).toBeNull()
    expect(await taking.text()).toBe(SMALL)
    expect(none.headers.get('content-encoding')).toBeNull()
    expect(none.headers.get('vary')).toBe('accept-encoding')
    expect(none.headers.get('content-type')).toBe('image/svg+xml')
    expect(await none.text()).toBe(SMALL)
  })

  it('answers HEAD with the headers and no body', async () => {
    const app = await serve()

    for (const path of ['/data.json', '/small.svg', '/large.txt']) {
      const head = await get(app, path, { 'accept-encoding': 'gzip' }, 'HEAD')
      const full = await get(app, path, { 'accept-encoding': 'identity' })

      expect(head.status, path).toBe(200)
      expect(await head.text(), path).toBe('')
      expect(head.headers.get('etag'), path).toBe(full.headers.get('etag'))
      expect(head.headers.get('content-type'), path).toBe(full.headers.get('content-type'))
    }
  })

  it('answers a Range request with the bytes asked for when the client takes no encoding', async () => {
    const server = new Elysia().use(await serve()).listen({ port: 0, hostname: '127.0.0.1' })

    try {
      const part = await fetch(`http://127.0.0.1:${server.server!.port}/data.json`, { headers: { 'range': 'bytes=0-9', 'accept-encoding': 'identity' } })

      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe(`bytes 0-9/${MEDIUM.length}`)
      expect(await part.text()).toBe(MEDIUM.slice(0, 10))
    }
    finally {
      await server.stop(true)
    }
  })

  it('answers a request with the tag it holds by 304, whatever it accepts', async () => {
    const app = await serve()
    const etag = (await get(app, '/data.json')).headers.get('etag')!

    for (const accept of ['gzip', 'zstd', 'identity']) {
      const response = await get(app, '/data.json', { 'if-none-match': etag, 'accept-encoding': accept })

      expect(response.status, accept).toBe(304)
      expect(response.headers.get('etag'), accept).toBe(etag)
      expect(response.headers.get('cache-control'), accept).toBe('public, max-age=0, must-revalidate')
      expect(await response.text(), accept).toBe('')
    }
  })

  it('serves a large file in full, compressed', async () => {
    const app = await serve()
    const response = await get(app, '/large.txt', { 'accept-encoding': 'gzip' })

    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded(response)).toBe(LARGE)
  })

  it('leaves a binary file alone', async () => {
    const app = await serve()
    const response = await get(app, '/logo.png', { 'accept-encoding': 'zstd, br, gzip' })

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('vary')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(2000).fill(7))
  })

  it('serves a public file at its path whatever the base', async () => {
    const app = await serve({ base: '/docs' })
    const response = await get(app, '/data.json', { 'accept-encoding': 'gzip' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded(response)).toBe(MEDIUM)
  })

  it('serves what a file holds after it is replaced, by size or by date', async () => {
    const path = join(dir, 'public/replaced.json')

    await writeFile(path, MEDIUM)

    const app = await serve()
    const request = async () => decoded(await get(app, '/replaced.json', { 'accept-encoding': 'zstd' }))

    expect(await request()).toBe(MEDIUM)
    expect(await request()).toBe(MEDIUM)

    const longer = `${MEDIUM}${' '.repeat(40)}`

    await writeFile(path, longer)
    expect(await request()).toBe(longer)

    const same = longer.replace('row 1"', 'row X"')

    expect(same.length).toBe(longer.length)
    await writeFile(path, same)
    await utimes(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(await request()).toBe(same)
  })

  it('reads a file once rather than on every request', async () => {
    const app = await serve()

    await get(app, '/data.json', { 'accept-encoding': 'zstd' })

    const file = spyOn(Bun, 'file')

    try {
      for (let request = 0; request < 5; request++) {
        for (const accept of ['zstd', 'gzip', 'identity'])
          expect(await decoded(await get(app, '/data.json', { 'accept-encoding': accept }))).toBe(MEDIUM)
      }

      expect(file).not.toHaveBeenCalled()
    }
    finally {
      file.mockRestore()
    }
  })
})
