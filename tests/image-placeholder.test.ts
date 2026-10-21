import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { kay } from '../src/build/plugin'
import { image as setImage } from '../src/runtime/dom-image'
import { image, registerImage, setPlaceholders } from '../src/runtime/image'
import { learnedVersion, learnPlaceholder, placeholderColor, registerPlaceholder } from '../src/runtime/placeholder'
import { dominantColor, dominantColorOf } from '../src/server/image-color'
import { encodePng } from '../src/server/png'
import { allowsStyleAttributes } from '../src/server/security'
import { countColorReads } from './color-reads'
import { gif } from './gif'
import { fixtureCopy, scratchDir } from './scratch'
import { pages } from './shared-pages'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')

// A PNG of one color, or of one color at `alpha` with `corner` pixels cleared.
function flat(red: number, green: number, blue: number, { alpha = 255, width = 64, height = 48, clear = 0 } = {}): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)

  for (let index = 0; index < width * height; index++)
    pixels.set([red, green, blue, index < clear ? 0 : alpha], index * 4)

  return encodePng(pixels, width, height)
}

function channels(color: string | undefined): number[] {
  return [0, 2, 4].map(at => Number.parseInt(color!.slice(at, at + 2), 16))
}

function near(color: string | undefined, expected: number[], tolerance = 4): void {
  expect(color).toMatch(/^[0-9a-f]{6}$/)

  for (const [index, value] of channels(color).entries())
    expect(Math.abs(value - expected[index]!)).toBeLessThanOrEqual(tolerance)
}

describe('dominantColor', () => {
  it('gives the mean color of an opaque image as six hex digits, in any format Bun.Image reads', async () => {
    const png = flat(200, 100, 50)

    expect(await dominantColor(png)).toBe('c86432')
    near(await dominantColor(await new Bun.Image(png).jpeg({ quality: 90 }).bytes()), [200, 100, 50])
    near(await dominantColor(await new Bun.Image(png).webp({ quality: 90 }).bytes()), [200, 100, 50])
  })

  it('averages a gradient and an image of two halves', async () => {
    const pixels = new Uint8Array(64 * 48 * 4)

    for (let index = 0; index < 64 * 48; index++)
      pixels.set(index % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], index * 4)

    near(await dominantColor(encodePng(pixels, 64, 48)), [128, 0, 128], 6)
  })

  it('gives none for an image with any transparency, whatever its format, and one for an image with an alpha channel that is opaque', async () => {
    expect(await dominantColor(flat(200, 100, 50, { alpha: 120 }))).toBeUndefined()
    // A whole row cleared, as the corner of a rounded logo is.
    expect(await dominantColor(flat(200, 100, 50, { clear: 64 * 4 }))).toBeUndefined()
    expect(await dominantColor(await new Bun.Image(flat(200, 100, 50, { alpha: 120 })).webp({ quality: 90 }).bytes())).toBeUndefined()
    expect(await dominantColor(Bun.file(HERO))).toBeUndefined()
    expect(await dominantColor(gif(40, 30, [3], 3))).toBeUndefined()
    near(await dominantColor(gif(40, 30, [3])), [6, 249, 128])
    expect(await dominantColor(flat(10, 20, 30))).toBe('0a141e')
  })

  it('gives none for what it cannot read or may not decode', async () => {
    expect(await dominantColor(new TextEncoder().encode('not an image'))).toBeUndefined()
    expect(await dominantColor(flat(1, 2, 3, { width: 100, height: 100 }), 50)).toBeUndefined()
  })
})

describe('dominantColorOf', () => {
  it('keeps a color on disk while the file holds, and reads it from there in another process', async () => {
    const dir = await scratchDir('color-')
    const file = join(dir, 'photo.png')
    const cache = join(dir, 'cache')

    await Bun.write(file, flat(200, 100, 50))
    expect(await dominantColorOf(file, cache)).toBe('c86432')

    const slot = (await readdir(cache)).find(name => name.endsWith('-color.json'))!
    const kept = await Bun.file(join(cache, slot)).json() as { key: string, value: string }

    expect(kept.value).toBe('c86432')

    // A second process starts with no memo: the entry on disk answers, whatever the file decodes to.
    await Bun.write(join(cache, slot), JSON.stringify({ ...kept, value: 'abcdef' }))

    const reader = join(dir, 'read.ts')

    await Bun.write(reader, `import { dominantColorOf } from ${JSON.stringify(join(import.meta.dir, '../src/server/image-color'))}\nconsole.log(await dominantColorOf(${JSON.stringify(file)}, ${JSON.stringify(cache)}))`)

    const run = Bun.spawn([process.execPath, reader], { stdout: 'pipe' })

    expect((await new Response(run.stdout).text()).trim()).toBe('abcdef')
  })

  it('keeps none for a transparent image and reads again when the file changes', async () => {
    const dir = await scratchDir('color-')
    const file = join(dir, 'clear.png')
    const cache = join(dir, 'cache')

    await Bun.write(file, flat(200, 100, 50, { alpha: 100 }))
    expect(await dominantColorOf(file, cache)).toBeUndefined()

    const slot = (await readdir(cache)).find(name => name.endsWith('-color.json'))!

    expect((await Bun.file(join(cache, slot)).json() as { value: unknown }).value).toBeNull()
    await Bun.write(file, flat(10, 20, 30, { width: 32, height: 32 }))
    expect(await dominantColorOf(file, cache)).toBe('0a141e')
  })
})

describe('allowsStyleAttributes', () => {
  const self = '\'self\''
  const inline = '\'unsafe-inline\''

  it('allows them by default and where style-src, style-src-attr or default-src keeps unsafe-inline', () => {
    expect(allowsStyleAttributes(undefined)).toBe(true)
    expect(allowsStyleAttributes(false)).toBe(true)
    expect(allowsStyleAttributes({ 'style-src': [self, inline, 'https://fonts.example'] })).toBe(true)
    expect(allowsStyleAttributes({ 'style-src-attr': [inline], 'style-src': [self] })).toBe(true)
    expect(allowsStyleAttributes({ 'default-src': [self, inline], 'style-src': false })).toBe(true)
  })

  it('refuses them where the first style directive set lacks unsafe-inline or carries a nonce or a hash', () => {
    expect(allowsStyleAttributes({ 'style-src': [self] })).toBe(false)
    expect(allowsStyleAttributes({ 'style-src-attr': ['\'none\''] })).toBe(false)
    expect(allowsStyleAttributes({ 'style-src': [self, '\'nonce-abc\'', inline] })).toBe(false)
    expect(allowsStyleAttributes({ 'style-src': [self, inline, '\'sha256-abc\''] })).toBe(false)
    expect(allowsStyleAttributes({ 'default-src': [self], 'style-src': false })).toBe(false)
  })

  it('reads the report-only policy too, over the enforced one or over kay\'s defaults', () => {
    expect(allowsStyleAttributes(undefined, { 'style-src': [self] })).toBe(false)
    expect(allowsStyleAttributes(false, { 'style-src-attr': ['\'none\''] })).toBe(false)
    expect(allowsStyleAttributes(false, { 'img-src': [self] })).toBe(true)
    expect(allowsStyleAttributes({ 'style-src': [self, inline] }, { 'img-src': [self] })).toBe(true)
  })
})

describe('image() placeholder', () => {
  afterAll(() => setPlaceholders(undefined))

  it('adds a background color to what image() gives for an image with a color, and nothing without the server asking', () => {
    const url = registerImage('/_kay/assets/solo-1.png', 640, 480)

    registerPlaceholder(url, '336699')
    setPlaceholders(undefined)
    expect(image(url)).not.toHaveProperty('style')
    setPlaceholders(src => src === url ? '336699' : undefined)
    expect(image(url).style).toBe('background-color:#336699')
    expect(image(url, { placeholder: false })).not.toHaveProperty('style')
    expect(image('/uploads/a.jpg', { width: 640, height: 480 })).not.toHaveProperty('style')
    expect(image(registerImage('/_kay/assets/plain-2.png', 640, 480))).not.toHaveProperty('style')
  })

  it('registers nothing for a value that is no color, so a hostile one cannot reach the style', () => {
    registerPlaceholder('/_kay/assets/hostile-3.png', 'red;background:url(//evil)')
    registerPlaceholder('/_kay/assets/hostile-3.png', 'ABCDEF')
    expect(placeholderColor('/_kay/assets/hostile-3.png')).toBeUndefined()
    learnPlaceholder('/uploads/x.png', 'v1', 'zzzzzz')
    expect(placeholderColor('/uploads/x.png')).toBeUndefined()
    learnPlaceholder('/uploads/x.png', 'v2', '00ff00')
    expect(placeholderColor('/uploads/x.png')).toBe('00ff00')
    expect(learnedVersion('/uploads/x.png')).toBe('v2')
  })
})

describe('images.placeholder: false', () => {
  const photo = async (color: number) => {
    const root = resolve(await scratchDir('colors-off-'))

    await Bun.write(join(root, 'src/photo.png'), flat(color, 100, 50))

    return root
  }

  it('reads no image for its color in a bundle, and reads it for a bundle that does not opt out', async () => {
    const root = await photo(201)
    const entry = join(root, 'src/entry.ts')

    await Bun.write(entry, 'import photo from \'./photo.png\'\nconsole.log(photo)\n')

    const reads = countColorReads()

    try {
      const bundle = async (placeholder?: false) => (await Bun.build({ entrypoints: [entry], target: 'bun', plugins: [kay({ target: 'ssr', root, placeholder })] })).outputs[0]!.text()
      const off = await bundle(false)

      expect(reads.count()).toBe(0)
      expect(off).not.toContain('registerPlaceholder')
      expect(await bundle()).toContain('"c96432"')
      expect(reads.count()).toBe(1)
    }
    finally {
      reads.restore()
    }
  })

  it('reads none through the loader of a project whose config sets it, and one through a project that does not', async () => {
    const run = async (config: string, color: number) => {
      const root = await photo(color)
      const script = join(root, 'load.ts')

      await Bun.write(join(root, 'kay.config.ts'), config)
      await Bun.write(script, `import { join } from 'node:path'\nimport { placeholderColor } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/placeholder'))}\nimport { registerLoader } from ${JSON.stringify(join(import.meta.dir, '../src/server/loader'))}\nimport { countColorReads } from ${JSON.stringify(join(import.meta.dir, 'color-reads'))}\nconst reads = countColorReads()\nawait registerLoader(${JSON.stringify(root)})\nconst { default: url } = await import(join(${JSON.stringify(root)}, 'src/photo.png'))\nconsole.log(JSON.stringify({ reads: reads.count(), color: placeholderColor(url) ?? null }))\n`)

      const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: 'pipe', stderr: 'inherit' })

      return JSON.parse(await new Response(child.stdout).text()) as { reads: number, color: string | null }
    }

    expect(await run('export default { images: { placeholder: false } }\n', 202)).toEqual({ reads: 0, color: null })
    expect(await run('export default {}\n', 203)).toEqual({ reads: 1, color: 'cb6432' })
  })
})

describe('placeholder on a page', () => {
  let dir: string
  let uploads: string

  const render = async (app: Elysia, path = '/') => (await app.handle(new Request(`http://localhost${path}`))).text()
  // The img carrying a class.
  const img = (html: string, name: string) => new RegExp(`<img [^>]*class="${name}"[^>]*>`).exec(html)?.[0]

  async function open(options: Record<string, unknown> = {}): Promise<Elysia> {
    return pages({ routes: join(dir, 'src/routes'), prebuilt: false, images: { dirs: { '/uploads/': uploads } }, ...options })
  }

  beforeAll(async () => {
    dir = await fixtureCopy('image-placeholder')
    uploads = join(dir, 'uploads')
    await mkdir(uploads)

    const orange = flat(200, 100, 50)

    await Promise.all([
      Bun.write(join(dir, 'src/photo.png'), orange),
      Bun.write(join(dir, 'src/photo.jpg'), await new Bun.Image(orange).jpeg({ quality: 95 }).bytes()),
      Bun.write(join(dir, 'src/clear.png'), flat(200, 100, 50, { clear: 64 * 4 })),
      Bun.write(join(dir, 'src/motion.gif'), gif(40, 30, [3, 90])),
      Bun.write(join(dir, 'src/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c86432"/></svg>'),
      Bun.write(join(uploads, 'photo.png'), orange),
    ])
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('colors the box of an imported image until it loads, whether it is an img src or image() spread, with no script', async () => {
    const html = await render(await open())
    const style = 'style="background-color:#c86432"'

    expect(img(html, 'photo')).toContain(style)
    expect(img(html, 'spread')).toContain(style)
    expect(img(html, 'sized')).toContain(style)
    near((/background-color:#(\w{6})/).exec(img(html, 'jpeg')!)?.[1], [200, 100, 50])
    // A few dozen bytes: the attribute and its value.
    expect(style.length).toBeLessThan(40)
    expect(html).not.toContain('onload')
  })

  it('leaves a transparent image, an SVG and an animated GIF without one, so nothing shows behind them', async () => {
    const html = await render(await open())

    for (const name of ['clear', 'motion', 'icon'])
      expect(img(html, name)).not.toContain('style=')
  })

  it('is turned off by the attribute, by the option, by an image\'s own style, and by images.placeholder: false', async () => {
    const html = await render(await open())

    expect(img(html, 'off')).not.toContain('style=')
    expect(img(html, 'off')).not.toContain('placeholder')
    expect(img(html, 'optout')).not.toContain('style=')
    expect(img(html, 'styled')).toContain('style="border: 0"')
    expect(img(html, 'styled')!.match(/style=/g)).toHaveLength(1)
    expect(img(html, 'styledspread')!.match(/style=/g)).toHaveLength(1)
    expect(img(html, 'styledspread')).toContain('style="border: 0"')

    for (const [name, style] of [['stylefirst', 'border: 0'], ['dynamicfirst', 'margin: 0']]) {
      expect(img(html, name!)!.match(/style=/g)).toHaveLength(1)
      expect(img(html, name!)).toContain(`style="${style}"`)
    }

    const off = await render(await open({ images: { dirs: { '/uploads/': uploads }, placeholder: false } }))

    expect(off).not.toContain('background-color')
  })

  it('writes the same under a base path', async () => {
    const mounted = await render(new Elysia().use(await open({ base: '/docs' })))

    expect(img(mounted, 'photo')).toContain('style="background-color:#c86432"')
    expect(img(mounted, 'photo')).toContain('src="/docs/_kay/image?')
  })

  it('leaves the color out where the site CSP refuses inline styles', async () => {
    expect(await render(await open({ security: { csp: { 'style-src': ['\'self\''] } } }))).not.toContain('background-color')
    expect(await render(await open({ security: { reportOnly: { 'style-src': ['\'self\''] } } }))).not.toContain('background-color')
  })

  it('writes the color in development', async () => {
    expect(await render(await open({ dev: true }))).toContain('background-color:#c86432')
  })

  it('gives an image added at runtime its color once the route has read it, and again when the file changes', async () => {
    const app = await open()
    const route = async () => app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=64`))
    const settled = async (expected: string | undefined) => {
      for (let tries = 0; tries < 100; tries++) {
        if ((/background-color:#(\w{6})/).exec(img(await render(app), 'upload') ?? '')?.[1] === expected)
          return true

        await Bun.sleep(20)
      }

      return false
    }

    expect(img(await render(app), 'upload')).not.toContain('style=')
    expect((await route()).status).toBe(200)
    expect(await settled('c86432')).toBe(true)

    await Bun.write(join(uploads, 'photo.png'), flat(10, 20, 30))
    expect((await route()).status).toBe(200)
    expect(await settled('0a141e')).toBe(true)

    // Transparent now: none again.
    await Bun.write(join(uploads, 'photo.png'), flat(10, 20, 30, { alpha: 100 }))
    expect((await route()).status).toBe(200)
    expect(await settled(undefined)).toBe(true)
  })

  it('reads the color of a remote image once the route has downloaded it, and of a private one never', async () => {
    const host = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(join(dir, 'src/photo.png')), { headers: { 'content-type': 'image/png' } }) })
    const remote = `http://127.0.0.1:${host.port}/photos/a.png`

    try {
      const app = await open({ images: { dirs: { '/uploads/': uploads }, remote: [`http://127.0.0.1:${host.port}/photos/`], resolve: () => join(dir, 'src/photo.png') } })
      const ask = async (src: string) => app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent(src)}&w=64`))

      expect(image(remote, { width: 64, height: 48 }).style).toBeUndefined()
      expect((await ask(remote)).status).toBe(200)
      expect((await ask('/media/7')).status).toBe(200)

      for (let tries = 0; tries < 100 && image(remote, { width: 64, height: 48 }).style === undefined; tries++)
        await Bun.sleep(20)

      expect(image(remote, { width: 64, height: 48 }).style).toBe('background-color:#c86432')
      await Bun.sleep(100)
      // What `images.resolve` looks up may be private to the visitor, so its color is never put in a page.
      expect(image('/media/7', { width: 64, height: 48 }).style).toBeUndefined()
    }
    finally {
      await host.stop(true)
    }
  })

  it('carries the color in the server bundle, which an executable embeds, and not in the islands\' bundle', async () => {
    const root = resolve(dir)
    const entry = join(root, 'src/entry.ts')

    await Bun.write(entry, 'import photo from \'./photo.png\'\nimport motion from \'./motion.gif\'\nimport clear from \'./clear.png\'\nconsole.log(photo, motion, clear)\n')

    const bundle = async (target: 'ssr' | 'dom') => ((await Bun.build({ entrypoints: [entry], target: target === 'ssr' ? 'bun' : 'browser', plugins: [kay({ target, root })] })).outputs[0]!.text())
    const server = await bundle('ssr')
    const browser = await bundle('dom')

    expect(server).toMatch(/"c86432"/)
    expect(server.match(/"[\da-f]{6}"/g)).toEqual(['"c86432"'])
    expect(browser).not.toContain('c86432')
    expect(browser).not.toContain('registerPlaceholder')
    expect(browser).toContain('/_kay/assets/photo-')
  })

  it('keeps the colors out of what islands download', async () => {
    const code = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/runtime/dom-image.ts')], target: 'browser', minify: true, define: { KAY_BROWSER: 'true' } })
    const text = await code.outputs[0]!.text()

    expect(text).not.toContain('background-color')
    expect(text).not.toContain('registerPlaceholder')
  })

  it('leaves the style the server wrote on an img an island hydrates', () => {
    const written: string[] = []
    const element = { localName: 'img', setAttribute: (name: string) => written.push(name), removeAttribute: (name: string) => written.push(`-${name}`) } as unknown as Element

    setPlaceholders(placeholderColor)
    registerPlaceholder(registerImage('/_kay/assets/island-9.png', 640, 480), '336699')
    setImage(element, '/_kay/assets/island-9.png', false)
    setPlaceholders(undefined)
    expect(written).toContain('srcset')
    expect(written.filter(name => name.endsWith('style'))).toEqual([])
  })
})
