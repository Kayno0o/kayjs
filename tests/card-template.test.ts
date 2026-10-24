import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { clientDir, outputDir } from '../src/build/assets'
import { setCardMaker, setRemoteImages, shareCard } from '../src/runtime/image'
import { runInLocale } from '../src/runtime/locale-state'
import { pages } from '../src/server'
import { serveCards, setupCards } from '../src/server/card'
import { answer, imageRoute, MAX_QUEUED, setCardShotLimit, shootCard, templateStamp } from '../src/server/card-template'
import { decodePng } from '../src/server/crop'
import * as browserModule from '../src/test/browser'
import { browserPath } from '../src/test/browser'
import { listeningPort } from './listening'
import { fixtureCopy, scratchDir } from './scratch'

const FIXTURE = resolve('tests/fixtures/card-template')
const CLI = resolve('src/cli.ts')
const CARD = join(FIXTURE, 'src/routes/_card.kay')
const chrome = browserPath() !== undefined

// The RGB of a pixel of a JPEG.
async function pixelsOf(jpeg: Uint8Array): Promise<(x: number, y: number) => number[]> {
  const png = decodePng(await new Bun.Image(jpeg).png().bytes())

  return (x, y) => [...png.rows[y]!.subarray(x * png.bpp, x * png.bpp + 3)]
}

function near(pixel: number[], expected: number[]): boolean {
  return pixel.every((channel, index) => Math.abs(channel - expected[index]!) < 28)
}

// Whether any pixel of the box is nearly white, which the title is drawn in.
async function hasTitle(jpeg: Uint8Array): Promise<boolean> {
  const pixel = await pixelsOf(jpeg)

  for (let y = 380; y < 520; y += 2) {
    for (let x = 460; x < 1100; x += 2) {
      if (pixel(x, y).every(channel => channel > 235))
        return true
    }
  }

  return false
}

async function expectTemplateCard(jpeg: Uint8Array, image: boolean): Promise<void> {
  expect(await new Bun.Image(jpeg).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })

  const pixel = await pixelsOf(jpeg)

  // The template's own Tailwind background, and the image it was given on the left.
  expect(near(pixel(1150, 30), [30, 64, 175])).toBe(true)
  expect(near(pixel(160, 160), [15, 159, 89])).toBe(image)
  // The image the template imports and shows itself, through the image route.
  expect(near(pixel(950, 70), [15, 159, 89])).toBe(true)
  expect(await hasTitle(jpeg)).toBe(true)
}

describe('the share card template stamp', () => {
  it('changes with the template, a component it imports, however deep, and the stylesheet built of them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))

    try {
      await Bun.write(join(dir, 'deep.kay'), 'p one')
      await Bun.write(join(dir, 'middle.kay'), '---\nimport Deep from \'./deep.kay\'\n---\nDeep')
      await Bun.write(join(dir, '_card.kay'), '---\nimport Middle from \'./middle.kay\'\n---\nMiddle')

      const stamp = templateStamp(join(dir, '_card.kay'), '/_kay/assets/app-1.css')

      expect(templateStamp(join(dir, '_card.kay'), '/_kay/assets/app-1.css')).toBe(stamp)
      expect(templateStamp(join(dir, '_card.kay'), '/_kay/assets/app-2.css')).not.toBe(stamp)
      await Bun.write(join(dir, 'deep.kay'), 'p two')
      expect(templateStamp(join(dir, '_card.kay'), '/_kay/assets/app-1.css')).not.toBe(stamp)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('changes with a .ts helper the template reaches, however deep, and with the fonts, but not with a package or the framework', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))

    try {
      await Bun.write(join(dir, 'src/hero.png'), 'one')
      await Bun.write(join(dir, 'src/lib/deep.ts'), 'export const deep = 1')
      await Bun.write(join(dir, 'src/lib/helper.ts'), 'import { deep } from \'./deep\'\nexport const helper = deep')
      await Bun.write(join(dir, 'src/routes/_card.kay'), '---\nimport { helper } from \'../lib/helper\'\nimport { Elysia } from \'elysia\'\nimport { shareCard } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\np {helper}')

      const file = join(dir, 'src/routes/_card.kay')
      const stamp = templateStamp(file, undefined, 'a{}', dir)

      expect(templateStamp(file, undefined, 'a{}', dir)).toBe(stamp)
      expect(templateStamp(file, undefined, 'b{}', dir)).not.toBe(stamp)
      await Bun.write(join(dir, 'src/lib/deep.ts'), 'export const deep = 2')

      const changed = templateStamp(file, undefined, 'a{}', dir)

      expect(changed).not.toBe(stamp)
      // The image the template imports, replaced in place.
      await Bun.write(join(dir, 'src/hero.png'), 'two')
      expect(templateStamp(file, undefined, 'a{}', dir)).not.toBe(changed)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renames the cards of a changed template, and keeps the fixed layout\'s look without one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))
    const looks: string[] = []

    try {
      for (const template of [undefined, { file: CARD, styles: 'one.css' }, { file: CARD, styles: 'two.css' }])
        looks.push((await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template })).look)

      expect(new Set(looks).size).toBe(3)

      const font = (css: string) => ({ css, preload: [] })

      looks.push((await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: font('a{}'), template: { file: CARD, styles: undefined } })).look, (await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: font('b{}'), template: { file: CARD, styles: undefined } })).look)
      expect(new Set(looks).size).toBe(5)
      expect((await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined })).look).toBe(looks[0]!)

      // The variants a template's images are served as, named by the aspects and AVIF the app sets; the fixed layout draws none.
      const template = { file: CARD, styles: undefined }
      const variants = async (setup: Partial<Parameters<typeof setupCards>[0]>) => (await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, ...setup })).look
      const plain = await variants({ template })

      expect(await variants({ template, variants: { aspects: ['2/1'] } })).not.toBe(plain)
      expect(await variants({ template, variants: { avif: { quality: 40 } } })).not.toBe(plain)
      expect(await variants({ variants: { aspects: ['2/1'] } })).toBe(looks[0]!)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes any image kay can draw a card on for a template, and draws with no font of the config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))

    try {
      await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template: { file: CARD, styles: undefined } })

      expect(shareCard({ title: 'Hello' })).toStartWith('/_kay/card?title=Hello')
      expect(shareCard({ title: 'Hello', image: '/_kay/assets/hero-1.png' })).toContain('src=')

      for (const image of ['/uploads/photo.png', 'https://cdn.example/photo.png'])
        expect(shareCard({ title: 'Hello', image })).toContain('src=')
    }
    finally {
      setCardMaker(() => '')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('signs the locale a template card of another locale is drawn in, and links the default locale\'s as before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-locale-'))
    const settings = { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false }
    const inLocale = (locale: string) => runInLocale({ settings, path: '/', locale, messages: new Map() }, () => shareCard({ title: 'Hello' }))

    try {
      const cards = await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, defaultLocale: 'en', template: { file: CARD, styles: undefined } })
      const server = new Elysia()

      serveCards(server, cards, { clientDir: clientDir(FIXTURE), cacheDir: join(dir, 'cache') })

      const english = new URL(inLocale('en'), 'http://localhost')
      const french = new URL(inLocale('fr'), 'http://localhost')

      expect(english.searchParams.has('locale')).toBe(false)
      expect(shareCard({ title: 'Hello' })).toBe(inLocale('en'))
      expect(french.searchParams.get('locale')).toBe('fr')
      expect(french.searchParams.get('sig')).not.toBe(english.searchParams.get('sig'))

      // The locale cannot be made up or dropped from a signed URL.
      const tampered = new URL(french)

      tampered.searchParams.set('locale', 'en')
      expect((await server.handle(new Request(tampered))).status).toBe(404)
      tampered.searchParams.delete('locale')
      expect((await server.handle(new Request(tampered))).status).toBe(404)
    }
    finally {
      setCardMaker(() => '')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves the page and the build\'s stylesheets, fonts and images, and nothing outside them', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'kay-card-serve-'))
    const client = join(scratch, 'client')
    const get = async (path: string) => answer(new Request(`http://127.0.0.1${path}`), '<head><title>t</title></head><header>h</header>', client)

    try {
      await Bun.write(join(client, 'app.css'), 'a{}')
      await Bun.write(join(client, 'assets/font.woff2'), 'f')
      await Bun.write(join(client, 'entry.js'), 'x')
      await Bun.write(join(scratch, 'secret.png'), 's')

      expect(await (await get('/')).text()).toBe('<head><style>html,body{margin:0}html{overflow:hidden}</style><title>t</title></head><header>h</header>')

      for (const [path, status] of [['/_kay/app.css', 200], ['/_kay/assets/font.woff2', 200], ['/_kay/entry.js', 404], ['/_kay/missing.css', 404], ['/app.css', 404], ['/_kay/%2e%2e/secret.png', 404], ['/_kay/..%2fsecret.png', 404], ['/_kay/assets/%00.css', 404], ['/_kay/%', 404]] as const)
        expect([path, (await get(path)).status]).toEqual([path, status])
    }
    finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it.skipIf(!chrome)('turns a request away once the queue holds as many cards as it takes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-queue-'))
    const gate = Promise.withResolvers<string>()

    try {
      const cards = await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template: { file: CARD, styles: undefined } })
      const server = new Elysia()

      serveCards(server, cards, { clientDir: clientDir(FIXTURE), cacheDir: join(dir, 'cache') })
      const started = Promise.withResolvers<void>()

      cards.template!.render = async () => {
        started.resolve()

        return gate.promise
      }

      const urls = Array.from({ length: MAX_QUEUED + 1 }, (_, index) => shareCard({ title: `Queued ${index}` }))
      const asked = urls.slice(0, MAX_QUEUED).map(async url => server.handle(new Request(`http://localhost${url}`)))

      // Each of the cards held its place while the first is drawn.
      await started.promise
      await Bun.sleep(200)

      const turned = await server.handle(new Request(`http://localhost${urls.at(-1)!}`))

      expect([turned.status, turned.headers.get('retry-after')]).toEqual([503, '10'])

      // Those already waiting are not turned away: they fail with the render, not with a 503.
      gate.reject(new Error('released'))
      expect((await Promise.all(asked)).map(response => response.status)).toEqual(Array.from<number>({ length: MAX_QUEUED }).fill(500))
    }
    finally {
      setCardMaker(() => '')
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(!chrome)('makes one image route for the cards of a burst, and drops it once the browser closes', async () => {
    const options = { clientDir: clientDir(FIXTURE), cacheDir: join(tmpdir(), 'kay-card-route-cache') }
    const first = await imageRoute(options)

    expect(await imageRoute(options)).toBe(first)
    expect(await imageRoute({ ...options })).not.toBe(first)

    // Drawn with the same options, the route the cards share is still the one made.
    const shared = await imageRoute(options)

    await shootCard(clientDir(FIXTURE), 80, async () => '<body style="margin:0">x</body>', options)
    expect(await imageRoute(options)).toBe(shared)
    await Bun.sleep(3300)
    expect(await imageRoute(options)).not.toBe(shared)
  }, 30_000)

  it('says where Chrome is needed when there is none', async () => {
    const before = process.env.BUN_CHROME_PATH

    process.env.BUN_CHROME_PATH = join(tmpdir(), 'no-chrome-here')

    try {
      await expect(shootCard(clientDir(FIXTURE), 80, async () => '<p>x</p>')).rejects.toThrow('is drawn in Chrome or Chromium, and none was found')
    }
    finally {
      process.env.BUN_CHROME_PATH = before
    }
  })
})

describe.skipIf(!chrome)('a share card laid out in _card.kay', () => {
  it('is drawn on demand from the app\'s components, Tailwind classes and the image, signed and kept', async () => {
    const app = await pages({ site: 'https://cards.example', seo: { name: 'Cards' }, plugins: [tailwind], root: FIXTURE, prebuilt: false })
    const link = async (page: string) => {
      const html = await (await app.handle(new Request(`http://localhost${page}`))).text()

      return (/<meta property="og:image" content="([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&').slice('https://cards.example'.length)
    }
    const home = await link('/')
    const served = await app.handle(new Request(`http://localhost${home}`))

    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/jpeg')

    const first = await served.bytes()

    await expectTemplateCard(first, true)

    // Asked again, the kept file answers.
    expect(await (await app.handle(new Request(`http://localhost${home}`))).bytes()).toEqual(first)

    // No image gives the template none to show.
    const plain = await app.handle(new Request(`http://localhost${await link('/plain')}`))

    expect(plain.status).toBe(200)
    await expectTemplateCard(await plain.bytes(), false)

    // A title nobody signed is not drawn.
    expect((await app.handle(new Request(`http://localhost${home.replace('Hello+template', 'Another')}`))).status).toBe(404)
  }, 60_000)

  it('shows an image of images.dirs and of images.remote, which the route draws the card variant of', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-images-'))
    const uploads = join(dir, 'uploads')

    try {
      await Bun.write(join(uploads, 'photo.png'), Bun.file(join(FIXTURE, 'src/hero.png')))

      const cards = await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template: { file: CARD, styles: undefined } })
      const server = new Elysia()
      const remote = async () => ({ path: join(uploads, 'photo.png'), key: 'photo' })

      setRemoteImages(() => true)

      serveCards(server, cards, { clientDir: clientDir(FIXTURE), cacheDir: join(dir, 'cache'), dirs: { '/uploads/': uploads }, remote })
      cards.template!.render = async card => `<body style="margin:0;background:#1e40af"><img src="${card.image}" style="display:block;width:400px;height:630px;object-fit:cover"></body>`

      for (const image of ['/uploads/photo.png', 'https://cdn.example/photo.png']) {
        const served = await server.handle(new Request(`http://localhost${shareCard({ title: 'Hello', image })}`))

        expect([image, served.status]).toEqual([image, 200])
        // Green, as the route's variant has no colour profile for Chrome to shift it by.
        expect([image, near((await pixelsOf(await served.bytes()))(160, 160), [0, 255, 0])]).toEqual([image, true])
      }
    }
    finally {
      setRemoteImages(undefined)
      setCardMaker(() => '')
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('renders the template in the locale of the page the card is for', async () => {
    const copy = await fixtureCopy('card-template')
    const template = join(copy, 'src/routes/_card.kay')

    await Bun.write(template, `--- server
import '../app.css'
import { t } from 'kay/i18n'

const { title } = ctx.card
const background = t('nav.home') === 'Accueil' ? 'bg-[#dc2626]' : 'bg-[#1e40af]'
---
div(class={'relative h-[630px] w-[1200px] ' + background})
  h1(class="m-0 text-6xl font-black text-white") {title}
`)
    const app = await pages({ site: 'https://cards.example', seo: { name: 'Cards' }, plugins: [tailwind], root: copy, prebuilt: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })

    for (const [page, background] of [['/', [30, 64, 175]], ['/fr', [220, 38, 38]]] as const) {
      const html = await (await app.handle(new Request(`http://localhost${page}`))).text()
      const link = (/<meta property="og:image" content="([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&').slice('https://cards.example'.length)
      const served = await app.handle(new Request(`http://localhost${link}`))

      expect([page, served.status]).toEqual([page, 200])
      expect([page, near((await pixelsOf(await served.bytes()))(1150, 30), [...background])]).toEqual([page, true])
    }
  }, 60_000)

  it('is written at build for the prerendered pages, and drawn again by nothing while its files are cached', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kay-card-template-'))

    try {
      const child = Bun.spawn([process.execPath, CLI, 'build', FIXTURE, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toMatchObject({ code: 0 })

      for (const [page, image] of [['index.html', true], ['plain.html', false]] as const) {
        const html = await Bun.file(join(outdir, page)).text()
        const file = (/<meta property="og:image" content="https:\/\/cards\.example(\/_kay\/images\/card-\w+\.jpg)">/).exec(html)?.[1]

        expect(file).toBeDefined()
        await expectTemplateCard(await Bun.file(join(outdir, file!)).bytes(), image)
      }
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }, 120_000)
})

// Whether a pixel is the fixture image's green, which the route's variants and Chrome's own draw a little apart.
function green(pixel: number[]): boolean {
  return pixel[1]! > 150 && pixel[0]! < 60 && pixel[2]! < 120
}

describe.skipIf(!chrome)('share cards of a template, in builds and on requests of other settings', () => {
  const CONFIG = (settings: string) => `import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://cards.example',
  seo: { name: 'Cards' },
  plugins: [tailwind],
${settings}
})
`
  const staticBuild = async (root: string, outdir: string) => {
    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toMatchObject({ code: 0 })
  }
  const cardOf = async (outdir: string, page: string) => {
    const html = await Bun.file(join(outdir, page)).text()
    const file = (/<meta property="og:image" content="https:\/\/cards\.example(\/_kay\/images\/card-\w+\.jpg)">/).exec(html)?.[1]

    expect([page, file === undefined]).toEqual([page, false])

    return pixelsOf(await Bun.file(join(outdir, file!)).bytes())
  }

  it('shows an image the template cuts to an aspect images.aspects lists, in a build', async () => {
    const root = await fixtureCopy('card-template')
    const outdir = await scratchDir('card-aspect-')
    const template = join(root, 'src/routes/_card.kay')

    await Bun.write(join(root, 'kay.config.ts'), CONFIG('  images: { aspects: [\'2/1\'] },'))
    await Bun.write(template, (await Bun.file(template).text()).replace('import hero from \'../hero.png\'', 'import hero from \'../hero.png\'\nimport { image as cut } from \'kay/image\'').replace('  div(class="absolute top-0 right-0', '  img({...cut(hero, { aspect: \'2/1\' })} class="absolute top-[200px] left-[700px] h-[100px] w-[200px] object-cover" alt="")\n  div(class="absolute top-0 right-0'))

    try {
      await staticBuild(root, outdir)
      expect(green((await cardOf(outdir, 'index.html'))(800, 250))).toBe(true)
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }, 120_000)

  it('draws the card of a localized prerendered page in its locale, in a build', async () => {
    const root = await fixtureCopy('card-template')
    const outdir = await scratchDir('card-locale-')

    await Bun.write(join(root, 'kay.config.ts'), CONFIG(`  i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: ${JSON.stringify(resolve('tests/fixtures/i18n/src/messages'))} },`))
    await Bun.write(join(root, 'src/routes/_card.kay'), '--- server\nimport \'../app.css\'\nimport { t } from \'kay/i18n\'\n\nconst { title } = ctx.card\nconst background = t(\'nav.home\') === \'Accueil\' ? \'bg-[#dc2626]\' : \'bg-[#1e40af]\'\n---\ndiv(class={\'relative h-[630px] w-[1200px] \' + background})\n  h1(class="m-0 text-6xl font-black text-white") {title}\n')

    try {
      await staticBuild(root, outdir)
      expect(near((await cardOf(outdir, 'index.html'))(1150, 30), [30, 64, 175])).toBe(true)
      expect(near((await cardOf(outdir, 'fr/index.html'))(1150, 30), [220, 38, 38])).toBe(true)
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }, 120_000)

  it('shows an image of images.remote on the card of a static export', async () => {
    const root = await fixtureCopy('card-template')
    const outdir = await scratchDir('card-remote-')
    const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(Bun.file(join(FIXTURE, 'src/hero.png')), { headers: { 'content-type': 'image/png' } }) })
    const origin = `http://127.0.0.1:${host.port}`

    await Bun.write(join(root, 'kay.config.ts'), CONFIG(`  images: { remote: ['${origin}/photos/'] },`))
    await Bun.write(join(root, 'src/routes/index.kay'), `---
import { shareCard } from 'kay/image'
---
head
  title Home
  meta(property="og:image" content={shareCard({ title: 'Hello template', image: '${origin}/photos/hero.png' })})
h1 Home
`)

    try {
      await staticBuild(root, outdir)
      expect(green((await cardOf(outdir, 'index.html'))(160, 160))).toBe(true)
    }
    finally {
      await host.stop(true)
      await rm(outdir, { recursive: true, force: true })
    }
  }, 120_000)

  it('shows an image of images.dirs through the real template, on request', async () => {
    const root = await fixtureCopy('card-template')
    const uploads = await scratchDir('card-uploads-')

    await Bun.write(join(uploads, 'photo.png'), Bun.file(join(FIXTURE, 'src/hero.png')))
    await Bun.write(join(root, 'src/routes/uploaded.kay'), '---\nimport { shareCard } from \'kay/image\'\n---\nhead\n  title Uploaded\n  meta(property="og:image" content={shareCard({ title: \'Uploaded\', image: \'/uploads/photo.png\' })})\nh1 Uploaded\n')

    try {
      const app = await pages({ site: 'https://cards.example', seo: { name: 'Cards' }, plugins: [tailwind], root, prebuilt: false, images: { dirs: { '/uploads/': uploads } } })
      const html = await (await app.handle(new Request('http://localhost/uploaded'))).text()
      const link = (/<meta property="og:image" content="([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&').slice('https://cards.example'.length)
      const served = await app.handle(new Request(`http://localhost${link}`))

      expect(served.status).toBe(200)
      expect(green((await pixelsOf(await served.bytes()))(160, 160))).toBe(true)
    }
    finally {
      await rm(uploads, { recursive: true, force: true })
    }
  }, 60_000)
})

// A `kay build --compile` of the fixture, run from a folder with none of its files; a worker of `bun test --parallel` builds into a folder of its own, which `outputDir` names.
describe('a share card template in an executable', () => {
  const SERVER = 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 0))\n\nconsole.log(`listening ${app.server?.port}`)\n'
  let root = ''
  let running: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let elsewhere = ''

  afterAll(async () => {
    running?.kill()
    await running?.exited
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('serves the cards its build wrote, under the same names, and keeps the stamp it read', async () => {
    root = resolve(await fixtureCopy('card-template'))
    elsewhere = await scratchDir('card-executable-cwd-')
    await Bun.write(join(root, 'src/server.ts'), SERVER)

    const executable = join(root, 'bin')
    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--compile', executable], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toEqual({ code: 0, errors: '' })

    const built = join(clientDir(root), 'images')
    const names = (await readdir(built)).filter(name => name.startsWith('card-')).toSorted()

    expect(names).toHaveLength(2)

    const wrote = await Promise.all(names.map(async name => Buffer.from(await Bun.file(join(built, name)).bytes()).toString('base64')))

    expect((await Bun.file(join(outputDir(root), 'card-template.txt')).text()).length).toBeGreaterThan(0)

    running = Bun.spawn([executable], { cwd: elsewhere, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', PORT: '0', KAY_EPHEMERAL_SECRET: '1', BUN_CHROME_PATH: join(elsewhere, 'no-chrome-here') } })

    const origin = `http://localhost:${await listeningPort(running, 'the executable')}`
    const served: string[] = []

    // With no Chrome to draw in, a card the executable serves is one its build wrote.
    for (const page of ['/', '/plain']) {
      const html = await (await fetch(`${origin}${page}`)).text()
      const link = (/<meta property="og:image" content="https:\/\/cards\.example([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&')
      const card = await fetch(`${origin}${link}`)

      expect([page, card.status, card.headers.get('content-type')]).toEqual([page, 200, 'image/jpeg'])
      served.push(Buffer.from(await card.bytes()).toString('base64'))
    }

    expect(served.toSorted()).toEqual(wrote.toSorted())
  }, 300_000)

  it('refuses to start from a bundle that holds no record of the template', async () => {
    const dir = await scratchDir('card-executable-stamp-')

    try {
      await expect(setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, bundled: true, template: { file: CARD, styles: undefined } })).rejects.toMatchObject({ code: 'executable-incomplete' })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes the stamp of an earlier build once the app has no _card.kay', async () => {
    const dir = await scratchDir('card-executable-stale-')

    try {
      await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, collect: true, template: { file: CARD, styles: undefined } })
      expect(await Bun.file(join(dir, 'card-template.txt')).exists()).toBe(true)

      await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, collect: true })
      expect(await Bun.file(join(dir, 'card-template.txt')).exists()).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!chrome)('a share card that is not drawn in time', () => {
  const LIMIT = 1000
  const real = browserModule.browse
  const opened: { closed: boolean }[] = []
  const order: string[] = []

  // The real browse, its page recorded, with the paint of a renderer that never answers when `hang` is set, and the answer of the open delayed by `delay`.
  function watch(hang: boolean, delay = 0) {
    return spyOn(browserModule, 'browse').mockImplementation(async (url, options) => {
      const page = await real(url, options)
      const record = { closed: false }

      opened.push(record)
      await Bun.sleep(delay)

      const view = { ...page.view, cdp: async (method: string, params?: Record<string, unknown>) => hang && method === 'Runtime.evaluate' ? new Promise<never>(Function.prototype as () => void) : page.view.cdp(method, params) }

      return { ...page, view, close: () => {
        record.closed = true
        order.push('closed')
        page.close()
      } } as typeof page
    })
  }

  // Chrome starts in a second or more, which the cut limit must not have to cover: one card drawn first leaves it running for the tests.
  beforeAll(async () => {
    await shootCard(clientDir(FIXTURE), 80, async () => '<p>warm</p>')
  }, 60_000)

  beforeEach(() => {
    opened.length = 0
    order.length = 0
    setCardShotLimit(LIMIT)
  })

  afterEach(() => {
    setCardShotLimit()
    mock.restore()
  })

  it('leaves no page of the browser open, and the next card waits for the stuck one to close', async () => {
    watch(true)

    const stuck = shootCard(clientDir(FIXTURE), 80, async () => '<p>stuck</p>')
    const next = shootCard(clientDir(FIXTURE), 80, async () => {
      order.push('next started')

      return '<p>next</p>'
    })

    await expect(stuck).rejects.toThrow('was not drawn within 1 s')
    expect(opened.map(page => page.closed)).toEqual([true])

    await expect(next).rejects.toThrow('was not drawn within 1 s')
    expect(order).toEqual(['closed', 'next started', 'closed'])
    expect(opened.every(page => page.closed)).toBe(true)
  }, 30_000)

  it('closes at once a page the browser opens after the limit has passed', async () => {
    watch(true, LIMIT * 1.5)

    await expect(shootCard(clientDir(FIXTURE), 80, async () => '<p>slow</p>')).rejects.toThrow('was not drawn within')

    // The page opened, but its answer came after the card was given up.
    expect(opened.map(page => page.closed)).toEqual([false])

    for (let waited = 0; !opened[0]!.closed && waited < 5000; waited += 50)
      await Bun.sleep(50)

    expect(opened.map(page => page.closed)).toEqual([true])
  }, 30_000)
})
