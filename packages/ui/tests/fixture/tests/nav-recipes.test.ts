import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// One site and one browser for every test of the file; each test opens and closes its own page.
let built: ReturnType<typeof testSite> | undefined
const shared = async () => built ??= testSite({ root: ROOT, browser: { path } })

afterAll(async () => {
  if (built)
    (await built).close()
})

// CI installs Chromium: there, a missing browser fails rather than skipping.
const inBrowser = describe.skipIf(path === undefined && (process.env.CI ?? '') === '')

// The test browser has no hover-capable pointer, so Tailwind's hover: rules, kept behind (hover: hover), never apply: the sheets are rewritten with that query always true, the cascade and layers kept.
async function hoverable(page: { evaluate: (run: () => void) => Promise<unknown> }) {
  return page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode as HTMLElement | null

      if (!owner)
        continue

      const style = document.createElement('style')

      style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n').replaceAll('(hover: hover)', 'all')
      owner.after(style)
      owner.remove()
    }
  })
}

inBrowser('navigation recipes in the browser', () => {
  test('Breadcrumb keeps its ellipsis and middle items to a phone, and draws a separator between the others', async () => {
    const site = await shared()
    const read = async (width: number) => {
      await using page = await site.open('/nav-recipes', { width })
      const seen = await page.evaluate(() => {
        const shown = (element: Element) => getComputedStyle(element).display !== 'none'
        const items = [...document.querySelectorAll('#crumbs [data-part=item]')]

        return {
          more: shown(document.querySelector('#crumbs [data-part=more]')!),
          items: items.map(shown),
          // The separator is the ::before of every shown item or ellipsis that has a sibling before it.
          separators: [...document.querySelectorAll('#crumbs [data-part=list] > li')].map(item => getComputedStyle(item, '::before').content),
        }
      })

      expect(page.errors).toEqual([])

      return seen
    }
    const phone = await read(390)
    const desktop = await read(1000)

    expect(phone.more).toBe(true)
    expect(phone.items).toEqual([true, false, true, true])
    expect(desktop.more).toBe(false)
    expect(desktop.items).toEqual([true, true, true, true])
    // The first has no separator; every item after it draws one, the ellipsis included.
    expect(phone.separators[0]).toBe('none')
    expect(phone.separators.slice(1).every(content => content !== 'none' && content !== 'normal')).toBe(true)
    expect(desktop.separators[0]).toBe('none')
    expect(desktop.separators.slice(1).every(content => content !== 'none' && content !== 'normal')).toBe(true)
  }, 120_000)

  test('Pagination draws its step in the control line of the space skin, at --kui-border-width, and dims a span step', async () => {
    const site = await shared()

    await using page = await site.open('/nav-recipes', { width: 1000 })

    await hoverable(page)
    const read = async (css: string) => page.evaluate((style: string) => {
      document.documentElement.setAttribute('style', style)
      const [previous, next] = [...document.querySelectorAll<HTMLElement>('#paging [data-part=step]')]
      const look = (element: HTMLElement) => {
        const computed = getComputedStyle(element)

        return { tag: element.tagName, width: computed.borderTopWidth, colour: computed.borderTopColor, opacity: computed.opacity, text: computed.color }
      }

      const probe = document.body.appendChild(document.createElement('i'))

      probe.style.borderTop = '1px solid var(--color-kui-field-border)'
      const field = getComputedStyle(probe).borderTopColor

      probe.remove()

      return { previous: look(previous!), next: look(next!), field }
    }, css)
    const plain = await read('')

    expect(plain.previous.tag).toBe('SPAN')
    expect(plain.next.tag).toBe('A')
    expect(plain.previous.width).toBe('1px')
    expect(plain.previous.opacity).toBe('0.5')
    expect(plain.next.opacity).toBe('1')
    // Both steps draw the space skin's field border, which the skin also holds at 1px whatever --kui-border-width says.
    expect(plain.previous.colour).toBe(plain.next.colour)
    expect(plain.next.colour).toBe(plain.field)
    expect((await read('--kui-border-width: 3px')).next.width).toBe('1px')

    // Hovering the link lights its text, and a span keeps the text colour it has.
    const before = await read('')

    await page.hover('#paging a[data-part=step]')
    await Bun.sleep(400)
    const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('#paging a[data-part=step]')!).color)

    expect(hovered).not.toBe(before.next.text)
    await page.hover('#paging span[data-part=step]')
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#paging span[data-part=step]')!).color)).toBe(before.previous.text)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('a current TabNav, SiteNav and Tabs link stays accent while it is hovered', async () => {
    const site = await shared()

    // From lg the SiteNav links sit in a row; below it they fold behind the toggle.
    await using page = await site.open('/nav-recipes', { width: 1200 })

    await hoverable(page)
    const colour = async (selector: string) => page.evaluate((target: string) => getComputedStyle(document.querySelector(target)!).color, selector)
    const cases = {
      tabNav: '#tab-nav [aria-current=page]',
      siteNav: '#site-nav [aria-current=page]',
      tabs: '#tabs [role=tab][aria-selected=true]',
    }
    const other = {
      tabNav: '#tab-nav a:not([aria-current])',
      siteNav: '#site-nav a:not([aria-current])',
      tabs: '#tabs [role=tab][aria-selected=false]',
    }

    for (const [name, selector] of Object.entries(cases)) {
      const resting = await colour(selector)
      const rest = await colour(other[name as keyof typeof other])

      await page.hover(selector)
      await Bun.sleep(400)
      expect(await colour(selector), name).toBe(resting)
      // The hover lights another link, so the test sees a hover that does recolour.
      await page.hover(other[name as keyof typeof other])
      await Bun.sleep(400)
      expect(await colour(other[name as keyof typeof other]), name).not.toBe(rest)
      expect(await colour(selector), name).toBe(resting)
    }

    expect(page.errors).toEqual([])
  }, 120_000)

  test('Steps marks the current step in the accent, a completed one by its accent outline, and an upcoming one plain', async () => {
    const site = await shared()

    await using page = await site.open('/nav-recipes', { width: 1000 })
    const markers = await page.evaluate(() => [...document.querySelectorAll('#steps [data-part=item]')].map((item) => {
      const marker = getComputedStyle(item.querySelector('[data-part=marker]')!)
      const label = getComputedStyle(item.querySelector('[data-part=label]')!)

      return { state: item.getAttribute('data-state'), ground: marker.backgroundColor, border: marker.borderTopColor, text: marker.color, weight: label.fontWeight }
    }))
    const [done, current, upcoming] = markers

    expect(markers.map(marker => marker.state)).toEqual(['done', 'current', 'upcoming', 'upcoming'])
    // The current marker is filled with the accent, a completed one only outlined and tinted by it.
    expect(current!.ground).not.toBe('rgba(0, 0, 0, 0)')
    expect(current!.border).toBe(current!.ground)
    expect(done!.ground).toBe('rgba(0, 0, 0, 0)')
    expect(done!.border).toBe(current!.border)
    expect(done!.text).toBe(current!.border)
    expect(upcoming!.border).not.toBe(current!.border)
    expect(upcoming!.ground).toBe('rgba(0, 0, 0, 0)')
    expect(current!.weight).toBe('500')
    expect(upcoming!.weight).toBe('400')
    expect(page.errors).toEqual([])
  }, 120_000)
})
