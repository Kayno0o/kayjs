import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { setCardMaker, shareCard } from '../src/runtime/image'
import { pages } from '../src/server'
import { setupCards } from '../src/server/card'
import { shootCard, templateStamp } from '../src/server/card-template'
import { decodePng } from '../src/server/crop'
import { browserPath } from '../src/test/browser'

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
