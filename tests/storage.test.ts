import type { FileStore } from '../src/server'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, setSystemTime } from 'bun:test'
import { chromium } from 'playwright-core'
import { testWorker } from '../src/build/assets'
import { cacheDir } from '../src/project'
import { image } from '../src/runtime/image'
import { diskFiles, files, memoryFiles, pages, s3Files } from '../src/server'
import { linkStoredFiles, setupStorage } from '../src/server/storage'
import { browserPath, testSite } from '../src/test'
import { scratchDir } from './scratch'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const ROUTES = 'tests/fixtures/storage/src/routes'
const STATIC_FIXTURE = 'tests/fixtures/storage-static'
const hero = async (name = 'Hero.PNG') => new File([await Bun.file(HERO).arrayBuffer()], name, { type: 'image/png' })
const dir = await mkdtemp(join(tmpdir(), 'kay-storage-'))
const browser = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function serve(store: FileStore) {
  const app = await pages({ routes: ROUTES, prebuilt: false, security: false, storage: store })

  return async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('files', () => {
  it('stores a file under a new key naming its folder, its extension and an image\'s size', async () => {
    const get = await serve(diskFiles(join(dir, 'keys')))
    const key = await files.put(await hero(), { folder: 'covers/2026' })

    expect(key).toMatch(/^covers\/2026\/[\da-f]{20}\.1000x600\.png$/)
    expect(await Bun.file(join(dir, 'keys', key)).exists()).toBe(true)
    expect((await files.get(key))?.size).toBe(Bun.file(HERO).size)
    expect(await files.put(new File(['notes'], 'notes.TXT'))).toMatch(/^[\da-f]{20}\.txt$/)
    expect(await files.put(new Blob(['{}'], { type: 'application/json' }))).toMatch(/\.json$/)
    expect(await files.put(new Blob(['?']))).toMatch(/\.bin$/)
    // A file named as an image that is none gets no size.
    expect(await files.put(new File(['{}'], 'fake.png'))).toMatch(/^[\da-f]{20}\.png$/)
    expect((await get('/_kay/files/nothing.png')).status).toBe(404)
  })

  it('refuses a folder that is not plain segments or would pass for private', async () => {
    for (const folder of ['../up', 'a//b', 'private', 'private/x', 'Private', 'with space'])
      await expect(files.put(new Blob(['x']), { folder })).rejects.toThrow('files.put() was given the folder')
  })

  it('refuses keys it never gave', async () => {
    for (const key of ['../secret.txt', 'a/../b.txt', '/abs.txt', 'noextension'])
      expect(() => files.url(key)).toThrow('which is no key files.put() gives')

    await expect(files.get('../x.txt')).rejects.toThrow('files.get()')
    await expect(files.delete('../x.txt')).rejects.toThrow('files.delete()')
  })

  it('replaces a file, deleting the old one once the new one is stored', async () => {
    await serve(memoryFiles())

    const old = await files.put(new File(['one'], 'a.txt'))
    const next = await files.put(new File(['two'], 'a.txt'), { replace: old })

    expect(next).not.toBe(old)
    expect(await files.get(old)).toBeUndefined()
    expect(await (await files.get(next))!.text()).toBe('two')
    await files.delete(next)
    await files.delete(next)
    expect(await files.get(next)).toBeUndefined()
  })

  it('stores a photo without its metadata, read off its bytes whatever its name says, unless asked to keep it', async () => {
    await serve(memoryFiles())

    const jpeg = await new Bun.Image(await Bun.file(HERO).bytes()).resize(40, 24).jpeg().bytes()
    const gps = 'GPS 48.8584 N 2.2945 E'
    const xmp = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0${gps}`)
    const tagged = new Uint8Array([...jpeg.subarray(0, 2), 0xFF, 0xE1, (xmp.length + 2) >> 8, (xmp.length + 2) & 0xFF, ...xmp, ...jpeg.subarray(2)])
    const stored = async (name: string, keepMetadata?: boolean) => (await files.get(await files.put(new File([tagged], name), { keepMetadata })))!.text()

    for (const name of ['photo.jpg', 'photo.bin', 'photo.txt'])
      expect(await stored(name)).not.toContain(gps)

    expect(await stored('photo.jpg', true)).toContain(gps)
  })
})

describe('the file route', () => {
  it('serves a public file for good, with its type, and downloads one a browser would run or load as bytes of no type', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(await hero())
    const response = await get(files.url(key))

    expect(files.url(key)).toBe(`/_kay/files/${key}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe('inline')
    expect((await response.arrayBuffer()).byteLength).toBe(Bun.file(HERO).size)

    expect(response.headers.get('content-security-policy')).toBeNull()

    for (const [name, type] of [['page.html', 'application/octet-stream'], ['drawing.svg', 'image/svg+xml'], ['app.js', 'application/octet-stream'], ['theme.css', 'application/octet-stream'], ['module.mjs', 'application/octet-stream']] as const) {
      const ran = await get(files.url(await files.put(new File(['<script>alert(1)</script>'], name))))

      expect(ran.headers.get('content-type')).toBe(type)
      expect(ran.headers.get('content-disposition')).toStartWith('attachment; filename=')
      expect(ran.headers.get('content-security-policy')).toBe('sandbox')
    }
  })

  it('answers the range a player asks for', async () => {
    const get = await serve(memoryFiles())
    const url = files.url(await files.put(new File(['0123456789'], 'clip.txt')))

    expect((await get(url)).headers.get('accept-ranges')).toBe('bytes')

    const middle = await get(url, { range: 'bytes=2-5' })

    expect(middle.status).toBe(206)
    expect(middle.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await middle.text()).toBe('2345')
    expect(await (await get(url, { range: 'bytes=7-' })).text()).toBe('789')
    expect(await (await get(url, { range: 'bytes=-3' })).text()).toBe('789')
    expect((await get(url, { range: 'bytes=12-' })).status).toBe(416)
  })

  it('serves a private file only to a link it signed, until it expires', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(new File(['secret'], 'contract.pdf'), { private: true })

    expect(key).toStartWith('private/')
    expect((await get(`/_kay/files/${key}`)).status).toBe(403)
    expect((await get(`/_kay/files/${key.replace('private/', 'Private/')}`)).status).toBe(403)
    expect(files.url(key.replace('private/', 'Private/'))).toContain('sig=')

    setSystemTime(new Date('2026-06-01T12:01:00Z'))

    try {
      const url = files.url(key)
      const until = Number(new URL(url, 'http://localhost').searchParams.get('until'))

      // Rounded up, so a page rendered minutes later links the same URL.
      expect(until % 600).toBe(0)
      expect(until - Date.now() / 1000).toBeGreaterThanOrEqual(3600)
      setSystemTime(new Date('2026-06-01T12:08:00Z'))
      expect(files.url(key)).toBe(url)

      const response = await get(url)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toStartWith('private, max-age=')
      expect(await response.text()).toBe('secret')
      // Another first character, as one the signature starts with would leave it valid.
      expect((await get(url.replace(/sig=(.)/, (_, first: string) => `sig=${first === 'A' ? 'B' : 'A'}`))).status).toBe(403)
      expect((await get(url.replace(/until=\d+/, `until=${until + 600}`))).status).toBe(403)
      expect(files.url(key, { expires: '1d' })).not.toBe(url)

      setSystemTime(new Date((until + 1) * 1000))
      expect((await get(url)).status).toBe(403)
    }
    finally {
      setSystemTime()
    }
  })

  it('lets a route of the app\'s own serve a file', async () => {
    await serve(memoryFiles())

    const key = await files.put(new File(['abc'], 'a.txt'), { private: true })
    const response = await files.response(key, new Request('http://localhost/', { headers: { range: 'bytes=1-' } }))

    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
    expect((await files.response(`private/${'0'.repeat(20)}.txt`)).status).toBe(404)
  })
})

describe('stored images', () => {
  it('render as variants of the image route, sized from their key', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(await hero())
    const props = image(files.url(key))

    expect(props).toMatchObject({ width: 1000, height: 600 })
    expect(props.srcset).toContain(`/_kay/image?src=${encodeURIComponent(`/_kay/files/${key}`)}&w=320 320w`)

    const html = await (await get(`/?key=${encodeURIComponent(key)}`)).text()

    expect(html).toContain('width="1000" height="600"')
    expect(html).toContain(`srcset="/_kay/image?src=${encodeURIComponent(`/_kay/files/${key}`)}&amp;w=320 320w`)

    const variant = await get(`/_kay/image?src=${encodeURIComponent(files.url(key))}&w=320`)

    expect(variant.status).toBe(200)
    expect(variant.headers.get('content-type')).toBe('image/webp')
  })

  it('resize a private image only through a signed link, kept by no shared cache', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(await hero(), { private: true })

    expect((await get(`/_kay/image?src=${encodeURIComponent(`/_kay/files/${key}`)}&w=320`)).status).toBe(403)

    const variant = await get(`/_kay/image?src=${encodeURIComponent(files.url(key))}&w=320`)

    expect(variant.status).toBe(200)
    expect(variant.headers.get('cache-control')).toBe('private, no-cache')
  })

  it('stop resizing once deleted, the copy taken from a store off this disk included', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(await hero())
    const url = `/_kay/image?src=${encodeURIComponent(files.url(key))}&w=640`
    const variants = cacheDir(process.cwd(), `images${testWorker()}`)
    const made = async () => new Set(await readdir(variants))

    await mkdir(variants, { recursive: true })

    const before = await made()

    expect((await get(url)).status).toBe(200)
    expect([...await made()].filter(name => !before.has(name))).toEqual([expect.stringMatching(/^stored-\w+-\w+-640\.webp$/)])
    await files.delete(key)
    expect(await made()).toEqual(before)
    expect((await get(url)).status).toBe(404)
  })

  it('drop the social card drawn on a stored image once it is deleted', async () => {
    const store = memoryFiles()
    const app = await pages({ site: 'https://storage.example', routes: 'tests/fixtures/storage/src/card-routes', fonts: [{ family: 'Archivo Black', src: 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2' }], prebuilt: false, security: false, storage: store })
    const key = await files.put(await hero())
    const html = await (await app.handle(new Request(`http://localhost/?key=${encodeURIComponent(key)}`))).text()
    const card = (/<meta property="og:image" content="https:\/\/storage\.example([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&')
    const variants = cacheDir(process.cwd(), `images${testWorker()}`)
    const made = async () => new Set((await readdir(variants)).filter(name => name.endsWith('.jpg')))

    await mkdir(variants, { recursive: true })

    const before = await made()
    const drawn = await app.handle(new Request(`http://localhost${card}`))

    expect(drawn.status).toBe(200)
    expect([...await made()].filter(name => !before.has(name))).toEqual([expect.stringMatching(/^stored-\w+-card-\w+\.jpg$/)])
    await files.delete(key)
    expect(await made()).toEqual(before)
    expect((await app.handle(new Request(`http://localhost${card}`))).status).toBe(404)
  })

  it('are read in place from a store on this disk', async () => {
    const store = join(dir, 'in-place')
    const get = await serve(diskFiles(store))
    const key = await files.put(await hero())

    expect((await get(`/_kay/image?src=${encodeURIComponent(files.url(key))}&w=320`)).status).toBe(200)
    expect(await readdir(store)).toEqual([key])
  })
})

describe('a static export', () => {
  it('links files where their store serves them, or refuses to build', async () => {
    await serve(memoryFiles())

    const key = await files.put(await hero())
    const locked = await files.put(await hero(), { private: true })

    try {
      linkStoredFiles(diskFiles(join(dir, 'static')))
      expect(() => files.url(key)).toThrow('give the store a publicUrl')
      linkStoredFiles({ ...memoryFiles(), publicUrl: 'https://cdn.example/files/' })
      expect(files.url(key)).toBe(`https://cdn.example/files/${key}`)
      expect(image(files.url(key))).toEqual({ src: `https://cdn.example/files/${key}` })
      expect(() => files.url(locked)).toThrow('links private file')
    }
    finally {
      setupStorage(memoryFiles(), join(dir, 'cache'))
    }
  })

  // Wired to the config's store, which the test above has refuse a static export when on the server's disk.
  it('has kay build --static link a stored file where a CDN serves it', async () => {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', 'build', STATIC_FIXTURE, '--no-check', '--static', '--outdir', join(dir, 'export')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_TEST_FILES_URL: 'https://cdn.example/files/' } })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect([code, errors]).toEqual([0, expect.any(String)])
    expect(await Bun.file(join(dir, 'export/index.html')).text()).toContain('<img src="https://cdn.example/files/photos/0123456789abcdef0123.4x3.png" alt="Stored" loading="lazy" decoding="async">')
  }, 30_000)
})

describe('files.list', () => {
  it('gives the files of a disk store or a memory one with when they were written, those directly in a folder alone when asked, and nothing for stray files', async () => {
    for (const store of [diskFiles(join(dir, 'listed')), memoryFiles()]) {
      setupStorage(store, join(dir, 'cache'))

      const cover = await files.put(await hero(), { folder: 'covers/2026' })
      const top = await files.put(await hero(), { folder: 'covers' })
      const avatar = await files.put(await hero(), { folder: 'avatars' })
      const locked = await files.put(await hero(), { private: true })
      const keys = async (folder?: string) => (await files.list({ folder })).map(file => file.key).toSorted()

      await store.write('stray file.txt', new Blob(['x']))
      expect(await keys()).toEqual([avatar, cover, locked, top].toSorted())
      expect(await keys('covers')).toEqual([top])
      expect(await keys('covers/2026')).toEqual([cover])
      expect(await keys('covers/20')).toEqual([])

      for (const file of await files.list())
        expect(Math.abs(Date.now() - file.modified!.getTime())).toBeLessThan(60_000)
    }

    expect((await files.list()).map(file => file.key)).not.toContain('stray file.txt')
    setupStorage(memoryFiles(), join(dir, 'cache'))
  })

  it('refuses a folder files.put refuses', async () => {
    for (const folder of ['', 'a b', '../x', 'private', 'Private/x', 'covers/'])
      await expect(files.list({ folder })).rejects.toThrow('files.list() was given the folder')
  })

  it.skipIf(process.getuid?.() === 0)('skips a file whose stat fails instead of failing the listing', async () => {
    const root = await scratchDir('unreadable-')
    const store = diskFiles(root)

    await store.write('open/a.txt', new Blob(['a']))
    await store.write('shut/b.txt', new Blob(['b']))
    await chmod(join(root, 'shut'), 0o444)

    try {
      expect((await store.list?.())?.map(file => file.key)).toEqual(['open/a.txt'])
    }
    finally {
      await chmod(join(root, 'shut'), 0o755)
    }
  })

  it('lists an empty disk store that was never written to', async () => {
    setupStorage(diskFiles(join(dir, 'never-written')), join(dir, 'cache'))
    expect(await files.list()).toEqual([])
    setupStorage(memoryFiles(), join(dir, 'cache'))
  })

  it('refuses a store of the app\'s own with no list method', async () => {
    const { read, write, delete: remove } = memoryFiles()

    setupStorage({ read, write, delete: remove }, join(dir, 'cache'))
    await expect(files.list()).rejects.toThrow('needs a store with a list method')
    setupStorage(memoryFiles(), join(dir, 'cache'))
  })

  it('reads every page of a bucket\'s listing', async () => {
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const query = new URL(request.url).searchParams

        asked.push(`${query.get('prefix')}|${query.get('continuation-token')}`)

        const first = !query.has('continuation-token')

        return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${first}</IsTruncated>${first ? '<NextContinuationToken>next</NextContinuationToken>' : ''}<Contents><Key>${first ? 'photos/0123456789abcdef0123.png' : 'photos/89abcdef012345670123.png'}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified></Contents></ListBucketResult>`, { headers: { 'content-type': 'application/xml' } })
      },
    })

    try {
      setupStorage(s3Files({ bucket: 'site', endpoint: `http://localhost:${server.port}`, accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' }), join(dir, 'cache'))
      expect((await files.list({ folder: 'photos' })).map(file => file.key)).toEqual(['photos/0123456789abcdef0123.png', 'photos/89abcdef012345670123.png'])
      expect(asked).toEqual(['photos/|null', 'photos/|next'])
      expect((await files.list({ folder: 'photos' }))[0]?.modified).toEqual(new Date('2026-01-02T03:04:05.000Z'))
    }
    finally {
      setupStorage(memoryFiles(), join(dir, 'cache'))
      await server.stop(true)
    }
  })
})

describe('files.variants', () => {
  it('names the variants and cards made of a stored file, and none once it is deleted', async () => {
    const get = await serve(memoryFiles())
    const key = await files.put(await hero())
    const other = await files.put(await hero())
    const variants = cacheDir(process.cwd(), `images${testWorker()}`)

    await mkdir(variants, { recursive: true })
    expect((await files.variants([key])).get(key)).toEqual([])
    expect((await get(`/_kay/image?src=${encodeURIComponent(files.url(key))}&w=640`)).status).toBe(200)
    expect((await get(`/_kay/image?src=${encodeURIComponent(files.url(other))}&w=640`)).status).toBe(200)
    expect((await files.variants([key, other])).get(key)).toEqual([expect.stringMatching(/^stored-\w+-\w+-640\.webp$/)])
    await files.delete(key)
    expect((await files.variants([key])).get(key)).toEqual([])
    expect((await files.variants([other])).get(other)).toHaveLength(1)
    await files.delete(other)
  })
})

describe('s3Files', () => {
  it('stores, reads and deletes objects in a bucket', async () => {
    const objects = new Map<string, { body: ArrayBuffer, type: string }>()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = decodeURIComponent(new URL(request.url).pathname)
        const object = objects.get(path)

        if (request.method === 'PUT') {
          objects.set(path, { body: await request.arrayBuffer(), type: request.headers.get('content-type') ?? '' })

          return new Response(null, { headers: { etag: '"1"' } })
        }

        if (request.method === 'DELETE') {
          objects.delete(path)

          return new Response(null, { status: 204 })
        }

        if (!object)
          return new Response(request.method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', { status: 404 })

        return new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'content-type': object.type, 'content-length': String(object.body.byteLength) } })
      },
    })

    try {
      const get = await serve(s3Files({ bucket: 'site', endpoint: `http://localhost:${server.port}`, accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' }))
      const key = await files.put(await hero(), { folder: 'photos' })

      expect(objects.get(`/site/${key}`)?.type).toBe('image/png')

      const response = await get(files.url(key))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect((await response.arrayBuffer()).byteLength).toBe(Bun.file(HERO).size)
      expect((await get(`/_kay/image?src=${encodeURIComponent(files.url(key))}&w=320`)).status).toBe(200)

      await files.delete(key)
      expect(objects.size).toBe(0)
      expect(await files.get(key)).toBeUndefined()
    }
    finally {
      await server.stop(true)
    }
  })

  it('stores each object with the type and disposition its key\'s extension gives, whatever the upload declared', async () => {
    const objects = new Map<string, { type: string, disposition: string }>()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.arrayBuffer()
        objects.set(decodeURIComponent(new URL(request.url).pathname), { type: request.headers.get('content-type') ?? '', disposition: request.headers.get('content-disposition') ?? '' })

        return new Response(null, { headers: { etag: '"1"' } })
      },
    })

    try {
      const store = s3Files({ bucket: 'site', endpoint: `http://localhost:${server.port}`, accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' })
      const cases: [key: string, declared: string, type: string, disposition: string][] = [
        ['x.html', 'text/html', 'application/octet-stream', 'attachment; filename="x.html"'],
        ['X.HTML', 'text/html', 'application/octet-stream', 'attachment; filename="X.HTML"'],
        ['a.png.html', 'image/png', 'application/octet-stream', 'attachment; filename="a.png.html"'],
        ['x.png', 'text/html', 'image/png', 'inline'],
        ['X.PNG', 'text/html', 'image/png', 'inline'],
        ['a.html.png', 'text/html', 'image/png', 'inline'],
        ['x.svg', 'image/svg+xml', 'image/svg+xml', 'attachment; filename="x.svg"'],
        ['x.svg', 'text/html', 'image/svg+xml', 'attachment; filename="x.svg"'],
        ['x.js', 'text/javascript', 'application/octet-stream', 'attachment; filename="x.js"'],
        ['noextension', 'text/html', 'application/octet-stream', 'attachment; filename="noextension"'],
        ['x.txt', '', 'text/plain;charset=utf-8', 'inline'],
        ['x.pdf', 'text/html', 'application/pdf', 'inline'],
        ['private/x.html', 'text/html', 'application/octet-stream', 'attachment; filename="x.html"'],
        ['photos/x.xhtml', 'application/xhtml+xml', 'application/octet-stream', 'attachment; filename="x.xhtml"'],
      ]

      for (const [key, declared] of cases)
        await store.write(key, new Blob(['<script>alert(1)</script>'], { type: declared }))

      for (const [key, declared, type, disposition] of cases) {
        const stored = objects.get(`/site/${key}`)

        expect(stored?.type, `${key} declared ${declared}`).toBe(type)
        expect(stored?.disposition, `${key} declared ${declared}`).toBe(disposition)
      }
    }
    finally {
      await server.stop(true)
    }
  })

  it('stores a file put with a spoofed type by its extension', async () => {
    const objects = new Map<string, { type: string, disposition: string }>()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.arrayBuffer()
        objects.set(decodeURIComponent(new URL(request.url).pathname), { type: request.headers.get('content-type') ?? '', disposition: request.headers.get('content-disposition') ?? '' })

        return new Response(null, { headers: { etag: '"1"' } })
      },
    })

    try {
      setupStorage(s3Files({ bucket: 'site', endpoint: `http://localhost:${server.port}`, accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' }), join(dir, 'cache'))

      const page = await files.put(new File(['<script>alert(1)</script>'], 'Evil.HTML', { type: 'text/html' }))
      const disguised = await files.put(new File(['<script>alert(1)</script>'], 'photo.png', { type: 'text/html' }))
      const typeOnly = await files.put(new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }))

      expect(page.endsWith('.html')).toBe(true)
      expect(objects.get(`/site/${page}`)).toEqual({ type: 'application/octet-stream', disposition: expect.stringMatching(/^attachment/) })
      expect(objects.get(`/site/${disguised}`)).toEqual({ type: 'image/png', disposition: 'inline' })
      expect(objects.get(`/site/${typeOnly}`)).toEqual({ type: 'image/svg+xml', disposition: expect.stringMatching(/^attachment/) })
    }
    finally {
      await server.stop(true)
    }
  })
})

describe('kay/test', () => {
  it('keeps the files an action stores in memory, fresh for each site', async () => {
    const site = await testSite({ routes: ROUTES })
    const { upload } = await import(join(import.meta.dir, 'fixtures/storage/src/routes/index.kay')) as { upload: import('../src/runtime').Action<{ photo: File, locked?: boolean }, string> }
    const key = await site.call(upload, { photo: await hero('cat.png'), locked: true })

    expect(key).toMatch(/^private\/photos\/[\da-f]{20}\.1000x600\.png$/)
    expect((await files.get(key))?.size).toBe(Bun.file(HERO).size)

    await testSite({ routes: ROUTES })
    expect(await files.get(key)).toBeUndefined()
  })
})

describe('the upload\'s chunk', () => {
  it('loads with the first call carrying files, and fails that call alone when it cannot load, as one a deploy replaced', async () => {
    // A process of its own, where the chunk fails to load rather than staying loaded from another test.
    const child = Bun.spawn([process.execPath, 'tests/fixtures/upload/fails.ts'], { stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toEqual({ code: 0, errors: '' })
    expect(JSON.parse(output)).toEqual({
      json: { name: 'TypeError', message: 'offline' },
      loadsAfterJson: 0,
      filed: { name: 'Error', message: 'stale chunk' },
      pending: false,
      count: 0,
      called: { name: 'ApiError', message: 'stale chunk', status: 0 },
      progress: [],
      loaded: true,
    })
  })

  it('stays out of the bundle of an island calling actions', async () => {
    const dir = await scratchDir('action-bundle-')
    const entry = join(dir, 'entry.ts')

    await Bun.write(entry, `import { actionStub } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/action.ts'))}\nconsole.log(actionStub)\n`)

    const build = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true, splitting: true, outdir: join(dir, 'out') })
    const [main, ...chunks] = await Promise.all(build.outputs.filter(output => output.kind !== 'sourcemap').sort((a, b) => Number(b.kind === 'entry-point') - Number(a.kind === 'entry-point')).map(async output => output.text()))

    expect(main).not.toContain('new XMLHttpRequest')
    expect(chunks.some(chunk => chunk.includes('new XMLHttpRequest'))).toBe(true)
  })
})

describe.skipIf(browser === undefined && (process.env.CI ?? '') === '')('upload progress', () => {
  it('reports how much of a call carrying files the browser sent, then nothing once it settled', async () => {
    const site = await testSite({ routes: ROUTES, browser: { path: browser } })

    try {
      const page = await site.open('/')

      expect(await page.text('p.progress')).toBe('none')
      await page.click('button.send')
      await page.waitFor('p.key', { text: 'photos/' })

      const seen = (await page.text('p.seen'))!.split(' ').map(Number)

      expect(seen.length).toBeGreaterThan(0)
      expect(seen.at(-1)).toBe(1)
      expect(seen.every(sent => sent >= 0 && sent <= 1)).toBe(true)
      expect(await page.text('p.progress')).toBe('none')
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe('a script signing a private link', () => {
  const SECRET = 'a'.repeat(40)
  const OTHER = 'b'.repeat(40)
  const SERVER = resolve('src/server/index.ts')
  // Time stands still, so the same secret gives the same link.
  const url = (put: boolean) => `Date.now = () => 1.8e12\nimport { files } from ${JSON.stringify(SERVER)}\n${put ? 'await files.put(new File([\'x\'], \'a.txt\'))\n' : ''}console.log(files.url('private/${'0'.repeat(20)}.txt'))\n`

  async function run(script: string, env: Record<string, string>, cwd = process.cwd()): Promise<string> {
    const child = Bun.spawn([process.execPath, '-e', script], { cwd, env: { ...process.env, NODE_ENV: 'production', KAY_SECRET: '', ...env }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

    if (await child.exited !== 0)
      throw new Error(err)

    return out.trim()
  }

  it('signs with KAY_SECRET, as a server does, so another process holding it agrees', async () => {
    const [first, second, other] = await Promise.all([run(url(false), { KAY_SECRET: SECRET }), run(url(false), { KAY_SECRET: SECRET }), run(url(false), { KAY_SECRET: OTHER })])

    expect(first).toBe(second)
    expect(first).not.toBe(other)
  })

  it('signs with `secret` in the kay.config.ts beside it once the script reads its store', async () => {
    const root = await scratchDir('storage-script-')

    await Bun.write(join(root, 'kay.config.ts'), `import { memoryFiles } from ${JSON.stringify(SERVER)}\nexport default { secret: ${JSON.stringify(SECRET)}, storage: memoryFiles() }\n`)

    expect(await run(url(true), {}, root)).toBe(await run(url(false), { KAY_SECRET: SECRET }))
  })

  it('refuses a KAY_SECRET too short, as a server does', async () => {
    await expect(run(url(false), { KAY_SECRET: 'short' })).rejects.toThrow('KAY_SECRET is 5 characters long')
  })
})
