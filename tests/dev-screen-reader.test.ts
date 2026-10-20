import type { ReadingItem } from '../src/runtime/dev-tool'
import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { readingFlags } from '../src/runtime/dev-tool'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const ROUTES = 'tests/fixtures/dev-screen-reader/src/routes'

// The tab's rows as the page shows them: role, accessible name, chips and flags.
function reading() {
  const root = document.querySelector('kay-dev')!.shadowRoot!

  return [...root.querySelectorAll('#kay-dev-screen-reader .entry')].map(row => [
    row.querySelector('.role')?.textContent,
    row.querySelector('.accname')?.textContent ?? '',
    [...row.querySelectorAll('.chips > *')].map(chip => chip.textContent),
    [...row.querySelectorAll('.issue span')].map(issue => issue.textContent),
  ])
}

// Opens the tab, once the tool is up.
function openTab() {
  document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-screen-reader')!.click()
}

const NAMES = [
  ['main', ''],
  ['heading 1', 'Names'],
  ['link', 'Home logo'],
  ['link', 'no name'],
  ['button', 'Close'],
  ['textbox', 'Wrapped'],
  ['button', 'First Second'],
  ['link', 'no name'],
  ['button', 'Submit'],
  ['button', 'Send'],
  ['textbox', 'Search'],
  ['button', 'Fake'],
  ['region', 'Related'],
  ['heading 2', 'Inner'],
  ['form', 'Search form'],
]
const SAME = 'Same name as 1 other link that goes elsewhere'
const NO_NAME = 'No accessible name'

const item = (kind: ReadingItem['kind'], name: string, rest: Partial<ReadingItem> = {}): ReadingItem => ({ element: {} as Element, kind, role: kind === 'link' ? 'link' : kind, name, ...rest })

describe('what the screen reader tab flags', () => {
  it('flags a skipped heading level, a first heading below h1 and an empty heading, but not a step back up', () => {
    const [first, third, second, fourth, empty] = [item('heading', 'A', { level: 1 }), item('heading', 'B', { level: 3 }), item('heading', 'C', { level: 2 }), item('heading', 'D', { level: 4 }), item('heading', '', { level: 4 })]
    const { items } = readingFlags([first, third, second, fourth, empty])

    expect(items.get(first)).toBeUndefined()
    expect(items.get(third)).toEqual(['Skips from h1 to h3'])
    expect(items.get(second)).toBeUndefined()
    expect(items.get(fourth)).toEqual(['Skips from h2 to h4'])
    expect(items.get(empty)).toEqual([NO_NAME])
  })

  it('flags links with one name going to different places, whatever the case, and none going to the same', () => {
    const [a, b, c, d, e] = [item('link', 'Read more', { target: '/a' }), item('link', 'read MORE', { target: '/b' }), item('link', 'Docs', { target: '/d' }), item('link', 'Docs', { target: '/d' }), item('link', 'Read more', { target: '/a' })]
    const { items } = readingFlags([a, b, c, d, e])

    expect(items.get(a)).toEqual(['Same name as 1 other link that goes elsewhere'])
    expect(items.get(b)).toEqual(['Same name as 2 other links that go elsewhere'])
    expect(items.get(e)).toEqual(['Same name as 1 other link that goes elsewhere'])
    expect(items.get(c)).toBeUndefined()
    expect(items.get(d)).toBeUndefined()
  })

  it('asks for a name on a link, control and field but not on a landmark, and for exactly one main', () => {
    const [link, control, field, landmark, main] = [item('link', '', { target: '/' }), item('control', ''), item('field', ''), item('landmark', '', { role: 'navigation' }), item('landmark', '', { role: 'main' })]
    const { items, page } = readingFlags([link, control, field, landmark, main])

    expect([link, control, field].map(each => items.get(each))).toEqual([[NO_NAME], [NO_NAME], [NO_NAME]])
    expect(items.get(landmark)).toBeUndefined()
    expect(items.get(main)).toBeUndefined()
    expect(page).toEqual([])
    expect(readingFlags([landmark]).page.map(issue => issue.text)).toEqual(['No main landmark, so a screen reader user cannot jump to the content'])
  })
})

describe.skipIf(path === undefined)('the screen reader tab of the dev tool', () => {
  let dev: TestSite
  // Pages left open hold a connection each to the dev server, and the browser allows six.
  const opened: TestPage[] = []
  const code = process.env.KAY_DEV_CODE

  beforeAll(async () => {
    // As under `kay dev`, which marks every element with its `.kay` position.
    process.env.KAY_DEV_CODE = '0'
    dev = await testSite({ routes: ROUTES, browser: { path }, dev: true, onError: () => undefined })
  }, 60_000)

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(async page => page.close()))
  })

  afterAll(async () => {
    if (code === undefined)
      delete process.env.KAY_DEV_CODE
    else
      process.env.KAY_DEV_CODE = code

    await dev?.close()
  })

  const open = async (route: string) => {
    const page = await dev.open(route, { strict: false })

    opened.push(page)

    return page
  }

  it('lists headings, landmarks, links, controls and fields in reading order with their accessible names, and flags what a person could not use', async () => {
    const page = await open('/')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 20)

    expect(await page.evaluate(reading)).toEqual([
      ['banner', '', [], []],
      ['navigation', 'Primary', [], []],
      ['link', 'Home', ['/'], []],
      ['link', 'Read more', ['/more'], [SAME]],
      ['main', '', [], []],
      ['heading 1', 'Reading order', [], []],
      ['heading 3', 'Third level', [], ['Skips from h1 to h3']],
      ['heading 2', 'Second level', [], []],
      ['link', 'Read more', ['/other'], [SAME]],
      ['link', 'Docs', ['/docs'], []],
      ['link', 'Docs', ['/docs'], []],
      ['link', 'no name', ['/nothing'], [NO_NAME]],
      ['link', 'Settings', ['/settings'], []],
      ['link', 'By title', ['/title'], []],
      ['link', 'Reading order', ['/labelled'], []],
      ['button', 'Go', [], []],
      ['button', 'Close', [], []],
      ['button', 'More', [], []],
      ['textbox', 'Email', ['required', 'described by: We never share it'], []],
      ['textbox', 'no name', [], [NO_NAME]],
      ['checkbox', 'Newsletter', [], []],
      ['combobox', 'Country', [], []],
      ['textbox', 'Message', ['required'], []],
      ['contentinfo', '', [], []],
    ])
  }, 60_000)

  it('works names out of images, labels, hidden content, aria-labelledby, button values and placeholders, and leaves out what is not rendered', async () => {
    const page = await open('/names')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 15)

    expect((await page.evaluate(reading)).map(row => [row[0], row[1]])).toEqual(NAMES)
  }, 60_000)

  it('reads the contents of open shadow roots and follows a change inside one', async () => {
    const page = await open('/other')

    await page.evaluate(() => {
      const host = document.createElement('div')

      host.attachShadow({ mode: 'open' }).innerHTML = '<button>Inside</button>'
      document.body.append(host)
      Object.assign(window, { host })
    })
    await page.evaluate(openTab)
    await page.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .accname')].some(name => name.textContent === 'Inside'))
    await page.evaluate(() => (window as unknown as { host: HTMLElement }).host.shadowRoot!.querySelector('button')!.setAttribute('aria-label', 'Renamed'))
    await page.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .accname')].some(name => name.textContent === 'Renamed'))
  }, 60_000)

  it('flags a page with no main landmark, one starting below a first level heading, and one with two mains', async () => {
    const page = await open('/other')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 3)

    expect(await page.evaluate(reading)).toEqual([
      ['page', '', [], ['No main landmark, so a screen reader user cannot jump to the content']],
      ['heading 2', 'Only a second level', [], ['Starts at h2, with no h1 before it']],
      ['link', 'Back', ['/'], []],
    ])

    const twice = await open('/twomains')

    await twice.evaluate(openTab)
    await twice.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 5)

    const page2 = 'A page has one main landmark, this one has 2'
    const main2 = 'One of 2 main landmarks'

    expect(await twice.evaluate(reading)).toEqual([
      ['page', '', [], [page2]],
      ['main', '', [], [main2]],
      ['heading 1', 'First', [], []],
      ['main', '', [], [main2]],
      ['heading 1', 'Second', [], []],
    ])
  }, 60_000)

  it('outlines the element of a row on hover or focus and names the .kay file it came from', async () => {
    const page = await open('/')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 20)

    const outlined = async (role: string, name: string, event: string) => page.evaluate((wanted, called, type) => {
      const root = document.querySelector('kay-dev')!.shadowRoot!
      const row = [...root.querySelectorAll<HTMLElement>('#kay-dev-screen-reader .entry')].find(entry => entry.querySelector('.role')?.textContent === wanted && entry.querySelector('.accname')?.textContent === called)!

      row.dispatchEvent(new Event(type))

      const box = root.querySelector<HTMLElement>('.outline:not([hidden])')
      const label = root.querySelector<HTMLElement>('.label:not([hidden])')
      const target = [...document.querySelectorAll('h3')].find(heading => heading.textContent === 'Third level')!.getBoundingClientRect()

      return {
        label: label?.textContent,
        match: box !== null && Math.abs(box.getBoundingClientRect().top - target.top) < 1,
        file: row.querySelector('.position')?.textContent,
      }
    }, role, name, event)

    const hovered = await outlined('heading 3', 'Third level', 'pointerenter')

    expect(hovered.match).toBe(true)
    expect(hovered.label).toMatch(/^h3\s+\S*index\.kay:\d+:\d+$/)
    expect(hovered.file).toMatch(/index\.kay:\d+:\d+$/)

    await page.evaluate(() => {
      const root = document.querySelector('kay-dev')!.shadowRoot!

      for (const row of root.querySelectorAll<HTMLElement>('#kay-dev-screen-reader .entry'))
        row.dispatchEvent(new Event('pointerleave'))
    })

    expect(await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.outline:not([hidden])').length)).toBe(0)
    expect((await outlined('heading 3', 'Third level', 'focus')).match).toBe(true)
  }, 60_000)

  it('follows a page swap and an island changing the page', async () => {
    const page = await open('/')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 20)

    // The island shows a link once its button is pressed.
    // The open drawer covers the page, and the island hydrates after the page shows.
    await page.waitUntil(() => {
      document.querySelector<HTMLButtonElement>('button.more')!.click()

      return document.querySelector('a.added') !== null
    })
    await page.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .accname')].some(name => name.textContent === 'Added'))

    // A script changing a name.
    await page.evaluate(() => document.querySelector('button.go')!.setAttribute('aria-label', 'Leave'))
    await page.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .accname')].some(name => name.textContent === 'Leave'))

    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('main a[href="/other"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length === 3)

    expect((await page.evaluate(reading)).map(row => row[0])).toEqual(['page', 'heading 2', 'link'])
  }, 60_000)

  it('counts what it flags on its tab and filters by problems', async () => {
    const page = await open('/')

    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-screen-reader .count:not([hidden])') !== null)
    expect(await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-screen-reader .count')!.textContent)).toBe('5')

    await page.evaluate(openTab)
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry').length >= 20)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-screen-reader .toolbar button')!.click())

    expect(await page.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-screen-reader .entry:not([hidden]) .accname')].map(name => name.textContent))).toEqual(['Read more', 'Third level', 'Read more', 'no name', 'no name'])
  }, 60_000)

  it('is no part of a production page', async () => {
    const prod = await testSite({ routes: ROUTES, dev: false })
    const visit = await prod.visit('/')

    expect(visit.html).not.toContain('/_kay/dev/')
    expect(visit.html).not.toContain('kay-dev')
    expect((await prod.fetch('/_kay/dev/tool.js')).status).toBe(404)
    await prod.close()
  })
})
