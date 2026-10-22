import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// The server's control, described by its own note and the hint it renders after it.
const SERVED = /aria-describedby="name-note (k[\w-]+)">.*class="kui-form-field-hint" data-part="hint" id="\1"/
// What the controls of the form-reset page hold when it loads.
const START = { agree: true, power: false, free: false, decks: ['films'], size: 'm', sort: null, level: 'b', tags: ['x', 'y'], title: 'Ada', bio: 'Hello', notes: '# Notes', range: [2, 8], icon: 'star', bare: 'star', heard: 'b', refd: true, form: 'x' }
// One site and one browser for every test of the file; each test opens and closes its own page.
let built: ReturnType<typeof testSite> | undefined
const shared = async () => built ??= testSite({ root: ROOT, browser: { path } })

afterAll(async () => {
  if (built)
    (await built).close()
})

// CI installs Chromium: there, a missing browser fails rather than skipping.
const inBrowser = describe.skipIf(path === undefined && (process.env.CI ?? '') === '')

inBrowser('in the browser', () => {
  test('Table starts every value of a stacked card at one edge, and keeps a wide column aligned to its end', async () => {
    const site = await shared()

    await using page = await site.open('/stacked')
    // Where the text of each cell of a table's first row starts and ends, and where its cell's content box ends.
    const edges = (selector: string) => page.evaluate((within: string) => [...document.querySelectorAll(`${within} .kui-table-row:first-child .kui-table-cell-body`)].map((body) => {
      const text = document.createRange()
      const cell = body.closest('td')!

      text.selectNodeContents(body)

      return { start: Math.round(text.getBoundingClientRect().left), end: Math.round(text.getBoundingClientRect().right), cellEnd: Math.round(cell.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(cell).paddingRight)) }
    }), selector)
    const [name, moons] = await edges('#narrow')

    expect(moons!.start).toBe(name!.start)
    expect(moons!.end).toBeLessThan(moons!.cellEnd)
    const [, wide] = await edges('#wide')

    expect(wide!.end).toBe(wide!.cellEnd)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Table with no rows hydrates on the markup the server rendered, an @empty slot alone or beside selectable and @bulk', async () => {
    const site = await shared()

    await using page = await site.open('/empty-table')

    expect(await page.count('.kui-empty-state-title')).toBe(2)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Table keeps a long unbroken value inside its stacked card, and its sort button 2rem tall', async () => {
    const site = await shared()

    await using page = await site.open('/stacked')
    const measured = await page.evaluate(() => {
      const card = document.querySelector('#long .kui-table-row')!.getBoundingClientRect()
      const value = document.querySelector('#long .kui-table-cell-body')!.getBoundingClientRect()

      return { cardEnd: card.right, valueEnd: value.right, sortHeight: document.querySelector('#long .kui-table-sort-btn')!.getBoundingClientRect().height, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) }
    })

    expect(measured.valueEnd).toBeLessThanOrEqual(measured.cardEnd)
    expect(measured.sortHeight).toBeGreaterThanOrEqual(2 * measured.rem)
  }, 120_000)
})

inBrowser('virtual Table', () => {
  // Scrolls a table's box and reports where its header row and the first drawn row sit against the box, once the window has followed.
  const scrolled = async (page: { evaluate: (...args: never[]) => Promise<unknown>, waitUntil: (...args: never[]) => Promise<void> }, within: string, top: number) => {
    await page.evaluate(((selector: string, to: number) => {
      document.querySelector(`${selector} .kui-table-wrap`)!.scrollTop = to
    }) as never, within as never, top as never)
    await page.waitUntil(((selector: string, to: number) => {
      const first = document.querySelector(`${selector} .kui-table-row`)

      return first !== null && Number(first.getAttribute('data-virtual-index')) * 30 > to / 4
    }) as never, undefined as never, within as never, top as never)

    return await page.evaluate(((selector: string) => {
      const box = document.querySelector(`${selector} .kui-table-wrap`)!.getBoundingClientRect()
      const thead = document.querySelector(`${selector} thead`)!
      const stack = getComputedStyle(thead).position
      // Wide, each header cell sticks; stacked, the block of sort buttons does.
      const head = (stack === 'sticky' ? thead : document.querySelector(`${selector} .kui-table-head-cell`)!).getBoundingClientRect()

      return { head: head.top - box.top, headVisible: head.bottom > box.top, stack, rows: document.querySelectorAll(`${selector} .kui-table-row`).length }
    }) as never, within as never) as { head: number, headVisible: boolean, stack: string, rows: number }
  }

  test('keeps its headers on top while it scrolls, wide, narrow and sorted', async () => {
    const site = await shared()

    await using page = await site.open('/virtual')

    for (const within of ['#wide', '#sorted']) {
      await page.waitFor(`${within} .kui-table-row`)
      const moved = await scrolled(page as never, within, 5000)

      expect(moved.headVisible, within).toBe(true)
      expect(Math.abs(moved.head), within).toBeLessThan(2)
      expect(moved.rows, within).toBeLessThan(60)
    }

    await page.waitFor('#narrow .kui-table-row')
    const stacked = await scrolled(page as never, '#narrow', 5000)

    // Stacked, the headers are one block of sort buttons, which is what stays.
    expect(stacked.stack).toBe('sticky')
    expect(Math.abs(stacked.head)).toBeLessThan(2)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps what is in view in place when the rows above it change height', async () => {
    const site = await shared()

    await using page = await site.open('/virtual')

    await page.waitFor('#wide .kui-table-row')
    await scrolled(page as never, '#wide', 6000)
    // Where a row sits against the box: the first by default, the one crossing the box's top edge, which the rows above it growing must not move.
    const placed = async (index: string | null) => page.evaluate(((wanted: string | null) => {
      const box = document.querySelector('#wide .kui-table-wrap')!.getBoundingClientRect()
      const rows = [...document.querySelectorAll('#wide .kui-table-row')]
      const row = wanted === null ? rows.find(one => one.getBoundingClientRect().bottom > box.top + 1) : rows.find(one => one.getAttribute('data-virtual-index') === wanted)

      return row === undefined ? null : { index: row.getAttribute('data-virtual-index'), offset: row.getBoundingClientRect().top - box.top, height: row.getBoundingClientRect().height }
    }) as never, index as never) as Promise<{ index: string, offset: number, height: number } | null>
    const before = (await placed(null))!

    await page.click('#wide #grow')
    await page.waitUntil((() => [...document.querySelectorAll('#wide .kui-table-row')].some(row => row.getBoundingClientRect().height > 80)) as never)
    await page.waitUntil((() => document.querySelector('#wide .kui-table-wrap')!.scrollHeight > 0 && [...document.querySelectorAll('#wide .kui-table-row')].every(row => row.getBoundingClientRect().height > 80)) as never)
    await page.evaluate((async () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))) as never)
    const after = await placed(before.index)

    expect(after).not.toBeNull()
    // The rows above it grew by dozens of pixels each, and the scroll followed.
    expect(Math.abs(after!.offset - before.offset)).toBeLessThan(4)
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('HoverCard and ZoomPane', () => {
  // The card's box and the anchor's, with whether the card is open.
  const boxes = async (page: { evaluate: (...args: never[]) => Promise<unknown> }, anchor: string) => page.evaluate(((selector: string) => {
    const card = document.querySelector<HTMLElement>('#card')!
    const box = card.getBoundingClientRect()
    const target = document.querySelector(selector)!.getBoundingClientRect()

    return { open: card.matches(':popover-open'), card: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, target: { left: target.left, right: target.right, top: target.top, bottom: target.bottom } }
  }) as never, anchor as never) as Promise<{ open: boolean, card: { left: number, right: number, top: number, bottom: number }, target: { left: number, right: number, top: number, bottom: number } }>

  test('sits below the SVG node the pointer is on, follows the focused button, and closes when nothing is hovered', async () => {
    const site = await shared()

    await using page = await site.open('/hover-card')

    await page.hover('#node-1')
    await page.waitUntil(() => document.querySelector('#card')?.matches(':popover-open'))
    const node = await boxes(page, '#node-1')

    expect(node.card.top).toBeGreaterThanOrEqual(node.target.bottom - 1)
    expect(Math.abs((node.card.left + node.card.right) / 2 - (node.target.left + node.target.right) / 2)).toBeLessThan(2)

    await page.hover('#node-2')
    await page.waitUntil(() => Math.abs(document.querySelector('#card')!.getBoundingClientRect().left + document.querySelector('#card')!.getBoundingClientRect().width / 2 - (document.querySelector('#node-2')!.getBoundingClientRect().left + document.querySelector('#node-2')!.getBoundingClientRect().width / 2)) < 2)

    await page.click('#plain')
    await page.waitUntil(() => document.querySelector('#card')!.getBoundingClientRect().top >= document.querySelector('#plain')!.getBoundingClientRect().bottom - 1)
    expect((await boxes(page, '#plain')).open).toBe(true)

    await page.evaluate((() => document.querySelector<HTMLElement>('#plain')!.blur()) as never)
    await page.waitUntil(() => !document.querySelector('#card')!.matches(':popover-open'))
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps the card on an SVG node while the pane zooms, and lets go of the node once it is left', async () => {
    const site = await shared()

    await using page = await site.open('/hover-card')
    // Both events are sent by hand, as a zoom moves the node from under a real pointer and would end the hover.
    const sendTo = async (selector: string, type: string) => page.evaluate(((target: string, name: string) => document.querySelector(target)!.dispatchEvent(new PointerEvent(name))) as never, selector as never, type as never)
    const gap = async () => page.evaluate((() => {
      const card = document.querySelector('#card')!.getBoundingClientRect()
      const node = document.querySelector('#node-1')!.getBoundingClientRect()

      return Math.abs((card.left + card.right) / 2 - (node.left + node.right) / 2) + Math.abs(card.top - node.bottom)
    }) as never) as Promise<number>

    await page.waitFor('#node-1')
    await sendTo('#node-1', 'pointerenter')
    await page.waitUntil((() => document.querySelector('#card')?.matches(':popover-open')) as never)
    await page.waitUntil((() => document.querySelector('#card')!.getBoundingClientRect().top > 100) as never)
    expect(await gap()).toBeLessThan(8)

    await page.evaluate((() => document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!.click()) as never)
    await page.waitUntil((() => Number(document.querySelector<HTMLElement>('#plate')!.dataset.scale) > 1) as never)
    await page.waitUntil((() => {
      const card = document.querySelector('#card')!.getBoundingClientRect()
      const node = document.querySelector('#node-1')!.getBoundingClientRect()

      return Math.abs((card.left + card.right) / 2 - (node.left + node.right) / 2) < 4
    }) as never)
    expect(await gap()).toBeLessThan(8)

    await sendTo('#node-1', 'pointerleave')
    await page.waitUntil((() => !document.querySelector('#card')!.matches(':popover-open')) as never)
    expect(await page.evaluate((() => document.querySelector<HTMLElement>('#card + span')!.style.getPropertyValue('anchor-name')) as never)).toBe('')

    // An HTML element is anchored through the stand-in too, and keeps its own anchor-name.
    await page.click('#plain')
    await page.waitUntil((() => document.querySelector('#card')?.matches(':popover-open')) as never)
    expect(await page.evaluate((() => document.querySelector<HTMLElement>('#card + span')!.style.getPropertyValue('anchor-name')) as never)).not.toBe('')
    await page.evaluate((() => document.querySelector<HTMLElement>('#plain')!.blur()) as never)
    await page.waitUntil((() => !document.querySelector('#card')!.matches(':popover-open')) as never)
    expect(await page.evaluate((() => document.querySelector<HTMLElement>('#card + span')!.style.getPropertyValue('anchor-name')) as never)).toBe('')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('closes without an error when its anchor leaves the page', async () => {
    const site = await shared()

    await using page = await site.open('/hover-card')

    await page.click('#own')
    await page.waitUntil((() => document.querySelector('#card')?.matches(':popover-open')) as never)
    await page.evaluate((() => document.querySelector('#own')!.remove()) as never)
    await page.waitUntil((() => !document.querySelector('#card')!.matches(':popover-open')) as never)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps an anchor-name of the app, and sits beside an anchor inside a transformed ancestor', async () => {
    const site = await shared()

    await using page = await site.open('/hover-card')

    await page.click('#own')
    await page.waitUntil((() => document.querySelector('#card')?.matches(':popover-open')) as never)
    await page.waitUntil((() => {
      const card = document.querySelector('#card')!.getBoundingClientRect()
      const own = document.querySelector('#own')!.getBoundingClientRect()

      return Math.abs((card.left + card.right) / 2 - (own.left + own.right) / 2) < 2 && card.top >= own.bottom - 1
    }) as never)
    expect(await page.evaluate((() => document.querySelector<HTMLElement>('#own')!.style.getPropertyValue('anchor-name')) as never)).toBe('--own')
    await page.evaluate((() => document.querySelector<HTMLElement>('#own')!.blur()) as never)
    await page.waitUntil((() => !document.querySelector('#card')!.matches(':popover-open')) as never)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('ZoomPane reports its plate on every zoom and fit, and zooms out below fitted down to least', async () => {
    const site = await shared()

    await using page = await site.open('/hover-card')
    const plate = async () => page.evaluate((() => {
      const element = document.querySelector<HTMLElement>('#plate')!

      return { scale: Number(element.dataset.scale), x: Number(element.dataset.x), y: Number(element.dataset.y) }
    }) as never) as Promise<{ scale: number, x: number, y: number }>

    expect(await plate()).toEqual({ scale: 1, x: 0, y: 0 })
    await page.click('[aria-label="Zoom in"]')
    await page.waitUntil(() => Number(document.querySelector<HTMLElement>('#plate')!.dataset.scale) > 1)
    const taken = await plate()

    expect(taken.scale).toBeCloseTo(1.15 ** 2)
    expect(taken.x).toBeLessThan(0)

    await page.click('[aria-label="Fit"]')
    await page.waitUntil(() => Number(document.querySelector<HTMLElement>('#plate')!.dataset.scale) === 1)
    for (let step = 0; step < 6; step++)
      await page.click('[aria-label="Zoom out"]')

    await page.waitUntil(() => Number(document.querySelector<HTMLElement>('#plate')!.dataset.scale) <= 0.51)
    expect((await plate()).scale).toBe(0.5)
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('LineChart tooltip', () => {
  // Hovers a chart at a pointer position and reads the tooltip's box, heading and the viewport it sits in.
  const hover = async (page: { evaluate: (...args: never[]) => Promise<unknown>, waitFor: (selector: string) => Promise<void> }, id: string, at: { x: number | 'left' | 'right', y?: number }) => {
    await page.waitFor(`#${id} .kui-line-chart-plot svg`)
    await page.evaluate(((within: string, x: number | string, y: number | undefined) => {
      const overlay = document.querySelector(`#${within} .kui-line-chart-overlay`)!
      const edge = x === 'left' ? 1 : document.documentElement.clientWidth - 1
      const clientX = typeof x === 'string' ? edge : x

      overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY: y ?? overlay.getBoundingClientRect().top + 40 }))
    }) as never, id as never, at.x as never, at.y as never)
    await page.waitFor(`#${id} .kui-line-chart-tooltip`)
    // The tooltip is placed once the observer has measured it.
    await page.evaluate((async () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))) as never)

    return await page.evaluate(((within: string) => {
      const box = document.querySelector(`#${within} .kui-line-chart-tooltip`)!
      const rect = box.getBoundingClientRect()

      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, scroll: box.scrollWidth, wide: document.documentElement.clientWidth, high: document.documentElement.clientHeight, heading: box.querySelector('.kui-line-chart-tooltip-label')!.textContent, wraps: [...box.querySelectorAll('.kui-line-chart-tooltip-name')].some(name => name.scrollWidth > name.clientWidth) }
    }) as never, id as never) as { left: number, right: number, top: number, bottom: number, width: number, scroll: number, wide: number, high: number, heading: string, wraps: boolean }
  }

  test('keeps its natural width and stays inside the viewport at the first and last point, and flips below near the top', async () => {
    const site = await shared()

    await using page = await site.open('/chart-tooltip')
    const natural = await hover(page, 'seconds', { x: 'left' })
    const right = await hover(page, 'seconds', { x: 'right' })

    expect(natural.left).toBeGreaterThanOrEqual(0)
    expect(right.right).toBeLessThanOrEqual(right.wide)
    expect(Math.abs(right.width - natural.width)).toBeLessThan(12)
    expect(right.wraps).toBe(false)

    const top = await hover(page, 'seconds', { x: 400, y: 2 })

    expect(top.top).toBeGreaterThan(2)
    expect(Math.abs(top.width - natural.width)).toBeLessThan(12)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('heads a date label in the page\'s locale with the precision its points need, and leaves other labels alone or to formatLabel', async () => {
    const site = await shared()

    await using page = await site.open('/chart-tooltip')

    expect((await hover(page, 'seconds', { x: 300 })).heading).toMatch(/^21 Oct 2026, \d\d:\d\d:\d\d$/)
    expect((await hover(page, 'hours', { x: 300 })).heading).toMatch(/^2[01] Oct 2026, \d\d:\d\d$/)
    expect((await hover(page, 'days', { x: 300 })).heading).toMatch(/^\d\d Oct 2026$/)
    expect((await hover(page, 'plain', { x: 300 })).heading).toMatch(/^(Mon|Tue|Wed)$/)
    expect((await hover(page, 'formatted', { x: 300 })).heading).toMatch(/^Point [abc]$/)

    const ticks = (id: string) => page.evaluate((within: string) => [...document.querySelectorAll(`#${within} .ct-label.ct-horizontal`)].map(label => label.textContent), id)
    const hourTicks = await ticks('hours')

    expect(hourTicks.length).toBeGreaterThan(1)
    expect(new Set(hourTicks).size).toBe(hourTicks.length)
    expect(hourTicks.every(tick => (/^\d\d:\d\d$/).test(tick ?? ''))).toBe(true)
    expect((await ticks('days')).every(tick => (/^\d+ Oct$/).test(tick ?? ''))).toBe(true)
    expect(await ticks('formatted')).toEqual(['Tick a', 'Tick b', 'Tick c'])
    expect(page.errors).toEqual([])

    await using french = await site.open('/fr/chart-tooltip')

    expect((await hover(french, 'seconds', { x: 300 })).heading).toMatch(/^21 oct\. 2026, \d\d:\d\d:\d\d$/)
    expect((await hover(french, 'days', { x: 300 })).heading).toMatch(/^\d\d oct\. 2026$/)
  }, 120_000)
})

inBrowser('LineChart stacked', () => {
  test('draws each line on the ones below, reads each series\' own value with a total row, and starts the axis at 0', async () => {
    const site = await shared()

    await using page = await site.open('/chart-tooltip')
    await page.waitFor('#stacked .kui-line-chart-plot svg .ct-line')

    const drawn = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('#stacked .ct-line')].map(line => (line.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)!.map(Number))
      const labels = [...document.querySelectorAll('#stacked .ct-label.ct-vertical')].map(label => Number(label.textContent))

      return { first: lines.map(line => line[1]!), last: lines.map(line => line.at(-1)!), labels, areas: [...document.querySelectorAll('#stacked .ct-area')].map(area => (area.getAttribute('d') ?? '').split('M').length - 1) }
    }) as { first: number[], last: number[], labels: number[], areas: number[] }

    // A null counts as 0: B starts on A's line, and C rises above both.
    expect(drawn.first[1]).toBe(drawn.first[0]!)
    expect(drawn.first[2]!).toBeLessThan(drawn.first[1]!)
    // C's gap ends on B's line.
    expect(drawn.last[2]).toBe(drawn.last[1]!)
    expect(Math.min(...drawn.labels)).toBe(0)
    expect(Math.max(...drawn.labels)).toBeGreaterThanOrEqual(5)
    // The first area is its own; each other is its own plus the one below, leaving the band.
    expect(drawn.areas).toEqual([1, 2, 2])

    const read = async (x: number) => {
      await page.evaluate(((at: number) => {
        const overlay = document.querySelector('#stacked .kui-line-chart-overlay')!

        overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: at, clientY: overlay.getBoundingClientRect().top + 40 }))
      }) as never, x as never)
      await page.waitFor('#stacked .kui-line-chart-tooltip')

      return await page.evaluate(() => [...document.querySelectorAll('#stacked .kui-line-chart-tooltip-row')].map(row => row.textContent)) as string[]
    }

    expect(await read(1)).toEqual(['A1', 'B-', 'C2', 'Total3'])
    expect(await page.evaluate(() => document.querySelector('#stacked .kui-line-chart-overlay')!.getAttribute('aria-valuetext'))).toEndWith('A 1, B -, C 2, Total 3')
    expect(await page.evaluate(() => [...document.querySelectorAll('#stacked .kui-line-chart-data th[scope="col"]')].map(th => th.textContent))).toEqual(['A', 'B', 'C', 'Total'])
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('LineChart stacked far above one series', () => {
  test('keeps the axis readable up to a total of 1200 and formats the total as the values', async () => {
    const site = await shared()

    await using page = await site.open('/chart-tooltip')
    await page.waitFor('#cores .kui-line-chart-plot svg .ct-line')

    const labels = await page.evaluate(() => [...document.querySelectorAll('#cores .ct-label.ct-vertical')].map(label => label.textContent ?? '')) as string[]
    const numbers = labels.map(label => Number.parseFloat(label))

    expect(labels.every(label => (/^\d+%$/).test(label))).toBe(true)
    expect(Math.max(...numbers)).toBeGreaterThanOrEqual(1200)
    expect(Math.min(...numbers)).toBe(0)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.length).toBeLessThanOrEqual(15)

    await page.evaluate(() => {
      const overlay = document.querySelector('#cores .kui-line-chart-overlay')!

      overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1, clientY: overlay.getBoundingClientRect().top + 40 }))
    })
    await page.waitFor('#cores .kui-line-chart-tooltip')

    const rows = await page.evaluate(() => [...document.querySelectorAll('#cores .kui-line-chart-tooltip-row')].map(row => row.textContent)) as string[]

    expect(await page.evaluate(() => [...document.querySelectorAll('#cores .ct-line')].map(line => line.getAttribute('style') ?? ''))).toSatisfy((styles: string[]) => styles.length === 12 && styles.every(style => !style.includes('stroke-dasharray')))
    expect(await page.evaluate(() => [...document.querySelectorAll('#seconds .ct-line')].map(line => line.getAttribute('style') ?? '').some(style => style.includes('stroke-dasharray')))).toBe(true)
    expect(rows).toHaveLength(13)
    expect(rows[0]).toBe('Core 0100%')
    expect(rows.at(-1)).toBe('Total1200%')
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('LineChart long axis labels', () => {
  test('keeps every y label whole, on one line and inside the svg, and leaves an own offset alone', async () => {
    const site = await shared()

    await using page = await site.open('/chart-tooltip')

    // Each y label's text box against the svg's box, and how many lines it takes.
    const read = async (id: string) => {
      await page.waitFor(`#${id} .kui-line-chart-plot svg .ct-line`)
      // Chartist draws again once the labels have said how much room they need.
      await page.waitUntil(((within: string) => {
        const label = document.querySelector(`#${within} .ct-label.ct-vertical`)

        return label !== null && Number.parseFloat(label.parentElement?.getAttribute('width') ?? '0') > 30
      }) as never, {}, id as never)

      return await page.evaluate(((within: string) => {
        const svg = document.querySelector(`#${within} .kui-line-chart-plot svg`)!.getBoundingClientRect()
        const range = document.createRange()

        return [...document.querySelectorAll(`#${within} .ct-label.ct-vertical`)].map((label) => {
          range.selectNodeContents(label)

          const text = range.getBoundingClientRect()

          return { text: label.textContent ?? '', inside: text.left >= svg.left && text.right <= svg.right && text.top >= svg.top && text.bottom <= svg.bottom, lines: Math.round(text.height / Number.parseFloat(getComputedStyle(label).lineHeight)) }
        })
      }) as never, id as never) as { text: string, inside: boolean, lines: number }[]
    }

    for (const id of ['long-axis', 'long-axis-stacked']) {
      const labels = await read(id)

      expect(labels.length).toBeGreaterThan(2)
      expect(labels.some(label => label.text.length > 9)).toBe(true)
      expect(labels.filter(label => !label.inside || label.lines !== 1)).toEqual([])
    }

    // The top gridline, which sits at the chart's top padding.
    const top = (id: string) => page.evaluate(((within: string) => Math.min(...[...document.querySelectorAll(`#${within} .ct-grid.ct-vertical`)].map(grid => Number(grid.getAttribute('y1'))))) as never, id as never) as Promise<number>

    // An app's own offset wins: a label's box is the offset less 10 px, so 40, and the labels may overflow it. The top padding grows to the labels' height once the fit has redrawn the chart, which the check waits for.
    await page.waitFor('#long-axis-own .kui-line-chart-plot svg .ct-line')
    await page.waitUntil((() => Number(document.querySelector('#long-axis-own .ct-grid.ct-vertical')?.getAttribute('y1')) > 8) as never)
    expect(await page.evaluate(() => Number(document.querySelector('#long-axis-own .ct-label.ct-vertical')!.parentElement!.getAttribute('width')))).toBe(40)

    // An own chartPadding wins too, once the labels have said how much room they need.
    await page.waitFor('#long-axis-padding .kui-line-chart-plot svg .ct-line')
    await page.waitUntil(((within: string) => Number(document.querySelector(`#${within} .ct-label.ct-vertical`)?.parentElement?.getAttribute('width')) > 30) as never, {}, 'long-axis-padding' as never)
    expect(await top('long-axis-padding')).toBe(2)
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('LineChart in another timezone', () => {
  test('words a timed label in the server\'s zone with its name, then in the viewer\'s own zone once hydrated, with no error', async () => {
    const before = process.env.TZ

    process.env.TZ = 'UTC'

    try {
      const site = await shared()
      const served = (await site.visit('/chart-tooltip')).html.match(/id="seconds"[\s\S]*?aria-valuetext="([^"]*)"/)?.[1]

      expect(served).toMatch(/^21 Oct 2026, 16:\d\d:\d\d UTC: /)

      await using page = await site.open('/')

      await page.cdp('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
      await page.goto('/chart-tooltip')
      await page.waitFor('#seconds .kui-line-chart-plot svg')

      const valuetext = () => page.evaluate(() => document.querySelector('#seconds .kui-line-chart-overlay')!.getAttribute('aria-valuetext'))

      await page.waitUntil(() => !document.querySelector('#seconds .kui-line-chart-overlay')!.getAttribute('aria-valuetext')!.includes('UTC'))
      expect(await valuetext()).toMatch(/^22 Oct 2026, 01:\d\d:\d\d: /)

      await page.evaluate(() => document.querySelector('#hours .kui-line-chart-overlay')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 300 })))
      await page.waitFor('#hours .kui-line-chart-tooltip')
      expect(await page.text('#hours .kui-line-chart-tooltip-label')).toMatch(/^21 Oct 2026, 09:00$/)
      expect(page.errors).toEqual([])
    }
    finally {
      if (before === undefined)
        delete process.env.TZ
      else
        process.env.TZ = before
    }
  }, 120_000)
})

inBrowser('FormField in an island', () => {
  test('ConfirmDelete words its dialog in the French kayjs-ui ships, a prop winning over it, English on an English page', async () => {
    const site = await shared()
    const dialogText = async (url: string, id: string) => {
      await using page = await site.open(url)

      await page.click(`#${id} button`)
      await page.waitFor(`#${id} dialog[open]`)

      return await page.evaluate((within: string) => document.querySelector(`#${within} dialog`)!.textContent, id)
    }

    expect(await dialogText('/fr/confirm-words', 'plain')).toContain('Annuler')
    expect(await dialogText('/fr/confirm-words', 'given')).toContain('Never mind')
    expect(await dialogText('/confirm-words', 'plain')).toContain('Cancel')
  }, 120_000)

  test('draws the derived palette as the literals did, in both schemes, and a skin of seeds alone through the same derivation', async () => {
    const site = await shared()
    const WAS: Record<string, [number[], number[]]> = {
      'mantle': [[0xEF, 0xEC, 0xE6], [0x0D, 0x0D, 0x0D]],
      'surface0': [[0xF4, 0xF1, 0xEC], [0x16, 0x16, 0x16]],
      'surface1': [[0xEC, 0xE8, 0xE1], [0x1B, 0x1B, 0x1B]],
      'overlay1': [[0x6D, 0x68, 0x5F], [0x8A, 0x85, 0x7D]],
      'subtext0': [[0x62, 0x5D, 0x55], [0x9C, 0x97, 0x8E]],
      'accent-hi': [[0x7D, 0x2A, 0x22], [0xF8, 0xC0, 0xB8]],
      'fill-danger': [[0xF8, 0xE4, 0xE1], [0x24, 0x16, 0x15]],
    }

    await using page = await site.open('/palette')

    const read = async (scheme: string, skin: string) => page.evaluate((chosen: string, css: string) => {
      document.documentElement.dataset.theme = chosen
      document.documentElement.setAttribute('style', css)

      return Object.fromEntries(['mantle', 'surface0', 'surface1', 'overlay1', 'subtext0', 'accent-hi', 'fill-danger', 'surface2'].map((name) => {
        const probe = document.createElement('i')

        probe.style.color = `var(--color-kui-${name})`
        document.body.append(probe)

        // Chromium reports a mix as oklab(...), which a canvas turns back into the pixel it paints.
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!

        context.fillStyle = getComputedStyle(probe).color
        context.fillRect(0, 0, 1, 1)
        probe.remove()

        return [name, [...context.getImageData(0, 0, 1, 1).data]]
      }))
    }, scheme, skin)

    for (const [index, scheme] of ['light', 'dark'].entries()) {
      const seen = await read(scheme, '')

      for (const [name, was] of Object.entries(WAS))
        expect(Math.max(...seen[name]!.slice(0, 3).map((channel, at) => Math.abs(channel - was[index]![at]!))), `${name} ${scheme}`).toBeLessThanOrEqual(10)

      // The hairline is the text at a tenth of its opacity.
      expect(seen.surface2![3]! / 255).toBeCloseTo(0.1, 1)
    }

    // A skin that sets the canvas alone moves the surfaces derived from it, and leaves the accent's own.
    const light = await read('light', '--color-kui-canvas: #ffffff;')
    const plain = await read('light', '')

    expect(light.surface0).not.toEqual(plain.surface0)
    expect(light['accent-hi']).toEqual(plain['accent-hi'])
    expect(page.errors).toEqual([])
  }, 120_000)

  test('draws the keyline of every framed box at --kui-border-width, the old --kui-border-card still setting it, and 1px when a skin gives no length', async () => {
    const site = await shared()

    await using page = await site.open('/borders')
    await page.evaluate(() => document.querySelector<HTMLElement>('#site-nav-list')!.showPopover())

    // Each box with the sides it draws, in the order top, right, bottom, left; the others stay 0. A button draws its keyline in ::before.
    const boxes: Record<string, [selector: string, sides: string]> = {
      card: ['#card', 'trbl'],
      head: ['#card-head', 'b'],
      row: ['#row', 'trbl'],
      widget: ['#widget', 'trbl'],
      notice: ['#notice', 'trbl'],
      avatar: ['#avatar', 'trbl'],
      button: ['#button::before', 'trbl'],
      sidePanel: ['#side-panel', 'l'],
      tooltip: ['#tooltip', 'trbl'],
      tableWrap: ['#table-wrap', 'trbl'],
      section: ['#section', 'trbl'],
      saveBar: ['#save-bar', 'trbl'],
      segmented: ['#segmented', 'trbl'],
      fileDrop: ['#file-drop', 'trbl'],
      step: ['#step', 'trbl'],
      chartTooltip: ['#chart-tooltip', 'trbl'],
      chipLabel: ['#chip-label', 'trbl'],
      iconGrid: ['#icon-grid', 'trbl'],
      scatterPlot: ['#scatter-plot', 'trbl'],
      cropperStage: ['#cropper-stage', 'trbl'],
      toggle: ['#toggle', 'trbl'],
      tableFilter: ['#table-filter', 'b'],
      tableSelection: ['#table-selection', 'b'],
      narrowHead: ['#narrow-head', 'b'],
      sortButton: ['#sort-btn', 'trbl'],
      // The page is narrower than the desktop breakpoint, where the open list is a box of its own.
      siteNavList: ['#site-nav-list', 'trbl'],
    }

    const widths = async (css: string): Promise<Record<string, number[]>> => page.evaluate((style: string, spec: typeof boxes) => {
      document.documentElement.setAttribute('style', style)

      return Object.fromEntries(Object.entries(spec).map(([name, [selector]]) => {
        const [id, pseudo] = selector.split('::')
        const computed = getComputedStyle(document.querySelector(id!)!, pseudo ? `::${pseudo}` : null)

        return [name, [computed.borderTopWidth, computed.borderRightWidth, computed.borderBottomWidth, computed.borderLeftWidth].map(Number.parseFloat)]
      }))
    }, css, boxes)

    const all = (value: number) => Object.fromEntries(Object.entries(boxes).map(([name, [, sides]]) => [name, [...'trbl'].map(side => sides.includes(side) ? value : 0)]))

    expect(await widths('')).toEqual(all(1))
    expect(await widths('--kui-border-width: 2px')).toEqual(all(2))
    expect(await widths('--kui-border-card: 3px')).toEqual(all(3))
    expect(await widths('--kui-border-width: 2px solid red')).toEqual(all(1))
    expect(await widths('--kui-border-card: 2px solid red')).toEqual(all(1))
    expect(page.errors).toEqual([])
  }, 120_000)

  test('SiteNav opens its links from the toggle with no island, closes them on Escape or a press outside, and gives the focus back', async () => {
    const site = await shared()

    await using page = await site.open('/layout', { width: 600 })
    const open = async () => page.evaluate(() => document.querySelector('#main-links')!.matches(':popover-open'))

    expect(await open()).toBe(false)

    await page.click('#site-nav button')
    expect(await open()).toBe(true)

    await page.press('Escape')
    expect(await open()).toBe(false)
    expect(await page.evaluate(() => document.activeElement === document.querySelector('#site-nav button'))).toBe(true)

    await page.click('#site-nav button')
    await page.click('#header h1')
    expect(await open()).toBe(false)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('SiteNav shows the close icon while its menu is open, and closes it as a followed link swaps the next page in, the layout holding it kept', async () => {
    const site = await shared()

    await using page = await site.open('/swap-a', { width: 600 })
    const state = async () => page.evaluate(() => ({
      open: document.querySelector('#swap-links')!.matches(':popover-open'),
      icons: ['menu', 'close'].map(name => getComputedStyle(document.querySelector(`.kui-site-nav-toggle-${name}`)!).display !== 'none'),
      kept: document.querySelector('#swap-header') === (window as { header?: Element }).header,
      current: [...document.querySelectorAll('#swap-links a')].map(link => link.getAttribute('aria-current')),
    }))

    await page.evaluate(() => {
      (window as { header?: Element | null }).header = document.querySelector('#swap-header')
    })
    await page.click('#swap-header button')
    expect(await state()).toEqual({ open: true, icons: [false, true], kept: true, current: ['page', null] })

    await page.click('#swap-links a[href="/swap-b"]')
    await page.waitUntil(() => document.querySelector('#title')!.textContent === 'Page b')

    expect(await state()).toEqual({ open: false, icons: [true, false], kept: true, current: [null, 'page'] })
    expect(await page.path()).toBe('/swap-b')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('SiteNav keeps its links hidden below lg whatever display an app gives its lists, and a row from lg', async () => {
    const site = await shared()
    const display = async (width: number) => {
      await using page = await site.open('/borders', { width })

      await page.evaluate(() => document.head.append(Object.assign(document.createElement('style'), { textContent: 'ul { display: flex }' })))

      const shown = await page.evaluate(() => getComputedStyle(document.querySelector('#site-nav-list')!).display)

      return shown
    }

    expect(await display(600)).toBe('none')
    expect(await display(1200)).toBe('flex')
  }, 120_000)

  test('hydrates over the ids the server handed its control, then links the message once one shows', async () => {
    const site = await shared()
    const served = (await site.visit('/described')).html

    await using page = await site.open('/described')
    const read = async () => page.evaluate(() => {
      const input = document.querySelector('#name')!

      return { described: input.getAttribute('aria-describedby'), invalid: input.getAttribute('aria-invalid'), hint: document.querySelector('.kui-form-field-hint')!.id, issues: document.querySelector('.kui-form-field-issues')!.getAttribute('id') }
    })
    const hydrated = await read()

    expect(served).toMatch(SERVED)
    expect(hydrated).toEqual({ described: `name-note ${hydrated.hint}`, invalid: null, hint: hydrated.hint, issues: null })

    await page.click('#refuse')
    await page.waitUntil(() => document.querySelector('#name')!.getAttribute('aria-invalid') === 'true')

    const refused = await read()

    expect(refused.issues).not.toBeNull()
    expect(refused.described).toBe(`name-note ${hydrated.hint} ${refused.issues}`)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps its hint beside the message of a refused post once the island hydrates, and as the field turns valid and refused again', async () => {
    const site = await shared()

    await using page = await site.open('/described-form')
    const read = async () => page.evaluate(() => {
      const input = document.querySelector('#claim input[name="handle"]')!

      return { described: input.getAttribute('aria-describedby'), hint: document.querySelector('.kui-form-field-hint')!.id }
    })

    await page.fill('#claim input[name="handle"]', 'ab')
    await page.click('#post')
    await page.waitFor('#claim-handle-error')
    // A click the island answers tells it hydrated.
    await page.click('#bump')
    await page.waitFor('#bump', { text: '1' })

    const refused = await read()

    expect(refused.described?.split(' ').toSorted()).toEqual(['claim-handle-error', refused.hint].toSorted())

    await page.click('#accept')
    await page.waitUntil(() => document.querySelector('#claim-handle-error') === null)

    expect((await read()).described).toBe(refused.hint)

    await page.click('#refuse')
    await page.waitUntil(() => document.querySelector('#claim-handle-error') !== null)

    expect((await read()).described).toBe(`${refused.hint} claim-handle-error`)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps a refused field invalid while its FormField or group shows a message, and drops the mark once neither the action nor the FormField refuses it', async () => {
    const site = await shared()

    await using page = await site.open('/invalid-form')
    // Presses a button, then waits for the action's message and the FormField's to show as asked, answering the marks of the field and of the group's.
    const press = async (button: string, refused: boolean, issue: boolean) => {
      await page.click(button)
      await page.waitUntil((refused, issue) => (document.querySelector('#claim-handle-error') !== null) === refused && (document.querySelector('.kui-form-field-issue') !== null) === issue, {}, refused, issue)

      return page.evaluate(() => ['#claim', '#grouped'].map(form => document.querySelector(`${form} input[name="handle"]`)!.getAttribute('aria-invalid')))
    }

    await page.fill('#claim input[name="handle"]', 'ab')
    await page.click('#post')
    await page.waitFor('#claim-handle-error')
    // A click the island answers tells it hydrated.
    await page.click('#bump')
    await page.waitFor('#bump', { text: '1' })

    // The mark the server rendered for the refusal is the action's own, dropped once it is accepted.
    expect(await press('#accept', false, false)).toEqual([null, null])
    expect(await press('#refuse', true, false)).toEqual(['true', 'true'])
    expect(await press('#show', true, true)).toEqual(['true', 'true'])
    expect(await press('#accept', false, true)).toEqual(['true', 'true'])
    expect(await press('#hide', false, false)).toEqual([null, null])
    expect(await press('#show', false, true)).toEqual(['true', 'true'])
    expect(await press('#refuse', true, true)).toEqual(['true', 'true'])
    expect(await press('#hide', true, false)).toEqual(['true', 'true'])
    expect(await press('#accept', false, false)).toEqual([null, null])
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a form reset on a served page', () => {
  test('puts every control of the hydrated page, a field named form and a Segmented with none picked included, back on its start', async () => {
    const site = await shared()

    await using page = await site.open('/form-reset')
    const state = async () => page.evaluate(() => JSON.parse(document.querySelector('#state')!.textContent!) as Record<string, unknown>)

    expect(await state()).toEqual(START)

    await page.evaluate(() => {
      const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click()
      const type = (selector: string, value: string, event = 'input') => {
        const field = document.querySelector<HTMLInputElement>(selector)!

        field.value = value
        field.dispatchEvent(new Event(event, { bubbles: true }))
      }

      click('input[name="agree"]')
      click('input[name="power"]')
      click('#free')
      click('input[name="decks"][value="games"]')
      click('input[name="decks"][value="films"]')
      click('input[name="size"][value="l"]')
      click('input[name="sort"][value="l"]')
      type('#level', 'c', 'change')
      document.querySelectorAll<HTMLElement>('.kui-multi-select-checkbox')[0]!.click()
      document.querySelectorAll<HTMLElement>('.kui-multi-select-checkbox')[2]!.click()
      type('#title', 'Grace')
      type('#bio', 'Bye')
      type('#notes', '# Other')
      type('input[aria-label="Range from"]', '4', 'change')
      type('input[aria-label="Range to"]', '9', 'change')
      click('#named .kui-icon-grid-option[aria-label="moon"]')
      click('#bare .kui-icon-grid-option[aria-label="moon"]')
      type('#fixed', 'a', 'change')
      type('#formname', 'y')
      type('#bare input[type="search"]', 'mo')
    })
    await page.waitUntil(() => JSON.parse(document.querySelector('#state')!.textContent!).form === 'y')

    expect(await state()).toMatchObject({ agree: false, power: true, free: true, decks: ['games'], size: 'l', sort: 'l', level: 'c', title: 'Grace', form: 'y', icon: 'moon' })

    await page.click('#reset')
    await page.waitUntil(() => JSON.parse(document.querySelector('#state')!.textContent!).form === 'x')

    expect(await state()).toEqual(START)
    expect(await page.evaluate(() => [...new FormData(document.querySelector('form')!)].map(([name, value]) => `${name}=${String(value)}`).sort())).toEqual(['agree=on', 'bio=Hello', 'decks=films', 'form=x', 'icon=star', 'level=b', 'size=m', 'tags=x', 'tags=y', 'title=Ada'])
    expect(await page.evaluate(() => document.querySelectorAll('input[name="sort"]:checked').length)).toBe(0)
    expect(await page.value('#bare input[type="search"]')).toBe('')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('hands the app\'s ref the element of a hydrated control once, however often its attributes change', async () => {
    const site = await shared()

    await using page = await site.open('/form-reset-ref')

    await page.click('#change')
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="title"]')!.placeholder === 'b')

    expect(await page.evaluate(() => (window as unknown as { refs: string[] }).refs.sort())).toEqual(['icon', 'markdown', 'plain-first', 'select', 'text', 'textarea'])
  }, 120_000)
})

inBrowser('a Segmented busy with a change on a served page', () => {
  test('moves focus back to the checked radio when a pick made by key or click is taken, so focus and the check agree', async () => {
    const site = await shared()

    await using page = await site.open('/segmented-busy')
    const state = async () => page.evaluate(() => ({
      checked: document.querySelector<HTMLInputElement>('input[name="size"]:checked')?.value,
      focused: (document.activeElement as HTMLInputElement | null)?.value,
    }))

    await page.evaluate(() => document.querySelector<HTMLInputElement>('input[value="m"]')!.focus())
    await page.press('ArrowRight')
    await page.waitUntil(() => (window as unknown as { held?: string }).held === 'l')

    // The pick under way is shown as made, and focus is on it.
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })

    // A pick while busy takes nothing: the check goes back and focus goes with it.
    await page.press('ArrowLeft')
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })
    await page.press('ArrowLeft')
    await page.click('.kui-segmented-option:first-child .kui-segmented-label')
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })

    // The refusal puts the first option back, and focus follows it.
    await page.evaluate(() => document.querySelector<HTMLElement>('#release')!.click())
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value === 'm')

    expect(await state()).toEqual({ checked: 'm', focused: 'm' })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('leaves focus alone when it has moved off the group before the refusal', async () => {
    const site = await shared()

    await using page = await site.open('/segmented-busy')

    await page.click('.kui-segmented-option:last-child .kui-segmented-label')
    await page.waitUntil(() => (window as unknown as { held?: string }).held === 'l')
    await page.click('#release')
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value === 'm')

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('release')
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a SaveForm passed an action by a page with a server fence', () => {
  test('calls the action as if the island had imported it, toasting what the page said and what the schema refused', async () => {
    const site = await shared()

    await using page = await site.open('/save-form-action')

    await page.fill('#name', 'Grace')
    await page.click('button[type="submit"]')
    await page.waitFor('.kui-toast-message', { text: 'Saved.' })

    await page.fill('#name', 'G')
    await page.click('button[type="submit"]')
    await page.waitFor('.kui-toast-message', { text: 'Two letters at least' })
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a Select with submit on a served page', () => {
  test('waits for Enter or blur after an arrow key on the closed list, and posts at once for a mouse pick', async () => {
    const site = await shared()

    await using page = await site.open('/select-submit')
    const posts = async () => page.evaluate(() => document.querySelector('#posts')!.textContent)
    const value = async () => page.evaluate(() => document.querySelector<HTMLSelectElement>('#kind')!.value)

    await page.evaluate(() => document.querySelector<HTMLSelectElement>('#kind')!.focus())
    await page.press('ArrowDown')
    await page.press('ArrowDown')

    expect([await value(), await posts()]).toEqual(['c', '0'])

    await page.press('Enter')

    expect(await posts()).toBe('1')

    // Enter may leave the native list open, which Escape closes without a pick.
    await page.press('Escape')
    await page.press('ArrowUp')

    expect([await value(), await posts()]).toEqual(['b', '1'])

    await page.click('#elsewhere')

    expect(await posts()).toBe('2')

    // A mouse pick posts at once: the native list is not drawn by headless Chromium, so the pick is the browser's own change from a pointer press and a value change.
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#kind')!

      select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      select.value = 'a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(await posts()).toBe('3')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('posts at once for a pick from the list a key opened', async () => {
    const site = await shared()

    await using page = await site.open('/select-submit')
    const posts = async () => page.evaluate(() => document.querySelector('#posts')!.textContent)

    await page.evaluate(() => document.querySelector<HTMLSelectElement>('#kind')!.focus())
    await page.press('Space')
    await page.press('ArrowDown')
    await page.press('Enter')
    await page.waitUntil(() => document.querySelector('#posts')!.textContent !== '0')

    expect(await posts()).toBe('1')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('shows the tooltip of a disabled fieldset over the fieldset and over a disabled control inside it', async () => {
    const site = await shared()

    await using page = await site.open('/locked-tooltip')
    const shown = async () => page.evaluate(() => document.querySelector('#kui-tooltip')!.matches(':popover-open') ? document.querySelector('#kui-tooltip')!.textContent : null)

    await page.hover('#locked-input')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')!.matches(':popover-open'))
    expect(await shown()).toBe('Your role may not publish')

    await page.hover('#elsewhere')
    await page.waitUntil(() => !document.querySelector('#kui-tooltip')!.matches(':popover-open'))

    // The fieldset's own box, left of the control it wraps.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#locked')!.style.padding = '2rem'
    })
    await page.hover('#locked')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')!.matches(':popover-open'))
    expect(await shown()).toBe('Your role may not publish')
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a CopyButton on a served page', () => {
  test('CopyButton keeps its width through the copy, in every size and variant, and reads only the label showing', async () => {
    const site = await shared()

    await using page = await site.open('/copy-width')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => undefined, writeText: async () => undefined } })
    })
    const ids = ['short', 'longer', 'shorter', 'ghost-xs', 'inline-lg']
    const widths = async () => page.evaluate((list: string[]) => list.map(id => document.getElementById(id)!.getBoundingClientRect().width), ids)
    // The names Chromium gives the buttons, which leave out the invisible label and come uppercased, as the buttons are drawn.
    const names = async () => {
      const { nodes } = await page.cdp<{ nodes: { role?: { value: string }, name?: { value: string } }[] }>('Accessibility.getFullAXTree')

      return nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value.toLowerCase())
    }
    const texts = async () => page.evaluate((list: string[]) => list.map(id => document.getElementById(id)!.textContent), ids)
    const before = await widths()

    expect(await texts()).toEqual(['Copy', 'Copy', 'Copy the install command', 'Copy', 'Copy'])
    expect(await names()).toEqual(['Copy', 'Copy', 'Copy the install command', 'Copy', 'Copy'].map(name => name.toLowerCase()))

    for (const id of ids)
      await page.click(`#${id}`)

    await page.waitUntil(() => document.querySelectorAll('.kui-copy-btn-live:not(:empty)').length === 5)

    expect(await widths()).toEqual(before)
    expect(await texts()).toEqual(['Copied!', 'Copied to the clipboard', 'Done', 'Copied!', 'Copied!'])
    expect(await names()).toEqual(['Copied!', 'Copied to the clipboard', 'Done', 'Copied!', 'Copied!'].map(name => name.toLowerCase()))
    await page.waitUntil(() => document.querySelectorAll('.kui-copy-btn-live:not(:empty)').length === 0, { timeout: '10s' })

    expect(await widths()).toEqual(before)
    expect(await texts()).toEqual(['Copy', 'Copy', 'Copy the install command', 'Copy', 'Copy'])
    expect(await names()).toEqual(['copy', 'copy', 'copy the install command', 'copy', 'copy'])
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a non-modal SidePanel and the space skin on a served page', () => {
  test('hydrates a non-modal SidePanel the server rendered open without closing or reopening it, its close link the IconButton look, above a sticky header', async () => {
    const site = await shared()

    await using page = await site.open('/')
    // Counts the calls that open or close a dialog from before the page's own scripts run, so a close then a reopen during hydration cannot hide.
    await page.initScript(() => {
      const calls: string[] = []
      const proto = HTMLDialogElement.prototype

      for (const name of ['show', 'showModal', 'close'] as const) {
        const original = proto[name]

        proto[name] = function (this: HTMLDialogElement, ...args: never[]) {
          calls.push(name)

          return (original as (...rest: never[]) => void).apply(this, args)
        }
      }

      Object.assign(window, { dialogCalls: calls })
    })
    await page.goto('/beside-open')
    await page.waitFor('#state')
    // Hydration is eager, so it ran before goto resolved; a beat of the event loop lets a late effect land.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    expect(await page.evaluate(() => (document.querySelector('#beside') as HTMLDialogElement).open)).toBe(true)
    expect(await page.text('#state')).toBe('open 0')
    expect(await page.evaluate(() => (window as unknown as { dialogCalls: string[] }).dialogCalls)).toEqual([])

    const close = await page.evaluate(() => {
      const link = document.querySelector('#beside a')!
      const styles = (selector: string) => Number.parseInt(getComputedStyle(document.querySelector(selector)!).zIndex)

      return { tag: link.tagName, classes: link.className, part: link.getAttribute('data-part'), tooltip: link.getAttribute('data-tooltip'), href: link.getAttribute('href'), panelZ: styles('#beside'), headerZ: styles('header.kui-app-header'), headerPosition: getComputedStyle(document.querySelector('header.kui-app-header')!).position }
    })

    expect(close).toMatchObject({ tag: 'A', part: 'root', tooltip: 'Close', href: '/list' })
    expect(close.classes).toContain('kui-icon-btn')
    expect(close.headerPosition).toBe('sticky')
    expect(close.panelZ).toBeGreaterThan(close.headerZ)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('draws the space skin: a tick in the checked box, one chevron on the select and a visible focus on every control', async () => {
    const site = await shared()

    await using page = await site.open('/space')
    // Everything opens by keyboard: a click would leave the focus moved after it as a pointer's, which :focus-visible does not follow.
    await page.press('Tab')
    await page.evaluate(() => document.querySelector<HTMLElement>('.kui-multi-select-trigger')!.focus())
    await page.press('Enter')
    await page.waitFor('.kui-multi-select-checkbox')

    const seen = await page.evaluate(() => {
      const one = (selector: string) => document.querySelector<HTMLElement>(selector)!
      const boxes = [one('#ticked'), one('#plain')].map((box) => {
        const tick = getComputedStyle(box, '::before')

        return { appearance: getComputedStyle(box).appearance, display: getComputedStyle(box).display, place: getComputedStyle(box).placeContent, size: box.getBoundingClientRect().width, tick: { width: tick.width, transform: tick.transform, clip: tick.clipPath, colour: tick.backgroundColor, opacity: tick.opacity }, ground: getComputedStyle(box).backgroundColor }
      })
      const select = getComputedStyle(one('#kind'))
      // The multi-select box shows its focus on the option row that holds it, an accent bar.
      const focusRing = (element: HTMLElement, shown: HTMLElement = element) => {
        element.focus()
        const style = getComputedStyle(shown)

        return { focused: element.matches(':focus-visible'), outline: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0, shadow: style.boxShadow !== 'none', border: style.borderTopColor }
      }

      return {
        boxes,
        select: { appearance: select.appearance, image: select.backgroundImage, supported: CSS.supports('appearance', 'base-select'), pickerIcon: getComputedStyle(one('#kind'), '::picker-icon').content },
        // The open panel first: focusing a control outside it closes the panel.
        focus: { multiSelect: focusRing(one('.kui-multi-select-checkbox'), one('.kui-multi-select-option')), checkbox: focusRing(one('#ticked')), select: focusRing(one('#kind')), key: focusRing(one('#key')), iconKey: focusRing(one('#icon-key')) },
      }
    })
    const [ticked, plain] = seen.boxes

    expect(ticked!.appearance).toBe('none')
    expect(ticked!.place).toBe('center')
    expect(ticked!.size).toBeGreaterThan(10)
    expect(ticked!.tick.width).toBe('10px')
    expect(ticked!.tick.clip).toContain('polygon')
    expect(ticked!.tick.transform).toBe('matrix(1, 0, 0, 1, 0, 0)')
    expect(ticked!.tick.opacity).toBe('1')
    expect(ticked!.tick.colour).not.toBe(ticked!.ground)
    expect(ticked!.tick.colour).not.toBe('rgba(0, 0, 0, 0)')
    expect(plain!.tick.transform).toBe('matrix(0, 0, 0, 0, 0, 0)')
    // A browser with base-select draws its own picker icon, so the gradient chevron is off; otherwise the two gradients are the one chevron.
    expect(seen.select.appearance).toBe(seen.select.supported ? 'base-select' : 'none')
    expect(seen.select.image === 'none').toBe(seen.select.supported)

    // The one chevron: the browser's own picker icon where base-select is supported, else the skin's two gradient strokes and no picker icon.
    if (seen.select.supported)
      expect(seen.select.pickerIcon).not.toBe('none')
    else
      expect(seen.select.image.match(/linear-gradient/g)).toHaveLength(2)

    for (const [name, ring] of Object.entries(seen.focus))
      expect(ring.focused && (ring.outline || ring.shadow), `${name} ${JSON.stringify(ring)}`).toBe(true)

    expect(await page.a11y()).toEqual([])
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a busy Slider', () => {
  // Starts a change with a key and leaves it pending, then returns what the slider holds.
  const state = (page: { evaluate: <R>(run: () => R) => Promise<R> }) => page.evaluate(() => ({
    value: document.querySelector<HTMLInputElement>('#level')!.value,
    changes: (window as unknown as { changes?: number }).changes ?? 0,
    busy: document.querySelector('#level')!.getAttribute('aria-busy'),
  }))
  const middle = (page: { evaluate: <R>(run: () => R) => Promise<R> }) => page.evaluate(() => {
    const box = document.querySelector('#level')!.getBoundingClientRect()

    return { left: box.left, right: box.right, y: box.top + box.height / 2 }
  })

  test('keeps its value and its onChange count against a mouse drag, a touch drag and the stepping keys, and lets Tab move focus', async () => {
    const site = await shared()

    await using page = await site.open('/slider-busy')

    await page.evaluate(() => document.querySelector<HTMLInputElement>('#level')!.focus())
    await page.press('ArrowRight')
    await page.waitUntil(() => document.querySelector('#level')!.getAttribute('aria-busy') === 'true')
    expect(await state(page)).toEqual({ value: '60', changes: 1, busy: 'true' })

    const box = await middle(page)
    const mouse = (type: string, x: number) => page.cdp('Input.dispatchMouseEvent', { type, x, y: box.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

    await mouse('mouseMoved', box.left + 5)
    await mouse('mousePressed', box.left + 5)
    await mouse('mouseMoved', box.left + 20)
    await mouse('mouseMoved', box.right - 5)
    await mouse('mouseReleased', box.right - 5)
    expect(await state(page)).toEqual({ value: '60', changes: 1, busy: 'true' })

    const touch = (type: string, x: number) => page.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: box.y }] })

    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true })
    await touch('touchStart', box.left + 5)
    await touch('touchMove', box.left + 20)
    await touch('touchMove', box.right - 5)
    await touch('touchEnd', box.right - 5)
    expect(await state(page)).toEqual({ value: '60', changes: 1, busy: 'true' })

    for (const key of ['ArrowLeft', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
      await page.press(key as never)

    expect(await state(page)).toEqual({ value: '60', changes: 1, busy: 'true' })

    // Tab is not a step: focus leaves the slider.
    await page.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('next')

    await page.click('#release')
    await page.waitUntil(() => document.querySelector('#level')!.getAttribute('aria-busy') === null)
    expect(await state(page)).toEqual({ value: '60', changes: 1, busy: null })

    // Once idle the same touch drag moves it, so the busy drag above was a real one.
    await touch('touchStart', box.left + 5)
    await touch('touchMove', box.right - 5)
    await touch('touchEnd', box.right - 5)
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('#level')!.value === '100')
    expect(page.errors).toEqual([])
  }, 120_000)
})
