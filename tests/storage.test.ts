import type { FileStore } from '../src/server'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, setSystemTime } from 'bun:test'
import { chromium } from 'playwright-core'
import { image } from '../src/runtime/image'
import { diskFiles, files, memoryFiles, pages, s3Files } from '../src/server'
import { linkStoredFiles, setupStorage } from '../src/server/storage'
import { browserPath, testSite } from '../src/test'

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
    for (const folder of ['../up', 'a//b', 'private', 'private/x', 'with space'])
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
})

describe('the file route', () => {
  it('serves a public file for good, with its type, and downloads one a browser would run', async () => {
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

    for (const name of ['page.html', 'drawing.svg']) {
      const ran = await get(files.url(await files.put(new File(['<script>alert(1)</script>'], name))))

      expect(ran.headers.get('content-disposition')).toStartWith('attachment; filename=')
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
      expect((await get(url.replace(/sig=./, 'sig=A'))).status).toBe(403)
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

    expect((await get(url)).status).toBe(200)
    await files.delete(key)
    expect((await get(url)).status).toBe(404)
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

  it('fails kay build --static on a page linking a file of the server\'s disk, and links one a CDN serves there', async () => {
    const build = async (env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, 'src/cli.ts', 'build', STATIC_FIXTURE, '--no-check', '--static', '--outdir', join(dir, 'export')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      return { code, errors }
    }

    const refused = await build({})

    expect(refused.code).toBe(1)
    expect(refused.errors).toContain('a static export links stored file photos/0123456789abcdef0123.4x3.png')
    expect((await build({ KAY_TEST_FILES_URL: 'https://cdn.example/files/' })).code).toBe(0)
    expect(await Bun.file(join(dir, 'export/index.html')).text()).toContain('<img src="https://cdn.example/files/photos/0123456789abcdef0123.4x3.png" alt="Stored">')
  }, 30_000)
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
