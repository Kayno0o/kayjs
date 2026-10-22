import type { TestPage, TestSite } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { eagerJs } from '../scripts/eager-js'
import { clientOptionsOf, PRODUCTION } from '../src/project'
import { LEFT_ALONE, spaced } from '../src/runtime/french'
import { frenchSpaces } from '../src/server/typography'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const messages = resolve('tests/fixtures/french-islands/src/messages')
const N = '\u00A0'
const THIN = '\u202F'
// A string only the code spacing an island's text holds.
const CODE = 'code,pre,kbd,samp,script,style,textarea'
const sites: TestSite[] = []

afterAll(async () => {
  await Promise.all(sites.map(async site => site.close()))
})

async function made(options: Parameters<typeof testSite>[0]): Promise<TestSite> {
  const site = await testSite({ root: 'tests/fixtures/french-islands', browser: { path }, ...options })

  sites.push(site)

  return site
}

async function open(options: Parameters<typeof testSite>[0], at = '/'): Promise<{ site: TestSite, page: TestPage }> {
  const site = await made(options)

  return { site, page: await site.open(at) }
}

// The text of each part of the island, a non-breaking space shown as `~`.
async function shown(page: TestPage): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}

    for (const name of ['total', 'label', 'mixed', 'code', 'pre'])
      out[name] = document.querySelector(`.counter .${name}`)!.textContent.replaceAll('\u00A0', '~').replaceAll('\u202F', '^')

    out.branch = [...document.querySelector('.counter')!.childNodes].filter(node => node.nodeType === 3).map(node => (node as Text).data).join('|').replaceAll('\u00A0', '~').replaceAll('\u202F', '^')

    return out
  })
}

async function ships(page: TestPage): Promise<boolean> {
  return page.evaluate(async (needle: string) => {
    const urls = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => new URL(name).pathname.endsWith('.js'))

    for (const url of urls) {
      if ((await (await fetch(url)).text()).includes(needle))
        return true
    }

    return false
  }, CODE)
}

async function press(page: TestPage, button: string, changes: string): Promise<void> {
  const before = await page.text(changes)

  await page.click(`button.${button}`)
  await page.waitUntil((selector: string, was: string) => document.querySelector(selector)!.textContent !== was, {}, changes, before ?? '')
}

describe('the French spaces in the text an island writes', () => {
  it('has the same spaces as the markup the server writes, for any text', () => {
    const texts = ['Total : 3 !', 'Il dit : « Qu\'est-ce que c\'est ? »', `Oui${N}: non${THIN}! « a${THIN}» b${N}; c`, 'À 12:30 sur http://a.fr:80/x?y=1 ; fin', 'a  : b', '« : »', '', ' ', '« ', ' :', 'x ;;; y', 'Tom & Jerry : fin', 'ligne\n: deux', '12 : 30']

    for (const text of texts)
      expect(spaced(text, true)).toBe(frenchSpaces(`<p>${text}</p>`).slice(3, -4))
  })

  it('leaves the same elements alone in the browser as on the server', () => {
    for (const tag of ['code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea'])
      expect(frenchSpaces(`<${tag}>a : b</${tag}>`), tag).toBe(`<${tag}>a : b</${tag}>`)

    expect(LEFT_ALONE.split(',').toSorted()).toEqual(['code', 'kbd', 'pre', 'samp', 'script', 'style', 'textarea'])
  })

  it('is asked of the client build by a French lang or locale, and not by anything else or `typography: false`', () => {
    const french = (config: Parameters<typeof clientOptionsOf>[0]) => clientOptionsOf(config, PRODUCTION).french
    const locales = (list: string[]) => ({ locales: list, defaultLocale: list[0]! })

    expect([{ lang: 'fr' }, { lang: 'fr-CA' }, { lang: 'FR' }, { i18n: locales(['en', 'fr']) }, { i18n: locales(['en', 'fr-BE']) }].map(config => french(config))).toEqual([true, true, true, true, true])
    expect([{}, { lang: 'en' }, { lang: 'fro' }, { lang: 'fr', typography: false }, { i18n: locales(['en', 'de']) }, { lang: 'fr', i18n: locales(['en', 'de']) }, { i18n: locales(['en', 'fr']), typography: false }].map(config => french(config))).toEqual([false, false, false, false, false, false, false])
    expect(clientOptionsOf({ lang: 'fr', base: '/docs' }, { dev: true, underKayDev: true }).french).toBe(true)
  })
})

// What the island spacing adds to the gzipped JS a page loads up front, hashed chunk names included.
const FRENCH_COST = 340
const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g

async function eager(site: TestSite): Promise<number> {
  const html = (await site.visit('/')).html
  const loaded = await eagerJs([...html.matchAll(SCRIPT_URL)].map(match => match[1]!), async url => (await site.fetch(url)).text())

  return loaded.values().reduce((sum, { size }) => sum + size, 0)
}

describe('what the island spacing costs', () => {
  it('adds nothing to a site in another language and a few bytes to a French one', async () => {
    // Each site builds into the one output the sites of a process share, so it is measured before the next is made.
    const sized = async (options: Parameters<typeof testSite>[0]) => eager(await made({ minify: true, ...options }))
    const plain = await sized({ lang: 'en' })
    const silent = await sized({ lang: 'fr', typography: false })
    const spaced = await sized({ lang: 'fr' })

    expect(Math.abs(silent - plain)).toBeLessThanOrEqual(12)
    expect(spaced - plain, `${spaced} against ${plain} bytes`).toBeGreaterThan(100)
    expect(spaced - plain, `${spaced} against ${plain} bytes`).toBeLessThanOrEqual(FRENCH_COST)
  }, 120_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a French page in a browser', () => {
  it('keeps the server\'s spaces when the island hydrates, in a block\'s own text too, and writes them on every update', async () => {
    const { page } = await open({ lang: 'fr' })
    const start = await shown(page)

    expect(start).toEqual({ total: 'Total~: 0~!', label: 'Début', mixed: 'Prix~: Début~?', code: 'Début', pre: 'Ligne : Début', branch: 'Reste~: |0|~!' })

    await press(page, 'plus', '.counter .label')

    expect(await shown(page)).toEqual({ total: 'Total~: 1~!', label: 'Reste~: 1~!', mixed: 'Prix~: Reste~: 1~!~?', code: 'Reste : 1 !', pre: 'Ligne : Reste : 1 !', branch: 'Reste~: |1|~!' })
    expect(page.errors).toEqual([])
  }, 60_000)

  it('writes them in a block shown after load, and leaves what was typed and what is no punctuation', async () => {
    const { page } = await open({ lang: 'fr' })

    await page.click('button.toggle')
    await page.click('button.toggle')
    await page.click('button.plus')
    await page.waitUntil(() => document.querySelector('.counter .label')!.textContent !== 'Début')

    expect((await shown(page)).branch).toBe('Reste~: |1|~!')

    await press(page, 'typed', '.counter .label')
    expect((await shown(page)).label).toBe('Déjà~: fin^! «~a~». 12:30 http://a.fr:80/x?y=1')
  }, 60_000)

  it('writes them in the static text of an element built in the browser, a block shown later or a row, and not inside code', async () => {
    const { page } = await open({ lang: 'fr' })
    const late = async () => page.evaluate(() => [...document.querySelectorAll('.late > *')].map(element => `${element.className}=${element.textContent.replaceAll('\u00A0', '~')}`))

    expect(await late()).toEqual(['row=Ligne~: un~?'])

    await page.click('button.open')
    await page.waitFor('p.fresh')

    expect(await late()).toEqual(['fresh=Tard~: fin~!', 'fresh-code=Tard : fin Début', 'row=Ligne~: un~?', 'row=Ligne~: deux~?'])
    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows a value that is markup as text, spaced', async () => {
    const { page } = await open({ lang: 'fr-CA' })

    await press(page, 'hostile', '.counter .label')

    expect(await shown(page)).toMatchObject({ label: '<b>x</b>~: y', code: '<b>x</b> : y' })
    expect(await page.count('.counter .label b')).toBe(0)
  }, 60_000)

  it('ships that code to a French site only', async () => {
    const french = await open({ lang: 'fr' })

    expect(await ships(french.page)).toBe(true)

    for (const options of [{ lang: 'en' }, {}, { lang: 'fr', typography: false }, { i18n: { locales: ['en', 'de'], defaultLocale: 'en', messages } }]) {
      const { page } = await open(options)

      expect(await ships(page), JSON.stringify(options)).toBe(false)
      await press(page, 'plus', '.counter .label')
      expect(await shown(page)).toMatchObject({ total: 'Total : 1 !', label: 'Reste : 1 !' })
    }
  }, 120_000)

  it('follows the locale of the page on a site with several', async () => {
    const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages }
    const english = await open({ i18n }, '/')
    const french = await open({ i18n }, '/fr')

    expect(await ships(english.page)).toBe(true)
    expect((await shown(english.page)).total).toBe('Total : 0 !')
    expect((await shown(french.page)).total).toBe('Total~: 0~!')
    await press(english.page, 'plus', '.counter .label')
    await press(french.page, 'plus', '.counter .label')
    expect((await shown(english.page)).label).toBe('Reste : 1 !')
    expect((await shown(french.page)).label).toBe('Reste~: 1~!')
  }, 120_000)
})
