import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { clientDir } from '../src/build/assets'
import { setCardMaker, shareCard } from '../src/runtime/image'
import { pages } from '../src/server'
import { serveCards, setupCards } from '../src/server/card'
import { answer, MAX_QUEUED, shootCard, templateStamp } from '../src/server/card-template'
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

  it('renames the cards of a changed template, and keeps the fixed layout\'s look without one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))
    const looks: string[] = []

    try {
      for (const template of [undefined, { file: CARD, styles: 'one.css' }, { file: CARD, styles: 'two.css' }])
        looks.push((await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template })).look)

      expect(new Set(looks).size).toBe(3)
      expect((await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined })).look).toBe(looks[0]!)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes an imported image alone for a template, and draws with no font of the config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-stamp-'))

    try {
      await setupCards({ dir, clientDir: clientDir(FIXTURE), fonts: undefined, template: { file: CARD, styles: undefined } })

      expect(shareCard({ title: 'Hello' })).toStartWith('/_kay/card?title=Hello')
      expect(shareCard({ title: 'Hello', image: '/_kay/assets/hero-1.png' })).toContain('src=')

      for (const image of ['/uploads/photo.png', 'https://cdn.example/photo.png'])
        expect(() => shareCard({ title: 'Hello', image })).toThrow('its cards take an imported image')
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

// A `kay build --compile` of the fixture, run from a folder with none of its files.
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

    const built = join(root, '.kay/client/dist/images')
    const names = (await readdir(built)).filter(name => name.startsWith('card-')).toSorted()

    expect(names).toHaveLength(2)

    const wrote = await Promise.all(names.map(async name => Buffer.from(await Bun.file(join(built, name)).bytes()).toString('base64')))

    expect((await Bun.file(join(root, '.kay/client/card-template.txt')).text()).length).toBeGreaterThan(0)

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
  it('leaves no page of the browser open, and the next card waits for the stuck one to close', async () => {
    const opened: { closed: boolean }[] = []
    const order: string[] = []
    const real = browserModule.browse
    const spy = spyOn(browserModule, 'browse').mockImplementation(async (url, options) => {
      const page = await real(url, options)
      const record = { closed: false }

      opened.push(record)

      // A renderer that never answers the paint.
      const view = { ...page.view, cdp: async (method: string, params?: Record<string, unknown>) => method === 'Runtime.evaluate' ? new Promise<never>(Function.prototype as () => void) : page.view.cdp(method, params) }

      return { ...page, view, close: () => {
        record.closed = true
        order.push('closed')
        page.close()
      } } as typeof page
    })

    try {
      const stuck = shootCard(clientDir(FIXTURE), 80, async () => '<p>stuck</p>')
      const next = shootCard(clientDir(FIXTURE), 80, async () => {
        order.push('next started')

        return '<p>next</p>'
      })

      await expect(stuck).rejects.toThrow('was not drawn within 30 s')
      expect(opened.map(page => page.closed)).toEqual([true])

      await expect(next).rejects.toThrow('was not drawn within 30 s')
      expect(order).toEqual(['closed', 'next started', 'closed'])
      expect(opened.every(page => page.closed)).toBe(true)
    }
    finally {
      spy.mockRestore()
    }
  }, 90_000)
})
