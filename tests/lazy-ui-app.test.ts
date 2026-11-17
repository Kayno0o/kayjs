import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const PRELOADS = /<link rel="modulepreload" href="([^"]*)"/g
const FIXTURE = 'tests/fixtures/lazy-app'

function heavyChunk(html: string): string | undefined {
  return [...html.matchAll(PRELOADS)].map(match => match[1]!).find(href => (/heavy-\w+\.js$/).test(href))
}

describe('a component an island draws lazily', () => {
  for (const [name, options] of [['at the root', {}], ['under a base with a trailing slash', { base: '/blog', trailingSlash: 'always' as const }]] as const) {
    it(`is preloaded by the page whose server drew it, and by no other, ${name}`, async () => {
      const site = await testSite({ root: FIXTURE, browser: true, ...options })

      try {
        const base = 'base' in options ? `${options.base}/` : '/'
        const drawn = await (await site.fetch(base)).text()
        const closed = await (await site.fetch(`${base}closed${'trailingSlash' in options ? '/' : ''}`)).text()
        const chunk = heavyChunk(drawn)

        expect(drawn).toMatch(/data-lazy="heavy-\w+"/)
        const chunks = await Promise.all([...drawn.matchAll(PRELOADS)].map(async match => (await site.fetch(match[1]!)).text()))

        // The runtime of lazy components ships in a shared chunk the page preloads, not inside the island that uses it.
        expect(chunks.filter(code => code.includes('failed to load, it draws when it is opened again'))).toHaveLength(1)
        expect(chunk).toBeString()

        if ('base' in options)
          expect(chunk!.startsWith(`${options.base}/`)).toBeTrue()

        expect(closed).not.toContain('data-lazy')
        expect(heavyChunk(closed)).toBeUndefined()
        expect((await site.fetch(chunk!)).status).toBe(200)
      }
      finally {
        await site.close()
      }
    }, 90_000)
  }
})
