import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { hoverable, hoverOver } from './hoverable'

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

type Look = Record<string, string>

// Reads the computed value of each property of the first match, the pseudo-element's when `pseudo` is given.
async function looks(page: { evaluate: <Args extends unknown[], Result>(run: (...args: Args) => Result | Promise<Result>, ...args: Args) => Promise<Result> }, selector: string, properties: string[], pseudo?: string): Promise<Look> {
  return page.evaluate((target: string, names: string[], after: string | null) => {
    const computed = getComputedStyle(document.querySelector(target)!, after)

    return Object.fromEntries(names.map(name => [name, computed.getPropertyValue(name)]))
  }, selector, properties, pseudo ?? null)
}

async function box(page: { evaluate: <Args extends unknown[], Result>(run: (...args: Args) => Result | Promise<Result>, ...args: Args) => Promise<Result> }, selector: string) {
  return page.evaluate((target: string) => {
    const { left, top, right, bottom, width, height } = document.querySelector(target)!.getBoundingClientRect()

    return { left, top, right, bottom, width, height }
  }, selector)
}

inBrowser('chart and media recipes in the browser', () => {
  test('MapView lays Leaflet out inside its frame, draws the route in the accent and styles the controls and the attribution from the skin', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#map .leaflet-overlay-pane path')
    expect(await box(page, '#map [data-part=canvas]')).toMatchObject({ height: 384 })
    expect(await box(page, '#map .leaflet-container')).toEqual(await box(page, '#map [data-part=canvas]'))
    expect(await looks(page, '#map .leaflet-map-pane', ['position'])).toEqual({ position: 'absolute' })

    const line = await looks(page, '#map path.kui-map-view-line', ['stroke'])

    expect(line.stroke).not.toBe('')
    expect(line.stroke).not.toBe('rgb(51, 136, 255)')
    expect(await box(page, '#map .leaflet-control-zoom a')).toMatchObject({ width: 28, height: 28 })
    expect(await looks(page, '#map .leaflet-control-attribution', ['font-size', 'position'])).toMatchObject({ 'font-size': '11px' })
  })

  test('LineChart sizes its frame, plot, legend and key, lays its overlay over the plot, and draws the cursor, dots, band and tooltip it shows on a point', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#line .kui-line-chart-plot svg')
    const frame = await box(page, '#line [data-part=frame]')
    const plot = await box(page, '#line [data-part=plot]')
    const overlay = await box(page, '#line [data-part=overlay]')

    expect(await looks(page, '#line [data-part=root]', ['display', 'flex-direction', 'row-gap'])).toEqual({ 'display': 'flex', 'flex-direction': 'column', 'row-gap': '8px' })
    expect(await looks(page, '#line [data-part=frame]', ['position'])).toEqual({ position: 'relative' })
    // The plot is 9rem high unless the app sets --chart-height, and the overlay covers the frame exactly.
    expect(plot.height).toBe(144)
    expect(overlay).toEqual(frame)
    expect(await looks(page, '#line [data-part=overlay]', ['position', 'cursor', 'touch-action', 'user-select'])).toEqual({ 'position': 'absolute', 'cursor': 'crosshair', 'touch-action': 'pan-y', 'user-select': 'none' })
    expect(await looks(page, '#line [data-part=legend]', ['display', 'flex-wrap', 'column-gap', 'padding-left'])).toEqual({ 'display': 'flex', 'flex-wrap': 'wrap', 'column-gap': '16px', 'padding-left': '4px' })
    expect(await looks(page, '#line [data-part=legendItem]', ['display', 'column-gap', 'font-size'])).toEqual({ 'display': 'flex', 'column-gap': '6px', 'font-size': '12px' })
    expect(await box(page, '#line [data-part=key]')).toMatchObject({ width: 16, height: 2 })
    // The table for screen readers is clipped away to a pixel.
    expect(await box(page, '#line [data-part=data]')).toMatchObject({ width: 1, height: 1 })
    expect(await looks(page, '#line [data-part=hint]', ['position'])).toEqual({ position: 'absolute' })

    // A press focuses the plot and picks a point; Shift with an arrow then picks a span.
    await page.click('#line [data-part=overlay]', { at: { x: frame.width / 2, y: 60 } })
    await page.press('ArrowLeft', { modifiers: ['Shift'] })
    await page.waitFor('#line [data-part=band]')
    await page.waitFor('#line [data-part=tooltip]')
    const cursor = await box(page, '#line [data-part=cursor]')
    const band = await box(page, '#line [data-part=band]')
    const plotArea = await page.evaluate(() => document.querySelector('#line .ct-grids')!.getBoundingClientRect().height)

    expect(cursor.width).toBe(1)
    expect(cursor.height).toBeGreaterThan(0)
    expect(cursor.height).toBeLessThanOrEqual(plotArea + 1)
    expect(await looks(page, '#line [data-part=cursor]', ['position', 'pointer-events'])).toEqual({ 'position': 'absolute', 'pointer-events': 'none' })
    expect(band.height).toBe(cursor.height)
    expect(band.width).toBeGreaterThan(1)
    expect(await looks(page, '#line [data-part=band]', ['position', 'pointer-events', 'border-left-width', 'border-right-width', 'border-top-width'])).toEqual({ 'position': 'absolute', 'pointer-events': 'none', 'border-left-width': '1px', 'border-right-width': '1px', 'border-top-width': '0px' })

    // Each dot is a 8px square centred on its point, whose line the cursor stands on.
    const dots = await page.evaluate(() => [...document.querySelectorAll('#line [data-part=dot]')].map((dot) => {
      const { width, height, left, top } = dot.getBoundingClientRect()
      const computed = getComputedStyle(dot)

      return { width, height, centre: left + width / 2, middle: top + height / 2, position: computed.position, events: computed.pointerEvents, border: computed.borderTopWidth }
    }))

    expect(dots).toHaveLength(2)

    for (const dot of dots) {
      expect(dot).toMatchObject({ width: 8, height: 8, position: 'absolute', events: 'none', border: '1px' })
      expect(Math.abs(dot.centre - cursor.left)).toBeLessThanOrEqual(1)
    }

    const tip = await looks(page, '#line [data-part=tooltip]', ['position', 'pointer-events', 'z-index', 'width', 'display', 'flex-direction', 'padding-top', 'padding-left', 'font-size', 'border-top-width'])
    const unit = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--border-width').trim())

    expect(tip).toMatchObject({ 'position': 'fixed', 'pointer-events': 'none', 'z-index': '50', 'display': 'flex', 'flex-direction': 'column', 'padding-top': '8px', 'padding-left': '12px', 'font-size': '12px' })
    expect(tip['border-top-width']).toBe(unit)
    expect((await box(page, '#line [data-part=tooltip]')).width).toBeLessThan(frame.width)
    expect(await looks(page, '#line [data-part=tooltipRow]', ['display', 'align-items', 'column-gap'])).toEqual({ 'display': 'flex', 'align-items': 'center', 'column-gap': '6px' })
    expect(await box(page, '#line [data-part=swatch]')).toMatchObject({ width: 8, height: 8 })
    expect(await looks(page, '#line [data-part=tooltipValue]', ['margin-left', 'padding-left', 'font-variant-numeric'])).toMatchObject({ 'margin-left': expect.stringMatching(/px$/), 'padding-left': '12px' })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('ScatterChart turns its y label upright along the plot, centres the x label under it, and sizes a button dot by its weight, lighter at rest than hovered', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await hoverable(page)
    const plot = await box(page, '#scatter [data-part=plot]')
    const yLabel = await box(page, '#scatter [data-part=axisLabel][data-axis=y]')
    const xLabel = await box(page, '#scatter [data-part=axisLabel][data-axis=x]')

    expect(await looks(page, '#scatter [data-part=axisLabel][data-axis=y]', ['writing-mode', 'rotate', 'text-align'])).toEqual({ 'writing-mode': 'vertical-rl', 'rotate': '180deg', 'text-align': 'center' })
    // The y label is a column left of the plot, as tall as the plot box; the x label sits under it, in the plot's column and ending with it.
    expect(yLabel.right).toBeLessThanOrEqual(plot.left)
    expect(yLabel.height).toBeLessThanOrEqual(plot.height + 1)
    expect(yLabel.width).toBeLessThan(yLabel.height)
    expect(xLabel.top).toBeGreaterThanOrEqual(plot.bottom)
    expect(xLabel.left).toBeGreaterThanOrEqual(yLabel.right)
    expect(xLabel.right).toBeCloseTo(plot.right, 0)
    expect(await looks(page, '#scatter [data-part=axisLabel][data-axis=x]', ['text-align', 'writing-mode'])).toEqual({ 'text-align': 'center', 'writing-mode': 'horizontal-tb' })

    const read = async () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#scatter [data-part=dot]')].map((dot) => {
      const computed = getComputedStyle(dot)
      const { width, height } = dot.getBoundingClientRect()

      return { tag: dot.tagName, width, height, size: Number.parseFloat(dot.style.getPropertyValue('--_dot-size')) * 16, radius: computed.borderTopLeftRadius, opacity: computed.opacity, cursor: computed.cursor, position: computed.position, translate: computed.translate }
    }))
    const [heavy, light] = await read()

    expect(heavy).toMatchObject({ tag: 'BUTTON', position: 'absolute', opacity: '0.7', cursor: 'pointer', translate: '-50% 50%' })
    expect(heavy!.width).toBe(heavy!.size)
    expect(heavy!.height).toBe(heavy!.size)
    expect(Number.parseFloat(heavy!.radius)).toBeGreaterThan(heavy!.width)
    expect(heavy!.width).toBeGreaterThan(light!.width)
    await hoverOver(page, '#scatter [data-part=dot]')
    expect((await read())[0]!.opacity).toBe('1')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('MediaGallery pins its arrows, counter and caption inside the stage, strips thumbnails below it and opens a lightbox that centres the picture', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#gallery [data-part=stage] img')
    const stage = await box(page, '#gallery [data-part=stage]')

    expect(await looks(page, '#gallery [data-part=root]', ['display', 'flex-direction', 'row-gap', 'outline-style'])).toMatchObject({ 'display': 'flex', 'flex-direction': 'column', 'row-gap': '8px' })
    expect(await looks(page, '#gallery [data-part=stage]', ['position', 'overflow-x', 'overflow-y', 'touch-action', 'background-color', 'aspect-ratio'])).toMatchObject({ 'position': 'relative', 'overflow-x': 'hidden', 'overflow-y': 'hidden', 'touch-action': 'pan-y', 'background-color': 'rgb(0, 0, 0)' })
    expect(stage.width).toBe(480)
    // The picture fills the stage, contained; its button is a block of the same size.
    expect(await box(page, '#gallery [data-part=zoom]')).toEqual(await box(page, '#gallery [data-part=stage] [data-part=frame]'))
    expect(await box(page, '#gallery [data-part=zoom]')).toMatchObject({ width: stage.width, height: stage.height })
    expect(await looks(page, '#gallery [data-part=stage] [data-part=frame]', ['object-fit'])).toEqual({ 'object-fit': 'contain' })
    expect(await looks(page, '#gallery [data-part=zoom]', ['cursor', 'display'])).toEqual({ cursor: 'zoom-in', display: 'block' })

    const previous = await box(page, '#gallery [data-part=stage] [data-part=step][data-side=previous]')
    const next = await box(page, '#gallery [data-part=stage] [data-part=step][data-side=next]')

    // Arrows sit 8px from the sides at the stage's vertical middle, turned to point outward.
    expect(previous.left - stage.left).toBe(8)
    expect(stage.right - next.right).toBe(8)
    expect(Math.abs(previous.top + previous.height / 2 - (stage.top + stage.height / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(next.top + next.height / 2 - (stage.top + stage.height / 2))).toBeLessThanOrEqual(1)
    expect(await looks(page, '#gallery [data-part=stage] [data-part=step][data-side=previous]', ['position', 'rotate'])).toEqual({ position: 'absolute', rotate: '90deg' })
    expect((await looks(page, '#gallery [data-part=stage] [data-part=step][data-side=next]', ['rotate'])).rotate).toBe('-90deg')

    const counter = await box(page, '#gallery [data-part=counter]')
    const caption = await box(page, '#gallery [data-part=stage] > [data-part=caption]')

    expect(counter.left - stage.left).toBe(8)
    expect(counter.top - stage.top).toBe(8)
    expect(await looks(page, '#gallery [data-part=counter]', ['position', 'pointer-events', 'font-variant-numeric'])).toEqual({ 'position': 'absolute', 'pointer-events': 'none', 'font-variant-numeric': 'tabular-nums' })
    expect(caption).toMatchObject({ left: stage.left, right: stage.right, bottom: stage.bottom })
    expect(await looks(page, '#gallery [data-part=stage] > [data-part=caption]', ['position', 'pointer-events', 'text-overflow', 'color'])).toEqual({ 'position': 'absolute', 'pointer-events': 'none', 'text-overflow': 'ellipsis', 'color': 'rgb(255, 255, 255)' })

    // The strip scrolls sideways under the stage, its thumbnails 48px high in 16:9, the current one lit.
    const strip = await box(page, '#gallery [data-part=strip]')

    expect(strip.top).toBeGreaterThanOrEqual(stage.bottom)
    expect(await looks(page, '#gallery [data-part=strip]', ['display', 'overflow-x', 'column-gap'])).toEqual({ 'display': 'flex', 'overflow-x': 'auto', 'column-gap': '6px' })
    const thumb = await box(page, '#gallery [data-part=thumb]')

    expect(thumb.height).toBe(48)
    expect(thumb.width).toBeCloseTo(48 * 16 / 9, 1)
    const thumbs = await page.evaluate(() => [...document.querySelectorAll('#gallery [data-part=thumb]')].map((thumb) => {
      const computed = getComputedStyle(thumb)

      return { opacity: computed.opacity, border: computed.borderTopWidth, shrink: computed.flexShrink, colour: computed.borderTopColor, current: thumb.getAttribute('aria-current') }
    }))

    expect(thumbs.map(thumb => thumb.current)).toEqual(['true', null])
    expect(thumbs.map(thumb => thumb.opacity)).toEqual(['1', '0.6'])
    expect(thumbs.map(thumb => thumb.border)).toEqual(['2px', '2px'])
    expect(thumbs[0]!.colour).not.toBe(thumbs[1]!.colour)
    expect(thumbs[1]!.colour).toBe('rgba(0, 0, 0, 0)')
    expect(await looks(page, '#gallery [data-part=thumbImage]', ['object-fit', 'background-color'])).toEqual({ 'object-fit': 'cover', 'background-color': 'rgb(0, 0, 0)' })

    // The lightbox is shut with no rules of its own showing, then opens over the page with the picture contained and the buttons at its corner.
    expect((await looks(page, '#gallery [data-part=lightbox]', ['display'])).display).toBe('none')
    await page.click('#gallery [data-part=zoom]')
    await page.waitFor('#gallery [data-part=lightbox] [data-part=full]')
    const lightbox = await box(page, '#gallery [data-part=lightbox]')
    const full = await box(page, '#gallery [data-part=full]')
    const close = await box(page, '#gallery [data-part=close]')
    const wide = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }))

    expect(await looks(page, '#gallery [data-part=lightbox]', ['border-top-width', 'padding-top', 'overflow-x', 'background-color'])).toEqual({ 'border-top-width': '0px', 'padding-top': '0px', 'overflow-x': 'visible', 'background-color': 'rgba(0, 0, 0, 0)' })
    expect(full.width).toBeLessThanOrEqual(wide.width * 0.96 + 1)
    expect(full.height).toBeLessThanOrEqual(wide.height * 0.96 + 1)
    expect(Math.abs(lightbox.left + lightbox.width / 2 - wide.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(lightbox.top + lightbox.height / 2 - wide.height / 2)).toBeLessThanOrEqual(1)
    expect(await looks(page, '#gallery [data-part=full]', ['object-fit'])).toEqual({ 'object-fit': 'contain' })
    expect(lightbox.right - close.right).toBe(8)
    expect(close.top - lightbox.top).toBe(8)
    expect(await looks(page, '#gallery [data-part=close]', ['position'])).toEqual({ position: 'absolute' })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('ImageCropper lays its crop over the picture, with a 40px hit area centred on each corner and a grid of thirds', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#cropper [data-part=crop]')
    const stage = await box(page, '#cropper [data-part=stage]')
    const image = await box(page, '#cropper [data-part=image]')
    const crop = await box(page, '#cropper [data-part=crop]')

    expect(await looks(page, '#cropper [data-part=stage]', ['position', 'overflow-x', 'touch-action', 'user-select', 'cursor', 'border-top-width'])).toMatchObject({ 'position': 'relative', 'overflow-x': 'hidden', 'touch-action': 'none', 'user-select': 'none', 'cursor': 'crosshair' })
    expect(await looks(page, '#cropper [data-part=image]', ['display'])).toEqual({ display: 'block' })
    // The picture fills the stage inside its border, and the crop stays inside the picture.
    expect(image.width).toBeLessThanOrEqual(stage.width)
    expect(crop.left).toBeGreaterThanOrEqual(image.left)
    expect(crop.right).toBeLessThanOrEqual(image.right + 1)
    expect(crop.top).toBeGreaterThanOrEqual(image.top)
    expect(crop.bottom).toBeLessThanOrEqual(image.bottom + 1)
    expect(crop.width).toBeCloseTo(crop.height, 0)
    const area = await looks(page, '#cropper [data-part=crop]', ['position', 'cursor', 'border-top-style', 'border-top-width', 'box-shadow', 'outline-style'])

    expect(area).toMatchObject({ 'position': 'absolute', 'cursor': 'move', 'border-top-style': 'dashed', 'border-top-width': '2px', 'outline-style': 'none' })
    // The shade around the crop is a spread shadow wide enough to cover any picture.
    expect(area['box-shadow']).toContain('9999px')

    // Focused by the keyboard it gets an outline of its own beside the solid accent border.
    await page.evaluate((() => document.querySelector<HTMLElement>('#cropper [data-part=crop]')!.focus({ preventScroll: true })) as never)
    expect(await looks(page, '#cropper [data-part=crop]', ['outline-style', 'outline-width'])).toEqual({ 'outline-style': 'solid', 'outline-width': '2px' })

    const corners = { nw: ['left', 'top'], ne: ['right', 'top'], sw: ['left', 'bottom'], se: ['right', 'bottom'] } as const

    for (const [handle, [horizontal, vertical]] of Object.entries(corners)) {
      const box40 = await box(page, `#cropper [data-handle=${handle}]`)

      expect(box40, handle).toMatchObject({ width: 40, height: 40 })
      expect(Math.abs(box40.left + 20 - crop[horizontal]), handle).toBeLessThanOrEqual(2.5)
      expect(Math.abs(box40.top + 20 - crop[vertical]), handle).toBeLessThanOrEqual(2.5)
      expect((await looks(page, `#cropper [data-handle=${handle}]`, ['position', 'cursor'])).position).toBe('absolute')
    }

    expect((await looks(page, '#cropper [data-handle=nw]', ['cursor'])).cursor).toBe('nw-resize')
    expect((await looks(page, '#cropper [data-handle=se]', ['cursor'])).cursor).toBe('se-resize')
    // The handle sits on the crop's corner, measured from inside its 2px border.
    // The 16px dot is drawn by the handle's ::before, 12px in from the hit area's edges.
    expect(await looks(page, '#cropper [data-handle=nw]', ['width', 'height', 'border-top-width', 'border-top-left-radius', 'position'], '::before')).toMatchObject({ 'width': '16px', 'height': '16px', 'border-top-width': '2px', 'position': 'absolute' })

    const cols = await box(page, '#cropper [data-part=gridCols]')
    const rows = await box(page, '#cropper [data-part=gridRows]')

    expect(cols).toMatchObject({ top: crop.top + 2, height: crop.height - 4 })
    expect(cols.width).toBeCloseTo((crop.width - 4) / 3, 0)
    expect(rows.height).toBeCloseTo((crop.height - 4) / 3, 0)
    expect(rows.width).toBeCloseTo(crop.width - 4, 0)
    expect(await looks(page, '#cropper [data-part=gridCols]', ['pointer-events', 'position'])).toEqual({ 'pointer-events': 'none', 'position': 'absolute' })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('ZoomPane clips its plate to the pane, pins the tools to its corner, and scales the plate from its top-left', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#zoom [data-part=tools]')
    const pane = await box(page, '#zoom [data-part=root]')

    expect(pane).toMatchObject({ width: 300, height: 200 })
    expect(await looks(page, '#zoom [data-part=root]', ['position', 'overflow-x', 'overflow-y', 'cursor', 'user-select', 'touch-action'])).toEqual({ 'position': 'relative', 'overflow-x': 'hidden', 'overflow-y': 'hidden', 'cursor': 'grab', 'user-select': 'none', 'touch-action': 'pan-y' })
    expect(await box(page, '#zoom [data-part=plate]')).toMatchObject({ width: 300, height: 200 })
    expect((await looks(page, '#zoom [data-part=plate]', ['transform-origin']))['transform-origin']).toBe('0px 0px')

    const tools = await box(page, '#zoom [data-part=tools]')

    expect(pane.right - tools.right).toBe(4)
    expect(tools.top - pane.top).toBe(4)
    expect(await looks(page, '#zoom [data-part=tools]', ['position', 'display', 'column-gap'])).toEqual({ 'position': 'absolute', 'display': 'flex', 'column-gap': '4px' })

    // Zooming in grows the plate from its corner past the pane, which clips it, and hands the gestures to the pane.
    await page.click('#zoom [aria-label="Zoom in"]')
    await page.waitUntil(() => getComputedStyle(document.querySelector('#zoom [data-part=root]')!).touchAction === 'none')
    const zoomed = await box(page, '#zoom [data-part=plate]')

    expect(zoomed.width).toBeGreaterThan(300)
    expect(zoomed.height).toBeGreaterThan(200)
    expect(await box(page, '#zoom [data-part=root]')).toMatchObject({ width: 300, height: 200 })
    expect((await looks(page, '#zoom [data-part=plate]', ['transform'])).transform).toMatch(/^matrix\(/)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Masonry places its tiles in lanes of equal width, each in the shortest lane and gaps apart, once they are measured', async () => {
    const site = await shared()

    await using page = await site.open('/chart-media', { width: 1000 })

    await page.waitFor('#masonry [data-part=tile][data-placed]')
    await page.waitUntil(() => document.querySelectorAll('#masonry [data-part=tile]:not([data-pending])[data-placed]').length === 4)
    const root = await box(page, '#masonry [data-part=root]')
    const tiles = await page.evaluate(() => [...document.querySelectorAll('#masonry [data-part=tile]')].map((tile) => {
      const { left, top, width, height } = tile.getBoundingClientRect()
      const computed = getComputedStyle(tile)

      return { left, top, width, height, position: computed.position, visibility: computed.visibility, minWidth: computed.minWidth }
    }))

    expect(await looks(page, '#masonry [data-part=root]', ['position', 'display'])).toEqual({ position: 'relative', display: 'block' })
    // 600px with 12px gaps and 180px at least make three lanes of 192px.
    expect(tiles.map(tile => tile.position)).toEqual(['absolute', 'absolute', 'absolute', 'absolute'])
    expect(tiles.map(tile => tile.visibility)).toEqual(['visible', 'visible', 'visible', 'visible'])
    expect(tiles.map(tile => Math.round(tile.width))).toEqual([192, 192, 192, 192])
    expect(tiles.map(tile => Math.round(tile.left - root.left))).toEqual([0, 204, 408, 408])
    // The fourth drops under the shortest lane, the third (60px) with a gap below it.
    expect(tiles.map(tile => Math.round(tile.top - root.top))).toEqual([0, 0, 0, 72])
    expect(tiles.map(tile => tile.minWidth)).toEqual(['0px', '0px', '0px', '0px'])
    expect(root.height).toBe(172)
    expect(page.errors).toEqual([])
  }, 120_000)
})
