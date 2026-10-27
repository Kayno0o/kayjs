import type { I18nConfig } from '../src/config'
import type { TestSite } from '../src/test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eagerJs, scriptUrls } from '../scripts/eager-js'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy, scratchDir } from './scratch'

const chrome = browserPath()

// Apart from tests/i18n.test.ts, as one process serves one project and this one serves a copy whose island imports nothing of kay/i18n.
describe('an island of an app with locales', () => {
  let copy: string
  let site: TestSite

  beforeAll(async () => {
    copy = await fixtureCopy('i18n', true)
    await Bun.write(join(copy, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst shown = signal(false)\n---\ndiv\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href="/about") About\n')

    // An island writing no link, whose page ships none of the code localizing one.
    await Bun.write(join(copy, 'src/components/clicks.kay'), '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(type="button" onClick={() => count.set(value => value + 1)}) Clicked {count()}\n')
    await Bun.write(join(copy, 'src/routes/clicks.kay'), '---\nimport Clicks from \'../components/clicks.kay\'\n---\nh1 Clicks\nClicks\n')

    const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages' }

    // The French spacing of an island's text has its own budget, in tests/typography-islands.test.ts.
    site = await testSite({ root: copy, i18n, typography: false, browser: { path: chrome } })
  }, 60_000)

  afterAll(async () => {
    await site.close()
    await rm(copy, { recursive: true, force: true })
  })

  it.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('writes the links of an island that imports nothing of kay/i18n in the page\'s locale', async () => {
    const page = await site.open('/en')

    await page.click('button')
    expect(await page.evaluate(() => document.querySelector('a.revealed')?.getAttribute('href'))).toBe('/en/about')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('ships the code localizing links only to a page whose islands write one', async () => {
    const eager = async (path: string) => [...(await eagerJs(scriptUrls(await (await site.fetch(path)).text()), async url => (await site.fetch(url)).text())).values()].map(({ code }) => code).join('\n')

    expect(await eager('/en')).toContain('function localizedLink(')
    expect(await eager('/en/clicks')).not.toContain('function localizedLink(')
  })

  it('ships the error reporter of a server page, and no leave question while no island guards the page', async () => {
    const eager = [...(await eagerJs(scriptUrls(await (await site.fetch('/en')).text()), async url => (await site.fetch(url)).text())).values()].map(({ code }) => code)

    // This build is not minified, so the call is found by name.
    expect(eager.filter(code => code.includes('setErrorReporter((error'))).toHaveLength(1)
    expect(eager.filter(code => code.includes('"unhandledrejection"'))).toHaveLength(1)
    expect(eager.filter(code => code.includes('unsaved changes'))).toEqual([])
  })
})

describe('the code localizing links', () => {
  it('builds to nothing for a site without locales, which defines no KAY_I18N', async () => {
    const dir = await scratchDir('i18n-links-')
    // Imported for its side effect alone, as a compiled island writing a link imports it.
    const entry = join(dir, 'island.ts')

    try {
      await Bun.write(entry, `import ${JSON.stringify(join(import.meta.dir, '../src/runtime/i18n-links.ts'))}\n`)

      const bundled = async (define: string) => (await Bun.build({ entrypoints: [entry], target: 'browser', define: { KAY_BROWSER: 'true', KAY_I18N: define } })).outputs[0]!.text()

      expect(await bundled('true')).toContain('function localizedLink(')
      expect(await bundled('undefined')).not.toContain('localizedLink')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
