import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>t</title><style>body{margin:0}canvas{display:block;width:300px;height:3000px}</style>
<canvas id="c"></canvas>
<script>
  const c = document.querySelector('#c')
  window.log = []
  c.addEventListener('pointermove', e => log.push(['move', e.isTrusted, e.offsetX, e.offsetY]))
  c.addEventListener('pointerover', e => log.push(['over', e.isTrusted]))
  c.addEventListener('click', e => log.push(['click', e.isTrusted, e.offsetX, e.offsetY]))
</script>`

const DRAG = `<!doctype html><meta name="viewport" content="width=device-width"><title>t</title><style>body{margin:0}div{height:40px}#to{margin-top:2000px}</style>
<div id="from">from</div><div id="to">to</div>
<script>
  window.log = []
  for (const type of ['pointerdown', 'pointermove', 'pointerup'])
    document.addEventListener(type, e => log.push([type, e.pointerType, e.target.id, e.isTrusted]), true)
</script>`

const server = Bun.serve({ port: 0, fetch: request => new Response(new URL(request.url).pathname === '/drag' ? DRAG : PAGE, { headers: { 'content-type': 'text/html' } }) })
const url = `http://127.0.0.1:${server.port}/`

afterAll(async () => server.stop(true))

describe.skipIf(browserPath() === undefined && (process.env.CI ?? '') === '')('the pointer and the viewport of a kay/test page', () => {
  it('hovers and clicks at a point of an element, scrolled into view', async () => {
    await using page = await browse(url)

    await page.hover('#c', { at: { x: 40, y: 2500 } })

    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    // The headless shell moves its pointer to the page's corner as the scroll lands, a move at 0,0 that full Chrome does not report.
    expect(await page.evaluate(() => (window as unknown as { log: unknown[][] }).log.filter(row => row[0] !== 'move' || (row[1] === true && (row[2] !== 0 || row[3] !== 0))))).toEqual([['over', true], ['move', true, 40, 2500]])

    await page.click('#c', { at: { x: 100, y: 10 } })

    const log = await page.evaluate(() => (window as unknown as { log: unknown[][] }).log)

    expect(log.at(-1)).toEqual(['click', true, 100, 10])
  }, 60_000)

  it('drags from one element to another far below, by mouse and by touch', async () => {
    await using page = await browse(`${url}drag`)
    const rows = async () => page.evaluate(() => (window as unknown as { log: unknown[][] }).log)

    await page.drag('#from', '#to', { steps: 4 })

    const mouse = (await rows()).filter(row => row[0] !== 'pointermove' || row[2] === 'to')

    expect(mouse[0]).toEqual(['pointerdown', 'mouse', 'from', true])
    expect(mouse.at(-1)).toEqual(['pointerup', 'mouse', 'to', true])
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await page.evaluate(() => ((window as unknown as { log: unknown[][] }).log.length = 0))
    await page.drag('#from', '#to', { hold: 50 })

    const touch = await rows()

    expect(touch.find(row => row[0] === 'pointerdown')).toEqual(['pointerdown', 'touch', 'from', true])
    await expect(page.drag('#from', '#to', { steps: 0 })).rejects.toThrow('steps')
  }, 60_000)

  it('opens a page at a phone size from its first load', async () => {
    await using page = await browse(url, { viewport: 'phone' })

    expect(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([390, 844, 2])

    await using custom = await browse(url, { viewport: { width: 500, height: 600 } })

    expect(await custom.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([500, 600, 1])
  }, 60_000)
})
