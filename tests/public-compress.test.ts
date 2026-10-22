import * as fs from 'node:fs'
import { chmod, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { addRuntimeRedirect, removeRuntimeRedirect } from '../src/server/library'
import { missingPaths } from '../src/server/not-found'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

// Public text files are compressed on the fly: what a client gets, in every encoding, must not depend on how the server keeps them between requests.
const SMALL = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0 0h4v4z"/></svg>'
const sized = (size: number) => 'ab '.repeat(size).slice(0, size)
const MEDIUM = JSON.stringify({ rows: Array.from({ length: 800 }, (_, index) => ({ index, name: `row ${index}` })) })
const LARGE = 'lorem ipsum dolor sit amet\n'.repeat(40_000)

let dir: string

async function serve(options: { base?: string, dev?: boolean, trailingSlash?: 'always' | 'never', onError?: (error: unknown) => void } = {}) {
  // `prebuilt: false` is what a test run means by default, spelled out so the client build is the one shared for the file.
  return pages({ root: 'tests/fixtures/site', prebuilt: false, publicDir: join(dir, 'public'), compress: true, log: false, ...options })
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
      expect(response.headers.get('content-type'), accept).toBeNull()
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

  it('serves a file that grew past the cap and shrank back', async () => {
    const path = join(dir, 'public/grows.json')

    await writeFile(path, MEDIUM)

    const app = await serve()
    const request = async () => get(app, '/grows.json', { 'accept-encoding': 'gzip' })

    expect(await decoded(await request())).toBe(MEDIUM)
    await writeFile(path, LARGE)
    expect(await decoded(await request())).toBe(LARGE)
    await writeFile(path, MEDIUM)
    expect(await decoded(await request())).toBe(MEDIUM)
  })

  it('answers a Range request on a file the client takes compressed as it always did', async () => {
    const server = new Elysia().use(await serve()).listen({ port: 0, hostname: '127.0.0.1' })

    try {
      const part = await fetch(`http://127.0.0.1:${server.server!.port}/data.json`, { headers: { 'range': 'bytes=0-9', 'accept-encoding': 'gzip' }, decompress: false } as RequestInit)

      expect(part.status).toBe(200)
      expect(part.headers.get('content-encoding')).toBe('gzip')
    }
    finally {
      await server.stop(true)
    }
  })

  it.skipIf(process.getuid?.() === 0)('answers from memory once asked for: the file is not opened again', async () => {
    const path = join(dir, 'public/memory.json')

    await writeFile(path, MEDIUM)

    const app = await serve()
    const file = spyOn(Bun, 'file')

    expect(await decoded(await get(app, '/memory.json', { 'accept-encoding': 'zstd' }))).toBe(MEDIUM)
    await chmod(path, 0)

    try {
      for (let request = 0; request < 5; request++) {
        for (const accept of ['zstd', 'gzip', 'identity'])
          expect(await decoded(await get(app, '/memory.json', { 'accept-encoding': accept }))).toBe(MEDIUM)
      }

      expect(file).not.toHaveBeenCalled()
    }
    finally {
      file.mockRestore()
      await chmod(path, 0o644)
    }
  })
})

describe('a public file changed under a running server', () => {
  const ACCEPTS = ['br', 'identity', 'zstd, br, gzip']

  // Each file is served once first, the way a visitor met it before the deploy changed it.
  const SERVED = { 'gone.svg': SMALL.repeat(8), 'gone.json': MEDIUM, 'gone.png': new Uint8Array(2000).fill(7), 'gone.txt': LARGE } as const

  async function deleted() {
    const errors: unknown[] = []

    for (const [name, content] of Object.entries(SERVED))
      await writeFile(join(dir, 'public', name), content)

    const fresh = await serve({ onError: (error) => {
      errors.push(error)
    } })

    for (const name of Object.keys(SERVED)) {
      for (const accept of ACCEPTS)
        expect((await get(fresh, `/${name}`, { 'accept-encoding': accept })).status, name).toBe(200)
    }

    await Promise.all(Object.keys(SERVED).map(async name => rm(join(dir, 'public', name))))

    return { app: fresh, errors }
  }

  it('answers 404 for a deleted file, whatever it was served as and the client accepts', async () => {
    const { app, errors } = await deleted()

    for (const name of Object.keys(SERVED)) {
      for (const accept of ACCEPTS) {
        const response = await get(app, `/${name}`, { 'accept-encoding': accept })

        expect(response.status, `${name} ${accept}`).toBe(404)
        await response.arrayBuffer()
      }

      expect((await get(app, `/${name}`)).status, name).toBe(404)
      expect((await get(app, `/${name}`, { 'accept-encoding': 'gzip' }, 'HEAD')).status, `${name} HEAD`).toBe(404)
      expect((await get(app, `/${name}`, { 'range': 'bytes=0-9', 'accept-encoding': 'identity' })).status, `${name} range`).toBe(404)
    }

    expect(errors).toEqual([])
  })

  it('answers a deleted file with the 404 an unknown path gets', async () => {
    const { app } = await deleted()
    const unknown = await get(app, '/never-there.json', { accept: 'text/html' })
    const response = await get(app, '/gone.json', { accept: 'text/html' })

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(unknown.headers.get('content-type'))
  })

  it('answers 404 over a real connection, with no error reported', async () => {
    const { app, errors } = await deleted()
    const server = new Elysia().use(app).listen({ port: 0, hostname: '127.0.0.1' })

    try {
      for (const name of Object.keys(SERVED)) {
        for (const accept of ACCEPTS) {
          const response = await fetch(`http://127.0.0.1:${server.server!.port}/${name}`, { headers: { 'accept-encoding': accept } })

          expect(response.status, `${name} ${accept}`).toBe(404)
          await response.arrayBuffer()
        }
      }
    }
    finally {
      await server.stop(true)
    }

    expect(errors).toEqual([])
  })

  it('answers 404 for a deleted file under a base, in development and with trailing slashes', async () => {
    for (const options of [{ base: '/docs' }, { dev: true }, { trailingSlash: 'always' }] as const) {
      const path = join(dir, 'public/options.json')

      await writeFile(path, MEDIUM)

      const app = await serve(options)

      expect((await get(app, '/options.json', { 'accept-encoding': 'gzip' })).status, JSON.stringify(options)).toBe(200)
      await rm(path)

      const response = await get(app, '/options.json', { 'accept-encoding': 'gzip' })

      expect(response.status, JSON.stringify(options)).toBe(404)
      expect(await decoded(response), JSON.stringify(options)).toContain('Nothing here')
    }
  })

  it('answers Elysia\'s own 404 for a deleted file when the app has no page for an unknown path', async () => {
    const path = join(dir, 'public/bare.json')

    await writeFile(path, MEDIUM)

    const app = await pages({ routes: 'tests/fixtures/bare/src/routes', publicDir: join(dir, 'public'), compress: true, log: false, prebuilt: true })
    const unknown = await get(app, '/never-there.json')

    expect((await get(app, '/bare.json')).status).toBe(200)
    await rm(path)

    const response = await get(app, '/bare.json', { 'accept-encoding': 'gzip' })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe(await unknown.text())
  })

  it('serves a deleted file again once it is back', async () => {
    const path = join(dir, 'public/back.json')

    await writeFile(path, MEDIUM)

    const app = await serve()
    const request = async () => get(app, '/back.json', { 'accept-encoding': 'gzip' })

    expect(await decoded(await request())).toBe(MEDIUM)
    await rm(path)
    expect((await request()).status).toBe(404)
    await writeFile(path, LARGE)
    expect(await decoded(await request())).toBe(LARGE)
  })

  it('revalidates a replaced file against its new tag', async () => {
    for (const [name, first, second] of [['tag.json', MEDIUM, `${MEDIUM}${' '.repeat(40)}`], ['tag.png', new Uint8Array(2000).fill(7), new Uint8Array(2400).fill(9)]] as const) {
      const path = join(dir, 'public', name)

      await writeFile(path, first)

      const app = await serve()
      const before = await get(app, `/${name}`, { 'accept-encoding': 'identity' })
      const held = before.headers.get('etag')!

      expect((await get(app, `/${name}`, { 'if-none-match': held })).status, name).toBe(304)
      await writeFile(path, second)

      const after = await get(app, `/${name}`, { 'if-none-match': held, 'accept-encoding': 'identity' })

      expect(after.status, name).toBe(200)
      expect(after.headers.get('etag'), name).not.toBe(held)
      expect(new Uint8Array(await after.arrayBuffer()), name).toEqual(typeof second === 'string' ? new TextEncoder().encode(second) : second)
      expect((await get(app, `/${name}`, { 'if-none-match': after.headers.get('etag')! })).status, name).toBe(304)
    }
  })

  it('tags a file replaced by one of the same size by its new date', async () => {
    const path = join(dir, 'public/same.json')

    await writeFile(path, MEDIUM)

    const app = await serve()
    const held = (await get(app, '/same.json')).headers.get('etag')!

    await writeFile(path, MEDIUM.replace('row 1"', 'row X"'))
    await utimes(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect((await get(app, '/same.json', { 'if-none-match': held })).status).toBe(200)
  })

  it('keeps answering a 304 for an unchanged file', async () => {
    const app = await serve()

    for (const name of ['data.json', 'logo.png']) {
      const etag = (await get(app, `/${name}`)).headers.get('etag')!

      expect((await get(app, `/${name}`, { 'if-none-match': etag })).status, name).toBe(304)
    }
  })
})

describe('a deleted public file is a path nothing serves', () => {
  const MESSAGES = 'tests/fixtures/i18n/src/messages'

  async function served(name: string, content: string | Uint8Array, options: Parameters<typeof serve>[0] = {}) {
    const path = join(dir, 'public', name)

    await writeFile(path, content)

    const app = await serve(options)

    expect((await get(app, `/${name}`, { 'accept-encoding': 'gzip' })).status, name).toBe(200)
    await rm(path)

    return app
  }

  async function counted(path: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = missingPaths().find(row => row.path === path)

      if (found)
        return found

      await Bun.sleep(10)
    }

    throw new Error(`${path} was never counted`)
  }

  it('answers a redirect added for its path while the server runs', async () => {
    const app = await served('moved.json', MEDIUM)

    expect((await get(app, '/moved.json')).status).toBe(404)
    addRuntimeRedirect('/moved.json', '/about', { status: 301 })

    try {
      for (const headers of [{}, { 'accept-encoding': 'gzip' }, { accept: 'text/html' }]) {
        const response = await get(app, '/moved.json?utm=a', headers)

        expect([response.status, response.headers.get('location')], JSON.stringify(headers)).toEqual([301, '/about?utm=a'])
      }

      const head = await get(app, '/moved.json', {}, 'HEAD')

      expect(head.status).toBe(301)
    }
    finally {
      removeRuntimeRedirect('/moved.json')
    }

    expect((await get(app, '/moved.json')).status).toBe(404)
  })

  it('answers the redirect under a base', async () => {
    const app = await served('moved-base.json', MEDIUM, { base: '/docs' })

    addRuntimeRedirect('/moved-base.json', '/about')

    try {
      const response = await get(app, '/moved-base.json')

      expect([response.status, response.headers.get('location')]).toEqual([307, '/docs/about'])
    }
    finally {
      removeRuntimeRedirect('/moved-base.json')
    }
  })

  it('counts the visit like one to any path nothing serves', async () => {
    const app = await served('counted.json', MEDIUM)

    await get(app, '/counted.json', { referer: 'https://elsewhere.example/page' })
    expect((await counted('/counted.json')).referrers).toEqual([{ host: 'elsewhere.example', hits: 1 }])
  })

  it('is answered with the 404 page an unknown path gets, with locales', async () => {
    const path = join(dir, 'public/locale.json')

    await writeFile(path, MEDIUM)

    const app = await pages({ root: 'tests/fixtures/i18n', publicDir: join(dir, 'public'), compress: true, log: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve(MESSAGES) } })

    expect((await get(app, '/locale.json')).status).toBe(200)
    await rm(path)

    for (const language of ['en', 'fr']) {
      const unknown = await get(app, '/never-there.json', { 'accept-language': language })
      const response = await get(app, '/locale.json', { 'accept-language': language })
      const html = await response.text()

      expect(response.status, language).toBe(404)
      expect(html, language).toContain('class="missing"')
      expect(html, language).toBe((await unknown.text()).replaceAll('never-there.json', 'locale.json'))
      expect(response.headers.get('vary'), language).toBe(unknown.headers.get('vary'))
    }
  })

  it('is answered with the error page of an app that has only an _error.kay', async () => {
    const root = await scratchDir('public-gone-error-')

    await Bun.write(join(root, 'src/routes/index.kay'), 'main Home\n')
    await Bun.write(join(root, 'src/routes/_error.kay'), await Bun.file('tests/fixtures/layout-query/src/routes/_error.kay').text())
    await Bun.write(join(root, 'public/only-error.json'), MEDIUM)

    try {
      const errors: unknown[] = []
      const app = await pages({ routes: join(root, 'src/routes'), publicDir: join(root, 'public'), compress: true, log: false, prebuilt: false, onError: (error) => {
        errors.push(error)
      } })

      expect((await get(app, '/only-error.json')).status).toBe(200)
      await rm(join(root, 'public/only-error.json'))

      const unknown = await get(app, '/never-there.json', { accept: 'text/html' })
      const response = await get(app, '/only-error.json', { 'accept': 'text/html', 'accept-encoding': 'identity' })

      expect(unknown.status).toBe(404)
      expect(response.status).toBe(404)
      const html = await response.text()

      expect(html).toContain('Error 404')
      expect(html).toBe((await unknown.text()).replaceAll('never-there.json', 'only-error.json'))
      expect(errors).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers a redirect and Elysia\'s own 404 in an app with no page for an unknown path, in development and with a trailing slash setting', async () => {
    for (const options of [{}, { dev: true }, { trailingSlash: 'always' }] as const) {
      const name = `bare-${JSON.stringify(options).replaceAll(/\W/g, '')}.json`
      const path = join(dir, 'public', name)

      await writeFile(path, MEDIUM)

      const app = await pages({ routes: 'tests/fixtures/bare/src/routes', publicDir: join(dir, 'public'), compress: true, log: false, prebuilt: true, ...options })

      expect((await get(app, `/${name}`)).status, name).toBe(200)
      await rm(path)
      expect((await get(app, `/${name}`)).status, name).toBe(404)
      addRuntimeRedirect(`/${name}`, '/survey')

      try {
        for (const method of ['GET', 'HEAD']) {
          const response = await get(app, `/${name}`, { 'accept-encoding': 'gzip' }, method)

          expect([response.status, response.headers.get('location')], `${name} ${method}`).toEqual([307, options.trailingSlash === 'always' ? '/survey/' : '/survey'])
        }
      }
      finally {
        removeRuntimeRedirect(`/${name}`)
      }
    }
  })

  describe('while it is read', () => {
    // The file is gone by the time it is read, as when a deploy replaces `public/` between the request's stat and its read.
    function goneAtRead(path: string) {
      const stat = fs.statSync
      const watching = spyOn(fs, 'statSync').mockImplementation(((target: string, options: Parameters<typeof fs.statSync>[1]) => {
        const result = stat(target, options)

        if (target === path) {
          watching.mockRestore()
          fs.rmSync(path)
        }

        return result
      }) as typeof fs.statSync)

      return watching
    }

    it('answers 404, not a 500, for a file kept in memory', async () => {
      const path = join(dir, 'public/read-kept.json')

      await writeFile(path, MEDIUM)

      const errors: unknown[] = []
      const app = await serve({ onError: (error) => {
        errors.push(error)
      } })

      expect((await get(app, '/read-kept.json')).status).toBe(200)
      // Changed since it was kept, so the next request reads it again.
      await writeFile(path, `${MEDIUM} `)

      const watching = goneAtRead(path)

      try {
        const response = await get(app, '/read-kept.json', { 'accept-encoding': 'gzip' })

        expect(response.status).toBe(404)
        await response.arrayBuffer()
      }
      finally {
        watching.mockRestore()
      }

      expect((await get(app, '/read-kept.json')).status).toBe(404)
      expect(errors).toEqual([])
    })

    // The body of a file is opened after the route returned, by Bun streaming it or compression reading it, so the route cannot catch it: the server's error handler answers.
    it('answers 404, not a 500, over a real connection for a file Bun opens to stream', async () => {
      const cases = [
        ['stream.txt', LARGE, { 'accept-encoding': 'gzip' }],
        ['stream.png', new Uint8Array(2000).fill(7), {}],
        ['range.txt', LARGE, { range: 'bytes=0-9' }],
        ['identity.txt', LARGE, { 'accept-encoding': 'identity' }],
      ] as const
      const errors: unknown[] = []

      for (const [name, content] of cases)
        await writeFile(join(dir, 'public', name), content)

      const app = await serve({ onError: (error) => {
        errors.push(error)
      } })
      const server = new Elysia().use(app).listen({ port: 0, hostname: '127.0.0.1' })

      try {
        for (const [name, , headers] of cases) {
          const path = join(dir, 'public', name)

          expect((await fetch(`http://127.0.0.1:${server.server!.port}/${name}`, { headers })).status, name).toBeLessThan(300)

          const watching = goneAtRead(path)

          try {
            const response = await fetch(`http://127.0.0.1:${server.server!.port}/${name}`, { headers })

            expect(response.status, name).toBe(404)
            await response.arrayBuffer()
          }
          finally {
            watching.mockRestore()
          }
        }
      }
      finally {
        await server.stop(true)
      }

      expect(errors).toEqual([])
    })

    it('leaves the failure to the app\'s own serve.error when it has one', async () => {
      const name = 'own-error.txt'

      await writeFile(join(dir, 'public', name), LARGE)

      const app = await serve()
      const server = new Elysia({ serve: { error: () => new Response('mine', { status: 418 }) } }).use(app).listen({ port: 0, hostname: '127.0.0.1' })
      const watching = goneAtRead(join(dir, 'public', name))

      try {
        const response = await fetch(`http://127.0.0.1:${server.server!.port}/${name}`, { headers: { 'accept-encoding': 'identity' } })

        expect([response.status, await response.text()]).toEqual([418, 'mine'])
      }
      finally {
        watching.mockRestore()
        await server.stop(true)
      }
    })
  })
})
