import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import decodeAvif from '@jsquash/avif/decode.js'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages, processImage } from '../src/server'
import { sourceHash } from '../src/server/csp'
import { serveImages } from '../src/server/image'
import { savesData } from '../src/server/save-data'
import { speculationRules } from '../src/server/speculation'
import { scratchBuild } from './prerendered'

const ROUTES = 'tests/fixtures/save-data/src/routes'
const FONTS = [
  { family: 'Display', src: 'tests/fixtures/seo/src/fonts/display.woff2', weight: '100 900', preload: true },
  { family: 'Body', src: './tests/fixtures/seo/src/fonts/body-italic.woff', style: 'italic' as const, display: 'block' as const },
]
const RULES = speculationRules('moderate')
const PRELOAD = /<link[^>]*rel="preload"[^>]*as="font"[^>]*>/
const REDUCED_DATA = 'media="(prefers-reduced-data: no-preference)"'
const ON = { 'save-data': 'on' }

const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers })
const fontStyle = (html: string) => (/<style>(@font-face[^<]+)<\/style>/).exec(html)![1]!

// The body as the browser reads it, past the encoding the server's compression gave it.
async function textOf(response: Response): Promise<string> {
  const bytes = await response.bytes()
  const encoding = response.headers.get('content-encoding')

  if (encoding === 'gzip')
    return new TextDecoder().decode(gunzipSync(bytes))

  return encoding === 'br' ? new TextDecoder().decode(brotliDecompressSync(bytes)) : new TextDecoder().decode(bytes)
}

const varies = (response: Response) => (response.headers.get('vary') ?? '').split(',').map(name => name.trim().toLowerCase())

// Boots the site, which builds the browser bundle and manifest the prerendered pages are served with.
beforeAll(async () => {
  await pages({ routes: ROUTES, prebuilt: false })
}, 60_000)

afterAll(async () => {
  Reflect.deleteProperty(globalThis, 'location')
})

describe('Save-Data header', () => {
  it.each([
    ['on', true],
    ['ON', true],
    [' on ', true],
    ['off', false],
    ['', false],
    ['on, off', false],
    ['onward', false],
  ])('reads %p as saving: %p', (value, saving) => {
    expect(savesData(request('/', { 'save-data': value }))).toBe(saving)
  })

  it('reads an absent header as not saving', () => {
    expect(savesData(request('/'))).toBe(false)
  })
})

// A page `kay build` rendered and the one rendered on the request go through different code, and both must answer both kinds of visitor.
describe.each([
  ['rendered on the request', 'request'],
  ['prerendered', 'prerendered'],
] as const)('a page %s', (_name, kind) => {
  const served = async (config: Record<string, unknown> = {}) => {
    const options = { routes: ROUTES, fonts: FONTS, security: { csp: { 'style-src': ['\'self\''] } }, ...config }

    if (kind === 'request')
      return { app: await pages({ ...options, prebuilt: false }), remove: async () => undefined }

    const build = await scratchBuild()

    await build.prerender(options)

    return { app: await build.serve(options), remove: build.remove }
  }

  it('leaves out the font preloads and the speculation rules for a visitor saving data, with the fonts shown only from the cache', async () => {
    const { app, remove } = await served()

    try {
      const saving = await app.handle(request('/about', ON))
      const html = await saving.text()

      expect(saving.status).toBe(200)
      expect(html).not.toMatch(PRELOAD)
      expect(html).not.toContain('speculationrules')
      expect(fontStyle(html)).toMatch(/font-display:optional\}@font-face\{font-family:"Body"[^}]*font-display:optional\}/)
      expect(fontStyle(html)).not.toMatch(/font-display:(?:swap|block)/)
      expect(html).toContain('<h1')
    }
    finally {
      await remove()
    }
  })

  it.each([
    ['off', { 'save-data': 'off' }],
    ['absent', {}],
  ])('keeps them, behind a media query for prefers-reduced-data, with Save-Data %s', async (_name, headers) => {
    const { app, remove } = await served()

    try {
      const html = await (await app.handle(request('/about', headers))).text()

      expect(html).toMatch(PRELOAD)
      expect(PRELOAD.exec(html)![0]).toContain(REDUCED_DATA)
      expect(html).toContain(RULES)
      expect(fontStyle(html)).toContain('font-display:swap')
      expect(fontStyle(html)).toContain('font-display:block')
      expect(html).not.toContain('kay-save-data')
    }
    finally {
      await remove()
    }
  })

  it('tells caches the page varies on Save-Data, on the light answer and the full one alike', async () => {
    const { app, remove } = await served()

    try {
      const [saving, full] = await Promise.all([app.handle(request('/about', ON)), app.handle(request('/about'))])

      expect(varies(saving)).toContain('save-data')
      expect(varies(full)).toContain('save-data')
      expect(await saving.text()).not.toBe(await full.text())
    }
    finally {
      await remove()
    }
  })

  it('lets the light stylesheet through a strict style-src by its hash', async () => {
    const { app, remove } = await served()

    try {
      const saving = await app.handle(request('/about', ON))
      const policy = saving.headers.get('content-security-policy')!
      const light = fontStyle(await saving.text())
      const full = fontStyle(await (await app.handle(request('/about'))).text())

      expect(policy).toContain(sourceHash(light))
      expect(policy).toContain(sourceHash(full))
    }
    finally {
      await remove()
    }
  })

  it('names the rules of a site under a mount point only for the visitors who get them', async () => {
    const { app, remove } = await served({ base: '/docs' })

    try {
      const path = '/about'
      const full = await (await app.handle(request(path))).text()
      const saving = await (await app.handle(request(path, ON))).text()

      expect(full).toContain(speculationRules('moderate', '/docs'))
      expect(saving).not.toContain('speculationrules')
      expect(saving).not.toMatch(PRELOAD)
    }
    finally {
      await remove()
    }
  })

  it('serves both kinds of visitor again and again from the same page', async () => {
    const { app, remove } = await served()

    try {
      const bodies: string[] = []

      for (const headers of [ON, {}, ON, {}, { 'save-data': 'off' }, ON])
        bodies.push(await (await app.handle(request('/about', headers))).text())

      expect(bodies.map(html => PRELOAD.test(html))).toEqual([false, true, false, true, true, false])
      expect(bodies[0]).toBe(bodies[2])
      expect(bodies[1]).toBe(bodies[3])
    }
    finally {
      await remove()
    }
  })

  it('answers everyone alike with saveData off, varying on nothing', async () => {
    const { app, remove } = await served({ saveData: false })

    try {
      const saving = await app.handle(request('/about', ON))
      const html = await saving.text()

      expect(html).toMatch(PRELOAD)
      expect(PRELOAD.exec(html)![0]).not.toContain('prefers-reduced-data')
      expect(html).toContain(RULES)
      expect(fontStyle(html)).toContain('font-display:swap')
      expect(varies(saving)).not.toContain('save-data')
      expect(html).toContain('<meta name="kay-save-data" content="off">')
    }
    finally {
      await remove()
    }
  })

  it('leaves a page with no fonts and no speculation rules unvaried', async () => {
    const { app, remove } = await served({ fonts: undefined, prefetch: false })

    try {
      const saving = await app.handle(request('/about', ON))

      expect(varies(saving)).not.toContain('save-data')
      expect(await saving.text()).toContain('<h1')
    }
    finally {
      await remove()
    }
  })
})

describe('a prerendered page', () => {
  it('gives a visitor saving data an uncompressed copy of its own while the others keep the compressed ones', async () => {
    const build = await scratchBuild()
    const options = { routes: ROUTES, fonts: FONTS }

    try {
      await build.prerender(options)

      // The compressed copies `kay build` writes beside each page.
      const file = join(build.pages, 'about.html')
      const page = await Bun.file(file).text()

      await Bun.write(`${file}.br`, brotliCompressSync(page))
      await Bun.write(`${file}.gz`, gzipSync(page))

      const app = await build.serve({ ...options, compress: true })
      const full = await app.handle(request('/about', { 'accept-encoding': 'br, gzip' }))
      const saving = await app.handle(request('/about', { ...ON, 'accept-encoding': 'br, gzip' }))

      expect(full.headers.get('content-encoding')).toBe('br')
      expect(PRELOAD.test(await textOf(full))).toBe(true)
      expect(PRELOAD.test(await textOf(saving))).toBe(false)
      expect(saving.headers.get('etag')).toMatch(/-sd"$/)

      const again = await app.handle(request('/about', { ...ON, 'if-none-match': saving.headers.get('etag')! }))

      expect(again.status).toBe(304)
      expect((await app.handle(request('/about', { 'if-none-match': saving.headers.get('etag')! }))).status).toBe(200)
    }
    finally {
      await build.remove()
    }
  })
})

describe('a prerendered page with server islands', () => {
  it('is spliced plain for a visitor saving data, its head lightened', async () => {
    const routes = 'tests/fixtures/server-islands/src/routes'
    const build = await scratchBuild()
    const options = { routes, fonts: FONTS }

    try {
      await build.prerender(options)

      const app = await build.serve({ ...options, compress: true })
      const full = await app.handle(request('/', { 'accept-encoding': 'gzip' }))
      const saving = await app.handle(request('/', { ...ON, 'accept-encoding': 'gzip' }))
      const html = await textOf(saving)

      expect(PRELOAD.test(await textOf(full))).toBe(true)
      expect(html).not.toMatch(PRELOAD)
      expect(html).not.toContain('speculationrules')
      expect(html).toContain('<!--kay-server:1-->')
      expect(varies(saving)).toContain('save-data')
    }
    finally {
      await build.remove()
    }
  })
})

describe('the image route', () => {
  const dir = mkdtemp(join(tmpdir(), 'kay-save-data-'))
  const hero = join(import.meta.dir, 'fixtures/images/src/hero.png')
  const route = async (file = 'hero.png', options: { saveData?: false, avif?: number } = {}) => {
    const root = await dir
    const cache = join(root, 'cache')
    const app = new Elysia()

    serveImages(app, { clientDir: join(root, 'client'), cacheDir: cache, dirs: { '/uploads/': root }, ...options })

    return async (path: string, headers: Record<string, string> = {}) => app.handle(request(`/_kay/image?src=${encodeURIComponent(`/uploads/${file}`)}&${path}`, headers))
  }
  const widthOf = async (response: Response) => (await new Bun.Image(await response.bytes()).metadata()).width

  afterAll(async () => rm(await dir, { recursive: true, force: true }))

  it('answers the next width down of the ladder to a visitor saving data, and the width asked to the others', async () => {
    await Bun.write(join(await dir, 'hero.png'), Bun.file(hero))

    const get = await route()
    const saving = await get('w=960', ON)

    expect(await widthOf(saving)).toBe(640)
    expect(await widthOf(await get('w=960'))).toBe(960)
    expect(await widthOf(await get('w=960', { 'save-data': 'off' }))).toBe(960)
    expect(varies(saving)).toContain('save-data')
    expect(varies(await get('w=960'))).toContain('save-data')
  })

  it('answers the same URL right for each visitor in turn, from the kept answer too', async () => {
    const get = await route()
    const widths: (number | undefined)[] = []

    for (const headers of [ON, {}, ON, {}, ON])
      widths.push(await widthOf(await get('w=640', headers)))

    expect(widths).toEqual([320, 640, 320, 640, 320])
  })

  it('keeps the narrowest width of the ladder as it is', async () => {
    const get = await route()

    expect(await widthOf(await get('w=320', ON))).toBe(320)
  })

  it('takes the image\'s own width, between two steps of the ladder, down to the step below it', async () => {
    await Bun.write(join(await dir, 'between.png'), (await processImage(Bun.file(hero), { width: 500, height: 300, fit: 'cover' })).bytes)

    const get = await route('between.png')

    expect(await widthOf(await get('w=500'))).toBe(500)
    expect(await widthOf(await get('w=500', ON))).toBe(320)
  })

  it('takes the image\'s own width, narrower than the ladder, down a third', async () => {
    await Bun.write(join(await dir, 'small.png'), (await processImage(Bun.file(hero), { width: 200, height: 120, fit: 'cover' })).bytes)

    const get = await route('small.png')

    expect(await widthOf(await get('w=200', ON))).toBe(128)
  })

  it('goes one step down below the ladder too, for an image drawn at a fixed width', async () => {
    const get = await route()

    expect(await widthOf(await get('w=96', ON))).toBe(64)
    expect(await widthOf(await get('w=288', ON))).toBe(192)
    expect(await widthOf(await get('w=96'))).toBe(96)
  })

  it('keeps the crop and the quality asked for', async () => {
    const get = await route()
    const saving = await new Bun.Image(await (await get('w=960&crop=16x9&q=60', ON)).bytes()).metadata()

    expect([saving.width, saving.height]).toEqual([640, 360])
  })

  it('refuses a width it refuses to others', async () => {
    const get = await route()

    expect((await get('w=961', ON)).status).toBe(400)
  })

  it('varies on Accept and Save-Data together with AVIF on, an ETag of its own for each answer', async () => {
    const get = await route('hero.png', { avif: 50 })
    const [saving, full] = [await get('w=640', { ...ON, accept: 'image/avif' }), await get('w=640', { accept: 'image/avif' })]

    expect(varies(saving)).toEqual(['accept', 'save-data'])
    expect(saving.headers.get('content-type')).toBe('image/avif')
    expect((await decodeAvif((await saving.bytes()).buffer))!.width).toBe(320)
    expect((await decodeAvif((await full.bytes()).buffer))!.width).toBe(640)
  })

  it('gives a runtime image a different ETag for its narrower answer, which a conditional request matches only for its own', async () => {
    const get = await route()
    const [saving, full] = [await get('w=640', ON), await get('w=640')]

    expect(saving.headers.get('etag')).not.toBe(full.headers.get('etag'))
    expect((await get('w=640', { ...ON, 'if-none-match': saving.headers.get('etag')! })).status).toBe(304)
    expect((await get('w=640', { 'if-none-match': saving.headers.get('etag')! })).status).toBe(200)
  })

  it('leaves a share card alone', async () => {
    const get = await route()
    const card = await get('card', ON)

    expect(card.status).toBe(200)
    expect(varies(card)).not.toContain('save-data')
  })

  it('answers the width asked with saveData off, varying on nothing', async () => {
    const get = await route('hero.png', { saveData: false })
    const response = await get('w=960', ON)

    expect(await widthOf(response)).toBe(960)
    expect(varies(response)).not.toContain('save-data')
  })
})
