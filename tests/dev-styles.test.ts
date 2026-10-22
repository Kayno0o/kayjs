import type { TestSite } from '../src/test'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { neededClasses } from '../src/runtime/dev-styles'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const WARNING = /^\[kay\] the class "([^"]+)" is set on <(\w+)>/

describe('the class check of the dev server', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ root: 'tests/fixtures/dev-styles', plugins: [tailwind], browser: path === undefined ? false : { path }, dev: true, onError: () => undefined })
  }, 120_000)

  afterAll(async () => dev?.close())

  it('loads on its pages with the classes the page carries a rule for', async () => {
    const html = (await dev.visit('/')).html

    expect(html).toContain('<script type="module" src="/_kay/dev/styles.js"></script>')
    expect(html).toMatch(/<script type="application\/json" data-kay-page-classes>\[[^\]]*"font-bold"[^\]]*\]<\/script>/)
    expect(html).not.toMatch(/data-kay-page-classes>[^<]*"ring-4"/)
    expect(await (await dev.fetch('/_kay/dev/styles.js')).text()).toContain('startStyleCheck()')
  })

  it.skipIf(path === undefined)('logs a class the whole stylesheet styles but the page carries no rule for, once', async () => {
    const page = await dev.open('/', { strict: false })

    await page.waitUntil(() => document.querySelector('.tone') !== null)

    const found = page.errors.map(error => WARNING.exec(error)).filter(match => match !== null)

    expect(found.map(match => [match[1], match[2]])).toEqual([['ring-4', 'p']])
  })

  it.skipIf(path === undefined)('stays quiet for the classes a page carries a rule for, those an island adds on a click included', async () => {
    const quiet = await dev.open('/other', { strict: false })

    expect(quiet.errors.filter(error => WARNING.test(error))).toEqual([])

    const page = await dev.open('/late', { strict: false })

    await page.click('.late')
    await page.waitUntil(() => getComputedStyle(document.querySelector('.late')!).fontSize === '20px')
    expect(page.errors.filter(error => WARNING.test(error))).toEqual([])
  })

  it.skipIf(path === undefined)('stays quiet for a class only a nested :is() or a variant of another class styles, and for one nothing styles at all', async () => {
    const page = await dev.open('/nested', { strict: false })

    expect(page.errors.filter(error => WARNING.test(error))).toEqual([])
  })
})

describe('the classes a selector needs', () => {
  const needed = (selector: string) => {
    const found = new Set<string>()

    neededClasses(selector, found)

    return [...found]
  }

  it('leaves out those inside parentheses or brackets, and reads past a bracket held by an attribute string', () => {
    expect(needed('.prose .a:is(.b, .c)')).toEqual(['prose', 'a'])
    expect(needed('.group-open\\:rotate-90:is(:where(.group):is([open], :popover-open) *)')).toEqual(['group-open:rotate-90'])
    expect(needed('a[title="("] .b')).toEqual(['b'])
    expect(needed('a[title=\'\\\'(\'] .b')).toEqual(['b'])
  })

  it('reads hex escapes and non-ASCII names whole', () => {
    expect(needed('.\\32 xl\\:flex > .café')).toEqual(['2xl:flex', 'café'])
  })
})
