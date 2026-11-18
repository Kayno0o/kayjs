import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath, testSite } from '../src/test'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const path = browserPath()
const ROOT = 'tests/fixtures/client-query'

// A plain file server, as a static host is: the page found as `<path>.html` or `<path>/index.html`, whatever the query.
function serveDirectory(dir: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      for (const candidate of [pathname, `${pathname}.html`, `${pathname.replace(/\/$/, '')}/index.html`]) {
        const file = Bun.file(`${dir}${candidate}`)

        if (!candidate.endsWith('/') && await file.exists())
          return new Response(file)
      }

      return new Response('Not found', { status: 404 })
    },
  })
}

// Each place the query is read shows it: an island rendered in the browser through its own signal and through one shared by islands, as an app keeps the open dialog or a range.
async function shows(view: TestPage, text: string): Promise<void> {
  for (const selector of ['p.client', 'p.shared'])
    await view.waitFor(selector, { text })
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a client-rendered island and the query of a swap', () => {
  let site: TestSite
  let files: ReturnType<typeof Bun.serve>
  const modes: Record<string, (url: string) => Promise<TestPage>> = {
    server: async url => site.open(url),
    static: async url => browse(`${files.url.origin}${url}`, { path }),
  }

  beforeAll(async () => {
    const outdir = await scratchDir('client-query-')
    const built = await kayBuild([ROOT, '--no-check', '--static', '--outdir', outdir], { NODE_ENV: 'production' })

    expect(built.code).toBe(0)
    files = serveDirectory(outdir)
    site = await testSite({ root: ROOT, browser: { path } })
  }, 120_000)

  afterAll(async () => {
    await files?.stop(true)
    await site?.close()
  })

  for (const [mode, open] of Object.entries(modes)) {
    describe(`on a ${mode} build`, () => {
      it('reads the new query after a swap to the same path, and the old one after Back and Forward', async () => {
        const view = await open('/')

        await shows(view, 'x=none')
        await view.click('a.one')
        await shows(view, 'x=1')
        await view.click('a.two')
        await shows(view, 'x=2')
        await view.back()
        await shows(view, 'x=1')
        await view.back()
        await shows(view, 'x=none')
        await view.forward()
        await shows(view, 'x=1')

        expect(view.errors).toEqual([])
      }, 60_000)

      it('draws an island that reads the query from the address it is opened at, without a mismatch, and claims the markup of the default one', async () => {
        const view = await open('/tabs?x=b')

        await view.waitFor('p.tab', { text: 'Tab b' })
        await view.click('button.count')
        await view.waitFor('button.count', { text: 'Clicked 1' })

        expect(view.errors).toEqual([])

        const plain = await open('/tabs')

        await plain.click('button.count')
        await plain.waitFor('button.count', { text: 'Clicked 1' })
        await plain.waitFor('p.tab', { text: 'Tab a' })
        await plain.click('a.b')
        await plain.waitFor('p.tab', { text: 'Tab b' })
        await plain.back()
        await plain.waitFor('p.tab', { text: 'Tab a' })

        expect(plain.errors).toEqual([])
      }, 60_000)

      it('reads the query of the page a swap to another path reaches', async () => {
        const view = await open('/?x=1')

        await shows(view, 'x=1')
        await view.click('a.other')
        await shows(view, 'x=none')
        await view.back()
        await shows(view, 'x=1')

        expect(view.errors).toEqual([])
      }, 60_000)
    })
  }
})
