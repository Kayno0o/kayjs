import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// The overlay's badges and the tab order problems the tool lists, read in the page.
function overlay() {
  const root = document.querySelector('kay-dev')!.shadowRoot!

  return {
    badges: [...root.querySelectorAll('.tab-badge')].map(badge => [badge.textContent, badge.className.replace('tab-badge', '').trim()]),
    lines: root.querySelectorAll('.tab-order path').length,
    jumps: root.querySelectorAll('.tab-order path.jump').length,
    traps: root.querySelectorAll('.tab-trap').length,
    problems: [...root.querySelectorAll('#kay-dev-problems .problem pre')].map(pre => pre.textContent.split('\n').slice(0, -1).join('\n')).filter(text => (/^a11y (?:tab-order|focus-not|keyboard)/).test(text)),
  }
}

describe.skipIf(path === undefined)('the tab order overlay of the dev tool', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ routes: 'tests/fixtures/dev-tab-order/src/routes', browser: { path }, dev: true, onError: () => undefined })
  }, 60_000)

  afterAll(async () => dev?.close())

  it('numbers each element the keyboard reaches in Tab order, draws a line between them and flags what goes wrong', async () => {
    const page = await dev.open('/', { strict: false })

    expect(await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length)).toBe(0)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-problems .problem').length >= 4)

    const shown = await page.evaluate(overlay)

    // The element with a positive tabindex first, then the rest in the document's order, the inert one left out.
    expect(shown.badges).toEqual([['1', ''], ['2 !', 'jump'], ['3', ''], ['4', ''], ['5 !', 'hidden-focus'], ['6', '']])
    expect(shown.lines).toBe(5)
    expect(shown.jumps).toBe(1)
    expect(shown.traps).toBe(2)
    expect(shown.problems.map(problem => problem.slice(0, problem.indexOf(': ')))).toEqual(['a11y tab-order-jump', 'a11y focus-not-visible', 'a11y keyboard-trap', 'a11y keyboard-trap'])
    expect(shown.problems.map(problem => problem.split('\n').slice(1))).toEqual([['  body > main > slot > button'], ['  body > main > button:nth-of-type(2)'], ['  body > main > div:nth-of-type(2)'], ['  body > main > div:nth-of-type(1)']])
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  }, 60_000)

  it('follows a page swap and goes when switched off', async () => {
    const page = await dev.open('/', { strict: false })

    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 6)
    await page.click('a.top')
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 2)

    expect((await page.evaluate(overlay)).badges).toEqual([['1', ''], ['2', '']])

    // An island or a script adding an element.
    await page.evaluate(() => document.querySelector('main')!.append(Object.assign(document.createElement('button'), { textContent: 'Three' })))
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 3)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())

    expect((await page.evaluate(overlay)).badges).toEqual([])
  }, 60_000)
  it('checks focus again when a style change alters a focus ring', async () => {
    const page = await dev.open('/other', { strict: false })
    const state = async () => page.evaluate(overlay)

    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 2)

    expect((await state()).badges).toEqual([['1', ''], ['2', '']])

    await page.evaluate(() => document.querySelector<HTMLElement>('button.one')!.style.setProperty('outline', 'none'))
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge.hidden-focus').length === 1)

    expect((await state()).badges).toEqual([['1 !', 'hidden-focus'], ['2', '']])
    expect((await state()).problems.map(problem => problem.split('\n').slice(0, 2))).toEqual([['a11y focus-not-visible: Focus shows nothing on this element, give it an outline or a ring', '  body > main > button:nth-of-type(1)']])

    await page.evaluate(() => document.querySelector<HTMLElement>('button.one')!.style.removeProperty('outline'))
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge.hidden-focus').length === 0)

    expect((await state()).badges).toEqual([['1', ''], ['2', '']])
  }, 60_000)

  it('redraws a scroll frame from the stops already found and reads each rect once per change', async () => {
    const page = await dev.open('/other', { strict: false })

    await page.evaluate(() => {
      const counts = { rects: new Map<Element, number>(), queries: 0 }
      const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as (this: Element) => DOMRect
      const documentQuery = Object.getOwnPropertyDescriptor(Document.prototype, 'querySelectorAll')!.value as (this: Document, selector: string) => NodeListOf<Element>
      const elementQuery = Object.getOwnPropertyDescriptor(Element.prototype, 'querySelectorAll')!.value as (this: Element, selector: string) => NodeListOf<Element>

      Element.prototype.getBoundingClientRect = function (this: Element) {
        counts.rects.set(this, (counts.rects.get(this) ?? 0) + 1)

        return rect.call(this)
      }
      Document.prototype.querySelectorAll = function (this: Document, selector: string) {
        counts.queries++

        return documentQuery.call(this, selector)
      }
      Element.prototype.querySelectorAll = function (this: Element, selector: string) {
        counts.queries++

        return elementQuery.call(this, selector)
      }
      Object.assign(window, { counts })
      document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click()
    })
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 2)

    // One change: a tall block, so the page scrolls. Each stop's rect is read once for the badges, the lines, the jumps and the report.
    await page.evaluate(() => {
      const counts = (window as unknown as { counts: { rects: Map<Element, number>, queries: number } }).counts

      counts.rects.clear()
      document.body.append(Object.assign(document.createElement('div'), { style: 'height: 3000px' }))
    })
    await page.waitUntil(() => (window as unknown as { counts: { rects: Map<Element, number> } }).counts.rects.size >= 2)
    await page.evaluate(async () => new Promise(done => setTimeout(done, 400)))

    const change = await page.evaluate(() => [...document.querySelectorAll('main > button')].map(button => (window as unknown as { counts: { rects: Map<Element, number> } }).counts.rects.get(button)))

    expect(change).toEqual([1, 1])

    // A scroll frame: no query for the stops or the trap suspects, one rect per stop.
    await page.evaluate(async () => {
      const counts = (window as unknown as { counts: { rects: Map<Element, number>, queries: number } }).counts

      counts.rects.clear()
      counts.queries = 0
      window.scrollTo(0, 40)
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    })

    const scroll = await page.evaluate(() => {
      const counts = (window as unknown as { counts: { rects: Map<Element, number>, queries: number } }).counts

      return { queries: counts.queries, rects: [...document.querySelectorAll('main > button')].map(button => counts.rects.get(button)) }
    })

    expect(scroll.rects).toEqual([1, 1])
    expect(scroll.queries).toBe(0)
  }, 60_000)

  it('still checks the focus ring around a button holding focus, and gives it focus back', async () => {
    const page = await dev.open('/other', { strict: false })

    await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('button.two')!

      button.style.setProperty('outline', 'none')
      button.focus()
    })
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge.hidden-focus').length === 1)

    const active = await page.evaluate(() => document.activeElement?.className)

    page.close()
    expect(active).toBe('two')
  }, 60_000)

  it('numbers focusable elements inside open shadow roots and leaves focus in a closed one', async () => {
    const page = await dev.open('/other', { strict: false })

    await page.evaluate(() => {
      const open = document.createElement('div')
      const closed = document.createElement('div')
      const slotted = document.createElement('div')

      open.className = 'open'
      open.attachShadow({ mode: 'open' }).innerHTML = '<button class="inner">Inner</button>'
      slotted.className = 'slotted'
      slotted.attachShadow({ mode: 'open' }).innerHTML = '<button class="before">Before</button><slot></slot>'
      slotted.append(Object.assign(document.createElement('button'), { className: 'light', textContent: 'Light' }))
      closed.className = 'closed'

      const root = closed.attachShadow({ mode: 'closed' })

      root.innerHTML = '<input class="field">'
      Object.assign(window, { closedRoot: root })
      document.querySelector('main')!.append(open, slotted, closed)
      root.querySelector('input')!.focus()
    })
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 5)

    // The closed root's field is out of reach of the tool, but it is focused where it was after the check.
    expect(await page.evaluate(() => [document.activeElement?.className, (window as unknown as { closedRoot: ShadowRoot }).closedRoot.activeElement?.className])).toEqual(['closed', 'field'])
    expect((await page.evaluate(overlay)).badges.map(badge => badge[0])).toEqual(['1', '2', '3', '4', '5'])

    // A change inside an open root is read too.
    await page.evaluate(() => document.querySelector('.open')!.shadowRoot!.append(Object.assign(document.createElement('button'), { textContent: 'More' })))
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 6)
  }, 60_000)

  // A host with a tabindex is the page's active element whether it holds focus itself or an element of its closed root does, so the check cannot tell and leaves focus alone.
  it.each([['delegating focus', true], ['without delegating focus', false]])('leaves focus where it was in the closed root of a focusable host %s', async (_name, delegatesFocus) => {
    const page = await dev.open('/other', { strict: false })

    await page.evaluate((delegates) => {
      const host = document.createElement('div')
      const root = host.attachShadow({ mode: 'closed', delegatesFocus: delegates })

      host.tabIndex = 0
      host.className = 'host'
      root.innerHTML = '<input class="first"><input class="second">'
      Object.assign(window, { hostRoot: root })
      document.querySelector('main')!.append(host)
      root.querySelector<HTMLInputElement>('.second')!.focus()
    }, delegatesFocus)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length >= 2)
    // Nothing else moves focus, so the check had its turn once the overlay drew.
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-order path').length >= 1)

    const active = await page.evaluate(() => [document.activeElement?.className, (window as unknown as { hostRoot: ShadowRoot }).hostRoot.activeElement?.className])

    page.close()
    expect(active).toEqual(['host', 'second'])
  }, 60_000)
})
