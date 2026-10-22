import type { TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the dev tool on its own fixture', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ root: 'tests/fixtures/dev-tool', browser: { path }, dev: true, security: { csp: { 'style-src': ['\'self\''] } } })
  }, 60_000)

  afterAll(async () => dev?.close())

  it('draws, moves and docks under a policy refusing inline styles, styled through its adopted sheet and the CSSOM alone', async () => {
    const view = await dev.open('/')

    try {
      await view.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('.bar') !== null)

      // The policy holds: a style attribute the page adds is refused.
      const refused = await view.evaluate(async () => {
        const blocked = new Promise<string>(resolve => document.addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), { once: true }))
        const marked = document.createElement('div')

        marked.setAttribute('style', 'color: red')
        document.body.append(marked)

        return blocked
      })

      expect(refused).toStartWith('style-src')

      const drawn = await view.evaluate(async () => {
        const violations: string[] = []

        document.addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.sourceFile}`))

        const root = document.querySelector('kay-dev')!.shadowRoot!
        const drawer = root.querySelector<HTMLElement>('.drawer')!

        root.querySelector<HTMLButtonElement>('.bar > button')!.click()

        const head = root.querySelector<HTMLElement>('.head')!
        const from = head.getBoundingClientRect()
        const start = drawer.getBoundingClientRect()
        const at = { clientX: from.left + 40, clientY: from.top + 10, pointerId: 1, bubbles: true, composed: true }

        head.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0 }))
        head.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: at.clientX + 60, clientY: at.clientY - 80 }))
        head.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: at.clientX + 60, clientY: at.clientY - 80 }))

        const moved = drawer.getBoundingClientRect()
        const radius = getComputedStyle(drawer).borderTopLeftRadius

        root.querySelector<HTMLButtonElement>('.dock button[aria-label="Dock to the bottom"]')!.click()
        await new Promise(resolve => requestAnimationFrame(resolve))

        return {
          position: getComputedStyle(drawer).position,
          radius,
          moved: [Math.round(moved.left - start.left), Math.round(moved.top - start.top)],
          padded: getComputedStyle(document.documentElement).paddingBottom,
          problems: [...root.querySelectorAll('#kay-dev-problems .problem pre')].map(pre => pre.textContent).filter(problem => !problem.startsWith('a11y ')),
          violations,
        }
      })

      expect(drawn.position).toBe('fixed')
      expect(drawn.radius).toBe('12px')
      expect(drawn.moved).toEqual([60, -80])
      expect(drawn.padded).not.toBe('0px')
      // The page's own refused attribute alone.
      expect(drawn.problems).toEqual(['blocked inline by style-src-attr'])
      expect(drawn.violations).toEqual([])
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('tells an SVG served under another name by the content type its fetch answered, not flagging it as oversized', async () => {
    const view = await dev.open('/')

    try {
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click())
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-images .image')?.textContent.includes('150x150') === true)

      const row = await view.evaluate(() => {
        const image = document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-images .image')!

        return [image.querySelector('.line')!.textContent, [...image.querySelectorAll('.chip')].map(chip => chip.textContent).find(chip => chip.includes('drawn')), [...image.querySelectorAll('.issue')].map(flag => flag.textContent)]
      })

      // Chromium draws an SVG without a size at 150x150, 88 times the pixels of 16x16.
      expect(row).toEqual(['/mark.png', '150x150 drawn 16x16', []])
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('lists what the page fetched with its kind and status, counting an error, leaving out the tool\'s own requests', async () => {
    const view = await dev.open('/')

    try {
      await view.evaluate(async () => {
        document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-network')!.click()
        await fetch('/nothing-here')
      })
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-network')?.textContent.includes('/nothing-here') === true)

      const listed = await view.evaluate(() => {
        const root = document.querySelector('kay-dev')!.shadowRoot!

        return {
          rows: [...root.querySelectorAll('#kay-dev-network .fetch')].map(row => `${row.querySelector('.name')!.textContent} ${row.querySelector('.line .pill')?.textContent ?? '-'} ${row.querySelector('.chip')!.textContent}`),
          count: root.querySelector('#kay-dev-tab-network .count')!.textContent,
        }
      })

      expect(listed.rows).toContain('/ 200 document')
      expect(listed.rows).toContain('/mark.png 200 image')
      expect(listed.rows).toContain('/nothing-here 404 fetch')
      expect(listed.rows.filter(row => row.includes('/_kay/dev/'))).toEqual([])
      expect(listed.count).toBe('1')
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('lists a page swap\'s own fetch under the page it brings', async () => {
    const view = await dev.open('/')

    try {
      // The island hydrated, the client script that swaps pages runs.
      await view.waitUntil(() => (document.querySelector('slot[data-component]') as { _$k?: boolean } | null)?._$k === true)
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-network')!.click())
      await view.click('a[href="/next"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-network h3')?.textContent.startsWith('This page, /next') === true)
      // The browser reports a request after it is done, so the row can come a moment after the page.
      await view.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-network .group')[0]?.querySelectorAll('.fetch .name') ?? []].some(name => name.textContent === '/next'))

      const sections = await view.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-network .group')].map(group => [group.querySelector('h3')!.firstChild!.textContent, [...group.querySelectorAll('.fetch')].map(row => `${row.querySelector('.name')!.textContent} ${row.querySelector('.chip')!.textContent}`)]))

      expect(sections[0]![0]).toBe('This page, /next')
      expect(sections[0]![1]).toContain('/next page')
      expect(sections[1]![0]).toBe('Before, /')
      expect(sections[1]![1]).toContain('/ document')
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('lists the page a swap took from a prefetch under the page it brings', async () => {
    const view = await dev.open('/')

    try {
      await view.waitUntil(() => (document.querySelector('slot[data-component]') as { _$k?: boolean } | null)?._$k === true)
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-network')!.click())
      // A hover long enough prefetches the page, well before the click that swaps to it.
      await view.evaluate(() => document.querySelector('a[href="/next"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
      await view.waitUntil(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/next')))
      await view.evaluate(async () => new Promise(resolve => setTimeout(resolve, 100)))
      await view.click('a[href="/next"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-network h3')?.textContent.startsWith('This page, /next') === true)
      await view.waitUntil(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-network .group')[0]?.querySelectorAll('.fetch .name') ?? []].some(name => name.textContent === '/next'))

      const rows = await view.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-network .group')].map(group => [...group.querySelectorAll('.fetch')].map(row => `${row.querySelector('.name')!.textContent} ${row.querySelector('.chip')!.textContent}`)))

      expect(rows[0]).toContain('/next page')
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('counts the Head and Images warnings on their tabs before either is opened, and follows a page swap', async () => {
    const view = await dev.open('/flagged', { height: 900 })
    const counts = async () => view.evaluate(() => {
      const shadow = document.querySelector('kay-dev')!.shadowRoot!
      const count = (id: string) => shadow.querySelector<HTMLElement>(`#kay-dev-tab-${id} .count`)!

      return { head: count('head').hidden === true ? '' : count('head').textContent, images: count('images').hidden === true ? '' : count('images').textContent }
    })

    try {
      // The drawer open on another tab, neither Head nor Images clicked.
      await view.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('#kay-dev-tab-env') != null)
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-env')!.click())
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-images .count:not([hidden])') !== null)
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-head .count:not([hidden])') !== null)

      const first = await counts()

      expect(Number(first.head)).toBeGreaterThan(0)
      expect(Number(first.images)).toBeGreaterThan(0)

      // Swapped in place: the counts follow the page brought.
      await view.waitUntil(() => (document.querySelector('slot[data-component]') as { _$k?: boolean } | null)?._$k === true)
      await view.click('a[href="/flagged-more"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-images .count:not([hidden])')?.textContent === '4')

      // A tab opened, then the page swapped.
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click())
      await view.click('a[href="/flagged"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-images .count:not([hidden])')?.textContent === '2')
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-head')!.click())
      await view.click('a[href="/flagged-more"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-tab-images .count:not([hidden])')?.textContent === '4')
      expect((await counts()).images).toBe('4')
    }
    finally {
      view.close()
    }
  }, 60_000)
})
