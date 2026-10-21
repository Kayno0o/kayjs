import type { TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/save-data-islands/src/routes'
const PRELOAD = /<link rel="modulepreload" href="([^"]*)"(?: data-load)?>/g
const WHEN = /hydrate-when-\w+\.js/
const ON = { 'save-data': 'on' }

const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers })
const preloads = (html: string) => [...html.matchAll(PRELOAD)].map(match => match[1]!)

// A page `kay build` rendered and the one rendered on the request go through different code, and both must answer both kinds of visitor.
describe.each([
  ['rendered on the request', 'request'],
  ['prerendered', 'prerendered'],
] as const)('the head of a page %s', (_name, kind) => {
  const served = async (config: Record<string, unknown> = {}) => {
    const options = { routes: ROUTES, ...config }

    if (kind === 'request')
      return { app: await pages({ ...options, prebuilt: false }), remove: async () => undefined }

    const build = await scratchBuild()

    await build.prerender(options)

    return { app: await build.serve(options), remove: build.remove }
  }

  const read = async (app: { handle: (request: Request) => Response | Promise<Response> }, path: string, headers: Record<string, string> = {}) => (await app.handle(request(path, headers))).text()

  it('drops the chunks only islands need for a visitor saving data, keeping the entry\'s and the code waiting for the viewport', async () => {
    const { app, remove } = await served()

    try {
      const full = await read(app, '/', {})
      const saving = await read(app, '/', ON)

      expect(preloads(saving).length).toBeLessThan(preloads(full).length)
      expect(preloads(saving).every(href => preloads(full).includes(href))).toBe(true)
      expect(preloads(saving).some(href => WHEN.test(href))).toBe(true)
      expect(saving).toContain('<script type="module" src="')
      expect(saving).toContain('data-hydrate="load"')
    }
    finally {
      await remove()
    }
  })

  it('preloads the code waiting for the viewport on a page whose islands all hydrate at once, for that visitor alone', async () => {
    const { app, remove } = await served()

    try {
      const full = preloads(await read(app, '/eager'))
      const saving = preloads(await read(app, '/eager', ON))

      expect(full.some(href => WHEN.test(href))).toBe(false)
      expect(saving.some(href => WHEN.test(href))).toBe(true)
      expect(new Set(saving).size).toBe(saving.length)
    }
    finally {
      await remove()
    }
  })

  it('keeps the chunks of the islands hydrating at once, load or client, for a visitor saving data, and injects no waiting code when nothing else drops', async () => {
    const { app, remove } = await served()

    try {
      const full = preloads(await read(app, '/loaded'))
      const html = await read(app, '/loaded', ON)

      expect(preloads(html)).toEqual(full)
      expect(full.length).toBeGreaterThan(0)
      expect(full.some(href => WHEN.test(href))).toBe(false)
      expect(html).toContain('data-load>')
    }
    finally {
      await remove()
    }
  })

  it('keeps the chunk of a load island next to a page\'s default ones, which drop', async () => {
    const { app, remove } = await served()

    try {
      const full = await read(app, '/')
      const saving = await read(app, '/', ON)
      const marked = [...full.matchAll(/<link rel="modulepreload" href="([^"]*)" data-load>/g)].map(match => match[1]!)

      expect(marked.length).toBeGreaterThan(0)
      expect(preloads(saving)).not.toEqual(preloads(full))

      for (const href of marked)
        expect(saving).toContain(`href="${href}" data-load>`)
    }
    finally {
      await remove()
    }
  })

  it('preloads the code waiting for the viewport on a page using one component both ways, keeping its chunks for that visitor alone', async () => {
    const { app, remove } = await served()

    try {
      const full = await read(app, '/both')
      const saving = await read(app, '/both', ON)

      expect(preloads(full).some(href => WHEN.test(href))).toBe(false)
      expect(preloads(saving).some(href => WHEN.test(href))).toBe(true)
      expect(preloads(saving).filter(href => !WHEN.test(href))).toEqual(preloads(full))
      expect(new Set(preloads(saving)).size).toBe(preloads(saving).length)
      expect(saving).toContain('data-load')
    }
    finally {
      await remove()
    }
  })

  it('preloads the code waiting for the viewport once for a component used both ways, on a streamed page and under a mount point too', async () => {
    for (const [config, route, prefix] of [[{}, '/both', ''], [{}, '/streamed', ''], [{ base: '/docs' }, '/both', '/docs'], [{ base: '/docs' }, '/streamed', '/docs']] as const) {
      const { app, remove } = await served(config)

      try {
        const full = preloads(await read(app, route))
        const saving = preloads(await read(app, route, ON))

        expect(full.some(href => WHEN.test(href))).toBe(false)
        expect(saving.some(href => WHEN.test(href))).toBe(true)
        expect(saving.filter(href => !WHEN.test(href))).toEqual(full)
        expect(new Set(saving).size).toBe(saving.length)
        expect(saving.every(href => href.startsWith(`${prefix}/`))).toBe(true)
      }
      finally {
        await remove()
      }
    }
  })

  it('leaves the waiting code out for an island only a failed try block rendered by default', async () => {
    const { app, remove } = await served()

    try {
      const full = preloads(await read(app, '/rolled-back'))
      const html = await read(app, '/rolled-back', ON)

      expect(html).toContain('Fallback')
      expect(preloads(html)).toEqual(full)
      expect(html).not.toContain('data-wait')
    }
    finally {
      await remove()
    }
  })

  it.each([
    ['off', { 'save-data': 'off' }],
    ['absent', {}],
  ])('keeps every preload with Save-Data %s', async (_name, headers) => {
    const { app, remove } = await served()

    try {
      const html = await read(app, '/', headers)
      const saving = await read(app, '/', ON)

      expect(preloads(html).length).toBeGreaterThan(preloads(saving).length)
    }
    finally {
      await remove()
    }
  })

  it('says the page varies on Save-Data, for the light answer and the full one', async () => {
    const { app, remove } = await served()

    try {
      for (const headers of [ON, {}]) {
        const vary = (await app.handle(request('/', headers))).headers.get('vary') ?? ''

        expect(vary.toLowerCase()).toContain('save-data')
      }
    }
    finally {
      await remove()
    }
  })

  it('names the chunks under a mount point as the page does, dropping those of the island and keeping the entry\'s', async () => {
    const { app, remove } = await served({ base: '/docs' })

    try {
      const full = preloads(await read(app, '/'))
      const saving = preloads(await read(app, '/', ON))

      expect(full.every(href => href.startsWith('/docs/'))).toBe(true)
      expect(saving.length).toBeGreaterThan(0)
      expect(saving.length).toBeLessThan(full.length)
      expect(saving.every(href => href.startsWith('/docs/'))).toBe(true)

      const loaded = await read(app, '/loaded', ON)

      expect([...loaded.matchAll(/<link rel="modulepreload" href="[^"]*" data-load>/g)].length).toBeGreaterThan(0)
      expect(loaded).not.toMatch(/<link rel="modulepreload" href="(?!\/docs\/)/)
    }
    finally {
      await remove()
    }
  })

  it('answers everyone alike with saveData off, the markup telling the browser so', async () => {
    const { app, remove } = await served({ saveData: false })

    try {
      const saving = await app.handle(request('/', ON))
      const html = await saving.text()

      expect(preloads(html)).toEqual(preloads(await read(app, '/')))
      expect(html).toContain('<meta name="kay-save-data" content="off">')
      expect((saving.headers.get('vary') ?? '').toLowerCase()).not.toContain('save-data')
    }
    finally {
      await remove()
    }
  })

  it('serves both kinds of visitor again and again from the same page', async () => {
    const { app, remove } = await served()

    try {
      const bodies: string[] = []

      for (const headers of [ON, {}, ON, {}])
        bodies.push(await read(app, '/', headers))

      expect(bodies[0]).toBe(bodies[2])
      expect(bodies[1]).toBe(bodies[3])
      expect(bodies[0]).not.toBe(bodies[1])
    }
    finally {
      await remove()
    }
  })
})

const path = browserPath()

type Ready = Record<string, string | undefined>

// What each island of the page shows: `yes` once hydrated, `no` as the server rendered it.
const readiness = async (page: Awaited<ReturnType<TestSite['open']>>): Promise<Ready> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('button.count')].map(button => [button.dataset.name!, button.dataset.ready])))

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('islands in a browser asking to save data', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ routes: ROUTES, browser: { path } })
  }, 60_000)

  afterAll(async () => site?.close())

  const open = async (saving: boolean, start = '/') => {
    const page = await site.open(start, { path })

    await page.initScript((saveData: boolean) => {
      Object.defineProperty(navigator, 'connection', { value: { saveData }, configurable: true })
    }, saving)
    await page.goto(start)
    await page.waitFor('button.count[data-name="top"][data-ready="yes"]')

    return page
  }

  it('hydrates the island in view at once and the one below the fold when it scrolls near, those with a strategy of their own going as they say', async () => {
    const page = await open(true)

    try {
      await page.waitFor('button.count[data-name="load"][data-ready="yes"]')
      await page.waitFor('button.count[data-name="idle"][data-ready="yes"]')
      await page.waitFor('button.count[data-name="client"]')

      const waiting = await readiness(page)

      expect(waiting.below).toBe('no')
      expect(waiting.far).toBe('no')
      expect(page.errors).toEqual([])

      await page.evaluate(() => document.querySelector('button.count[data-name="below"]')!.scrollIntoView({ block: 'center' }))
      await page.waitFor('button.count[data-name="below"][data-ready="yes"]')

      expect((await readiness(page)).far).toBe('no')
    }
    finally {
      page.close()
    }
  })

  it('hydrates every island at once for a visitor not asking to save data, bar the one that asked to wait', async () => {
    const page = await open(false)

    try {
      await page.waitFor('button.count[data-name="below"][data-ready="yes"]')
      await page.waitFor('button.count[data-name="load"][data-ready="yes"]')

      expect((await readiness(page)).far).toBe('no')
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  })

  it('replays a click on an island waiting for the viewport once it hydrated', async () => {
    const page = await open(true)

    try {
      await page.click('button.count[data-name="below"]')
      await page.waitFor('button.count[data-name="below"][data-ready="clicked"]')
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  })

  it('keeps the wait through a lazy page swap, and drops it without the request', async () => {
    for (const [saving, below] of [[true, 'no'], [false, 'yes']] as const) {
      const page = await open(saving)

      try {
        await page.click('a.next')
        await page.waitFor('h1', { text: 'Next' })
        await page.waitFor('button.count[data-name="load"][data-ready="yes"]')
        await page.waitFor('button.count[data-name="top"][data-ready="yes"]')

        const swapped = await readiness(page)

        expect(swapped.top).toBe('yes')
        expect(swapped.below).toBe(below)
        expect(page.errors).toEqual([])
      }
      finally {
        page.close()
      }
    }
  })
})
