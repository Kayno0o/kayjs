import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// The server's control, described by its own note and the hint it renders after it.
const SERVED = /aria-describedby="name-note (k[\w-]+)">.*class="kui-form-field-hint" id="\1"/
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
