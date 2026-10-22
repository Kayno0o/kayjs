import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the dev patch in a browser', () => {
  it('applies an edit under navigation: false, leaving a class a script added and the scroll, and loads a page with a changed island fully', async () => {
    const dev = await testSite({ root: 'tests/fixtures/patch', browser: { path }, dev: true, navigation: false })

    try {
      const shown = await dev.open('/')

      // The page ships the live reload and kay dev's own scripts but no entry script, and the module comes from the server.
      expect(await shown.count('script[src]:not([src^="/_kay/dev/"])')).toBe(0)

      const outcome = await shown.evaluate(async () => {
        const module = '/_kay/dev/patch.js'
        const { patch } = await import(module) as { patch: (before: Document, after: Document) => boolean }
        const html = await (await fetch(location.href)).text()
        const parse = (text: string) => new DOMParser().parseFromString(text, 'text/html')

        document.querySelector('.bar')!.classList.add('in-view')
        scrollTo(0, 1500)

        const edited = patch(parse(html), parse(html.replace('Old', 'New').replace('<title>Patch', '<title>Next')))
        const island = patch(parse(html), parse(html.replace('</h1>', '</h1><slot data-component="x"></slot>')))

        return { edited, island, bar: document.querySelector('.bar')!.className, note: document.querySelector('.note')!.textContent, title: document.title, scroll: scrollY }
      })

      expect(outcome).toEqual({ edited: true, island: false, bar: 'bar in-view', note: 'New', title: 'Next', scroll: 1500 })
    }
    finally {
      await dev.close()
    }
  }, 60_000)
})
