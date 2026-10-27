import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// The length of public/episode.wav, 30 seconds of silence.
const SECONDS = 30
// One site and one browser for every test of the file; each test opens and closes its own page.
let built: ReturnType<typeof testSite> | undefined
const shared = async () => built ??= testSite({ root: ROOT, browser: { path } })

afterAll(async () => {
  if (built)
    (await built).close()
})

// CI installs Chromium: there, a missing browser fails rather than skipping.
const inBrowser = describe.skipIf(path === undefined && (process.env.CI ?? '') === '')

inBrowser('AudioPlayer in the browser', () => {
  async function open(dir?: 'rtl') {
    const site = await shared()
    const page = await site.open('/audio-player', { width: 400 })

    if (dir)
      await page.evaluate((value: string) => document.documentElement.setAttribute('dir', value), dir)

    await page.waitUntil(() => document.querySelector<HTMLInputElement>('#player [data-part=track]')?.max === '30')

    return page
  }

  test('at 400px the bar wraps and nothing overflows sideways, a chapter of ten thousand hours included', async () => {
    await using page = await open()
    const found = await page.evaluate(() => {
      const root = document.documentElement
      const wide = [...document.querySelectorAll('#player *, #long *')].filter(element => element.getBoundingClientRect().right > root.clientWidth + 1).map(element => element.getAttribute('data-part') ?? element.tagName)
      const row = document.querySelector<HTMLElement>('#long [data-part=chapter]:last-child')!
      const start = row.querySelector<HTMLElement>('[data-part=start]')!

      return { page: root.scrollWidth - root.clientWidth, wide, start: start.textContent, startFits: start.scrollWidth <= start.clientWidth, titleBeside: row.querySelector<HTMLElement>('[data-part=title]')!.getBoundingClientRect().left >= start.getBoundingClientRect().right }
    })

    expect(found).toEqual({ page: 0, wide: [], start: '10001:01:01', startFits: true, titleBeside: true })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('the transcript listens to the wheel and touch passively, so it never holds the scroll up', async () => {
    await using page = await open()
    await page.initScript(() => {
      const added: string[] = []
      const original = EventTarget.prototype.addEventListener

      EventTarget.prototype.addEventListener = function (type: string, listener: unknown, options?: boolean | AddEventListenerOptions) {
        if ((type === 'wheel' || type === 'touchmove') && (this as Element).getAttribute?.('data-part') === 'transcript')
          added.push(`${type}:${typeof options === 'object' && options.passive === true ? 'passive' : 'blocking'}`);

        (window as unknown as { __added: string[] }).__added = added

        return original.call(this, type, listener as EventListener, options)
      } as typeof original
    })
    await page.reload()
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('#player [data-part=track]')?.max === '30')
    expect(await page.evaluate(() => (window as unknown as { __added: string[] }).__added)).toEqual(['wheel:passive', 'touchmove:passive'])
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Tab reaches every control with the cues as one stop, and the slider and the chapter buttons answer the keys', async () => {
    await using page = await open()
    const focused = () => page.evaluate(() => {
      const element = document.activeElement!

      return element.getAttribute('data-part') ?? element.getAttribute('aria-label') ?? element.tagName
    })
    const order: string[] = []

    await page.evaluate(() => {
      document.querySelector('#player details')!.setAttribute('open', '')
      document.querySelector<HTMLElement>('#player [data-side=previous]')!.focus()
    })

    for (let step = 0; step < 11; step++) {
      order.push(await focused())
      await page.press('Tab')
    }

    expect(order).toEqual(['step', 'play', 'step', 'track', 'jump', 'jump', 'root', 'jump', 'summary', 'cue', 'step'])
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).tabIndex)).toBe(0)

    await page.evaluate(() => document.querySelector<HTMLElement>('#player [data-part=track]')!.focus())
    await page.press('ArrowRight')
    await page.press('ArrowRight')
    expect(await page.value('#player [data-part=track]')).toBe('2')
    expect(await page.evaluate(() => document.querySelector<HTMLAudioElement>('#player audio')!.currentTime)).toBe(2)

    await page.press('End')
    expect(await page.value('#player [data-part=track]')).toBe('30')

    const jump = (index: number) => page.evaluate((at: number) => document.querySelectorAll<HTMLElement>('#player [data-part=jump]')[at]!.focus(), index)
    const reached = (index: number) => page.waitUntil((at: number) => document.querySelectorAll('#player [data-part=jump]')[at]!.getAttribute('aria-current') === 'true', {}, index)

    await jump(1)
    await page.press('Enter')
    await reached(1)
    // Next onto the last chapter disables the button pressed, which keeps the focus.
    await page.evaluate(() => document.querySelector<HTMLElement>('#player [data-side=next]')!.focus())
    await page.press('Enter')
    await reached(2)
    expect(await page.evaluate(() => document.activeElement === document.querySelector('#player [data-side=next]'))).toBe(true)
    // A locked next ignores a press.
    const next = () => page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('#player [data-side=next]')!

      return { disabled: button.getAttribute('aria-disabled'), focused: document.activeElement === button }
    })

    await page.evaluate(() => document.querySelector<HTMLElement>('#player [data-side=next]')!.focus())
    expect(await next()).toEqual({ disabled: 'true', focused: true })
    await page.press('Enter')
    expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('#player [data-part=track]')!.value)).toBe('20')
    expect(page.errors).toEqual([])
  }, 120_000)

  for (const dir of ['ltr', 'rtl'] as const) {
    test(`the cue arrows follow the reading direction, ${dir}`, async () => {
      await using page = await open(dir === 'rtl' ? dir : undefined)
      const focused = () => page.evaluate(() => document.activeElement!.getAttribute('data-index'))

      await page.evaluate(() => {
        document.querySelector('#player details')!.setAttribute('open', '')
        document.querySelector<HTMLElement>('#player [data-part=cue][data-index="1"]')!.focus()
      })
      await page.press('ArrowRight')
      expect(await focused()).toBe(dir === 'rtl' ? '0' : '2')
      await page.press('ArrowLeft')
      expect(await focused()).toBe('1')
      await page.press('ArrowDown')
      expect(await focused()).toBe('2')
      expect(page.errors).toEqual([])
    }, 120_000)

    test(`the chapter marks sit on the thumb's travel and under it, ${dir === 'rtl' ? 'mirrored' : 'from the start'}`, async () => {
      await using page = await open(dir === 'rtl' ? dir : undefined)
      const found = await page.evaluate((length: number) => {
        const track = document.querySelector<HTMLInputElement>('#player [data-part=track]')!
        const box = track.getBoundingClientRect()
        const half = 8
        const rtl = getComputedStyle(track).direction === 'rtl'
        const centre = (element: Element) => element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2
        const expected = (seconds: number) => rtl ? box.right - half - (box.width - 2 * half) * seconds / length : box.left + half + (box.width - 2 * half) * seconds / length
        const marks = [...document.querySelectorAll('#player [data-part=mark]')]

        return {
          rtl,
          drift: marks.map((mark, index) => Math.abs(centre(mark) - expected([10, 20][index]!))),
          under: marks.every(mark => (mark.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
        }
      }, SECONDS)

      expect(found.rtl).toBe(dir === 'rtl')
      expect(found.drift.length).toBe(2)
      expect(found.drift.map(drift => drift < 1)).toEqual([true, true])
      expect(found.under).toBe(true)
    }, 120_000)
  }
})
