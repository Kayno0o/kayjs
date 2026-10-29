import type { RenderedPage } from 'kay/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { serverRoot } from 'kay/library'
import { applyPageHooks, assetFiles, pageSizes } from '../../../src/server/page-hook'
import { ai, AiError, describeImage, fakeAi } from '../src'
import { draftProblems, forgetDrafts, forgetRetry, writeImageAlts, writeKeptImageAlts } from '../src/image-alt'

const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
const ASSET = '/_kay/assets/team-abc.png'
const IMG = `<img src="${ASSET}" width="1" height="1">`

let folder: string | undefined

async function image(name: string): Promise<string> {
  folder ??= await mkdtemp(join(tmpdir(), 'image-alt-'))

  const path = join(folder, name)

  await Bun.write(path, PNG)

  return path
}

async function page(html: string, files: Record<string, string>, locale = 'en'): Promise<string> {
  const rendered = { path: '/', locale, html, file: async (url: string) => Promise.resolve(files[url]) } as RenderedPage

  return writeImageAlts(rendered)
}

afterEach(async () => {
  fakeAi.clear()
  forgetDrafts()
  await rm(join(await serverRoot(), '.kay/cache/libraries/kayjs-ai'), { recursive: true, force: true })

  if (folder !== undefined)
    await rm(folder, { recursive: true, force: true })

  folder = undefined
})

describe('describeImage', () => {
  it('asks the model for an alt with the image attached and gives the text back', async () => {
    fakeAi.reply({ data: { alt: '  A team at a table ' } })

    expect(await describeImage(new Blob([PNG]), { language: 'fr' })).toBe('A team at a table')
    expect(fakeAi.last()!.system).toContain('language fr')
    expect(fakeAi.last()!.messages[0]!.attachments![0]).toMatchObject({ kind: 'image', type: 'image/png' })
  })
})

describe('imageAlt', () => {
  it('is declared by ai({ imageAlt: true }) alone, with the lint it satisfies', () => {
    expect(ai().satisfies).toBeUndefined()
    expect(ai().transformPage).toBeUndefined()
    expect(ai({ imageAlt: true }).satisfies).toEqual(['missing-alt'])
    expect(ai({ imageAlt: true }).transformPage).toBe(writeImageAlts)
  })

  it('drafts the alt of an imported image with none, and keeps one the author wrote', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })

    const path = await image('team-abc.png')
    const html = await page(`<main>${IMG}<img src="${ASSET}" alt="Mine" width="1" height="1"><img src="${ASSET}" alt="" width="1" height="1"></main>`, { [ASSET]: path })

    expect(html).toBe(`<main><img src="${ASSET}" width="1" height="1" alt="A team"><img src="${ASSET}" alt="Mine" width="1" height="1"><img src="${ASSET}" alt="" width="1" height="1"></main>`)
    expect(fakeAi.asked).toHaveLength(1)
  })

  it('leaves a decorative img, an image that is not imported and an island\'s img alone, and asks nothing for them', async () => {
    const path = await image('team-abc.png')
    const html = `<img src="${ASSET}" aria-hidden="true"><img src="${ASSET}" role="presentation"><img src="/logo.png"><slot data-component="a"><img src="${ASSET}"></slot>`

    expect(await page(html, { [ASSET]: path })).toBe(html)
    expect(fakeAi.asked).toHaveLength(0)
  })

  it('drafts an image once for its content: the next render and the next page read the cache', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })

    const path = await image('team-abc.png')

    expect(await page(IMG, { [ASSET]: path })).toContain('alt="A team"')
    expect(await page(`<p>${IMG}</p>`, { [ASSET]: path })).toContain('alt="A team"')
    expect(fakeAi.asked).toHaveLength(1)
  })

  it('drafts again for another image and for another locale', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })
    fakeAi.reply({ data: { alt: 'Une equipe' } })

    const path = await image('team-abc.png')

    expect(await page(IMG, { [ASSET]: path }, 'en')).toContain('alt="A team"')
    expect(await page(IMG, { [ASSET]: path }, 'fr')).toContain('alt="Une equipe"')
    expect(fakeAi.asked).toHaveLength(2)
  })

  it('leaves the page as it is when the model fails, logging once and not asking again for that image', async () => {
    fakeAi.fail(new AiError('unavailable', 'down'))

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const path = await image('team-abc.png')

    try {
      expect(await page(IMG, { [ASSET]: path })).toBe(IMG)
      expect(await page(`<p>${IMG}</p>`, { [ASSET]: path })).toBe(`<p>${IMG}</p>`)
      expect(fakeAi.asked).toHaveLength(1)
      expect(warn.mock.calls.filter(([line]) => String(line).includes('team-abc.png'))).toHaveLength(1)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('sends neither an SVG nor an AVIF to the model', async () => {
    const svg = await image('logo-abc.svg')
    const avif = await image('photo-abc.avif')
    const html = '<img src="/_kay/assets/logo-abc.svg"><img src="/_kay/assets/photo-abc.avif">'

    expect(await page(html, { '/_kay/assets/logo-abc.svg': svg, '/_kay/assets/photo-abc.avif': avif })).toBe(html)
    expect(fakeAi.asked).toHaveLength(0)
  })

  it('describes more images than it runs at once, each one after the others', async () => {
    const files: Record<string, string> = {}
    let html = ''

    for (let index = 0; index < 8; index++) {
      const url = `/_kay/assets/p${index}-abc.png`

      files[url] = await image(`p${index}-abc.png`)
      html += `<img src="${url}">`
    }

    expect((await page(html, files)).match(/alt="fake"/g)).toHaveLength(8)
    expect(fakeAi.asked).toHaveLength(8)
  })

  it('tries a failed image again once the retry delay has passed', async () => {
    fakeAi.fail(new AiError('unavailable', 'down'))

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const path = await image('team-abc.png')

    try {
      expect(await page(IMG, { [ASSET]: path })).toBe(IMG)
      forgetRetry()
      fakeAi.reply({ data: { alt: 'A team' } })
      expect(await page(IMG, { [ASSET]: path })).toContain('alt="A team"')
      expect(warn.mock.calls.filter(([line]) => String(line).includes('team-abc.png'))).toHaveLength(1)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('skips an img inside nested islands, however deep, and takes the one after them', async () => {
    const path = await image('team-abc.png')
    const html = `<slot data-component="a"><slot data-component="b"><img src="${ASSET}"></slot><img src="${ASSET}"></slot>${IMG}`

    expect(await page(html, { [ASSET]: path })).toBe(`<slot data-component="a"><slot data-component="b"><img src="${ASSET}"></slot><img src="${ASSET}"></slot><img src="${ASSET}" width="1" height="1" alt="fake">`)
  })

  it('goes through the hook runner of a build with the files it resolves, as ai() carries it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'image-alt-client-'))

    try {
      await Bun.write(join(dir, 'assets/team-abc.png'), PNG)
      fakeAi.reply({ data: { alt: 'A team' } })

      const file = assetFiles({ clientDir: dir, publicDir: join(dir, 'public'), base: '' })
      const html = await applyPageHooks([ai({ imageAlt: true }).transformPage!], '/', 'en', IMG, file, pageSizes(file))

      expect(html).toContain('alt="A team"')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the drafts kept into a page rendered per request, never waiting on the model, and drafts the missing ones for the next render', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })

    const path = await image('team-abc.png')
    const live = async () => writeKeptImageAlts({ path: '/', locale: 'en', html: IMG, file: async () => Promise.resolve(path) } as unknown as RenderedPage)

    expect(await live()).toBe(IMG)

    for (let tries = 0; tries < 50 && (await live()) === IMG; tries++)
      await Bun.sleep(10)

    expect(await live()).toBe(`<img src="${ASSET}" width="1" height="1" alt="A team">`)
    expect(fakeAi.asked).toHaveLength(1)
    expect(ai({ imageAlt: true }).transformServedPage).toBe(writeKeptImageAlts)
    expect(ai().transformServedPage).toBeUndefined()
  })

  it('leaves the page as it is with no model configured, asking nothing', async () => {
    const was = { NODE_ENV: process.env.NODE_ENV, AI_PROVIDER: process.env.AI_PROVIDER }

    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROVIDER

    try {
      const path = await image('team-abc.png')

      expect(await page(IMG, { [ASSET]: path })).toBe(IMG)
      expect(fakeAi.asked).toHaveLength(0)
    }
    finally {
      process.env.NODE_ENV = was.NODE_ENV ?? 'test'

      if (was.AI_PROVIDER !== undefined)
        process.env.AI_PROVIDER = was.AI_PROVIDER
    }
  })

  it('keeps writing the drafts already kept when no model is configured any more, and keeps a decorative image out of the page and the listing', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })
    fakeAi.reply({ data: { alt: '' } })

    const path = await image('team-abc.png')
    const other = await image('logo-abc.png')
    const both = `${IMG}<img src="/_kay/assets/logo-abc.png">`
    const files = { [ASSET]: path, '/_kay/assets/logo-abc.png': other }

    await page(both, files)

    const was = process.env.NODE_ENV

    process.env.NODE_ENV = 'production'

    try {
      expect(await page(both, files)).toBe(`<img src="${ASSET}" width="1" height="1" alt="A team"><img src="/_kay/assets/logo-abc.png">`)
      expect(fakeAi.asked).toHaveLength(2)
    }
    finally {
      process.env.NODE_ENV = was ?? 'test'
    }

    expect((await draftProblems()).map(problem => problem.message)).toEqual(['imageAlt drafted the alt of team-abc.png (en): "A team"'])
  })

  it('lists each draft for review offline, without calling the model', async () => {
    fakeAi.reply({ data: { alt: 'A team' } })

    const path = await image('team-abc.png')

    await page(IMG, { [ASSET]: path }, 'fr')

    const asked = fakeAi.asked.length
    const problems = await ai({ imageAlt: true }).check!()

    expect(await draftProblems()).toEqual([{ message: 'imageAlt drafted the alt of team-abc.png (fr): "A team"', help: expect.stringContaining('write the img\'s own alt') }])
    expect(problems.map(problem => problem.message)).toEqual(['imageAlt drafted the alt of team-abc.png (fr): "A team"'])
    expect(fakeAi.asked).toHaveLength(asked)
  })
})
