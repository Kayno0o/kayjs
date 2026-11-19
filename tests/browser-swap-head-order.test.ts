import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const chrome = browserPath()

const VARIANTS = [
  { name: 'production', options: {} },
  { name: 'a base', options: { config: { base: '/repo' } } },
  { name: 'trailingSlash always', options: { config: { trailingSlash: 'always' as const } } },
  { name: 'dev', options: { dev: true } },
]

// What a fresh load and a swap must leave the same: the head's styles and stylesheets in their order, and what the cascade makes of them.
async function cascade(page: TestPage) {
  return page.evaluate(() => ({
    order: [...document.head.querySelectorAll('style,link[rel=stylesheet]')].map(each => each.getAttribute('href') ?? each.textContent),
    padding: getComputedStyle(document.querySelector('.box')!).paddingTop,
  }))
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a swap leaving the head\'s styles in the order the next page serves them', () => {
  const sites: TestSite[] = []

  afterAll(async () => {
    for (const site of sites)
      await site.close()
  })

  async function visit(site: TestSite, start: string, ids: string[]) {
    await using page = await site.open(start, { strict: false })

    await page.waitFor('button.count')

    // A property of the window survives a swap only: a page that loaded afresh would lose it.
    await page.evaluate(() => void Object.assign(window, { swapped: true }))

    for (const id of ids) {
      await page.evaluate((target: string) => (document.querySelector(`#to-${target}`) as HTMLElement).click(), id)
      await page.waitUntil((target: string) => document.querySelector('h1')?.textContent?.toLowerCase() === target, { timeout: '10s' }, id)
      // The stale styles go once the new ones loaded.
      await Bun.sleep(200)
      expect(await page.evaluate(() => (window as unknown as { swapped?: boolean }).swapped)).toBe(true)

      const swapped = await cascade(page)
      const path = await page.path()

      await using fresh = await site.open(path, { strict: false })

      await fresh.waitFor('button.count')
      expect(swapped).toEqual(await cascade(fresh))
      // The dev diagnostics name classes this fixture's cuts hold no rule for.
      expect(page.errors.filter(error => !error.startsWith('[kay] the class'))).toEqual([])
    }
  }

  for (const { name, options } of VARIANTS) {
    describe(name, () => {
      const start = (path: string) => `${options.config?.base ?? ''}${path}`
      let site: TestSite | undefined
      const opened = async () => {
        if (site === undefined) {
          site = await testSite({ root: 'tests/fixtures/swap-head-order', browser: { path: chrome }, ...options })
          sites.push(site)
        }

        return site
      }

      it('puts the next page\'s own cut before the shared block, and the layer order is the fresh one', async () => {
        await visit(await opened(), start('/a'), ['b'])
      }, 120_000)

      it('holds it going back and forth', async () => {
        await visit(await opened(), start('/a'), ['b', 'a', 'b', 'a'])
      }, 120_000)

      it('holds it to a page with no styles of its own, and from it', async () => {
        await visit(await opened(), start('/a'), ['c', 'b'])
      }, 120_000)

      it('moves a kept block the next page serves in another order', async () => {
        await visit(await opened(), start('/a'), ['reversed', 'a', 'reversed'])
      }, 120_000)

      it('holds it for a linked sheet and an inlined block', async () => {
        await visit(await opened(), start('/a'), ['linked', 'b', 'linked', 'reversed'])
      }, 120_000)
    })
  }
})
