import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true })
const PATH = '/admin/page?path=/blog/hello'

// Each page holds the live connection the editor's presence keeps open, and a browser allows a host a few, so a page is closed with its test.
const opened: { close: () => void }[] = []

afterEach(() => {
  for (const page of opened.splice(0))
    page.close()
})

afterAll(async () => {
  await built.close()
})

interface Sized {
  panel: { left: number, top: number, right: number, bottom: number }
  page: { right: number, bottom: number }
  window: { width: number, height: number }
}

// Opens the page in a window of the given size, with a fixed site header and a page long enough to scroll, as a site has.
async function open(width: number, height: number) {
  const page = await built.open(PATH)

  opened.push(page)

  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null && document.documentElement.classList.contains('kcms-dock-side') !== document.documentElement.classList.contains('kcms-dock-bottom'))
  await page.evaluate(() => {
    const header = document.createElement('header')

    header.id = 'site-header'
    header.textContent = 'Site'
    header.style.cssText = 'position:fixed;top:0;left:0;right:0;height:48px;background:#ccc;z-index:10'
    document.body.prepend(header)
    document.body.style.paddingTop = '48px'

    const spacer = document.createElement('div')

    spacer.style.height = '3000px'
    document.body.append(spacer)
    dispatchEvent(new Event('scroll'))
  })
  // The side dock moves under the header once it measures it.
  await page.waitUntil(() => document.documentElement.classList.contains('kcms-dock-bottom') || document.querySelector('.kcms-editor')!.getBoundingClientRect().top === 48)

  return page
}

async function measure(page: Awaited<ReturnType<typeof open>>): Promise<Sized> {
  return page.evaluate(() => {
    const panel = document.querySelector('.kcms-editor')!.getBoundingClientRect()
    const body = document.body.getBoundingClientRect()

    return {
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
      page: { right: body.right, bottom: body.bottom },
      window: { width: document.documentElement.clientWidth, height: innerHeight },
    }
  })
}

test('on a wide window the editor sits at the side and the page keeps the rest, its width and its header', async () => {
  const page = await open(1280, 800)
  const { panel, page: body, window } = await measure(page)

  expect(panel.right).toBe(window.width)
  expect(panel.left).toBe(window.width - 384)
  expect(body.right).toBeLessThanOrEqual(panel.left)
  expect(page.errors).toEqual([])
})

test('a header fixed across the window stays visible over the side dock, which starts under it', async () => {
  const page = await open(1280, 800)

  const { panel, window } = await measure(page)
  const seen = await page.evaluate(() => document.elementFromPoint(document.documentElement.clientWidth - 10, 24)?.id)

  expect(panel.top).toBe(48)
  expect(panel.bottom).toBe(window.height)
  expect(seen).toBe('site-header')
})

test('a drag of the edge resizes the editor and keeps the layout once, when the drag ends', async () => {
  const page = await open(1280, 800)
  const grip = await page.evaluate(() => {
    const box = document.querySelector('.kcms-editor-grip')!.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + 300 }
  })
  const mouse = (type: string, x: number) => page.cdp('Input.dispatchMouseEvent', { type, x, y: grip.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

  await page.evaluate(() => {
    const keep = Storage.prototype.setItem
    const writes: string[] = []

    Object.assign(window, { writes })
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'kcms-editor')
        writes.push(value)

      return keep.call(this, key, value)
    }
  })
  await mouse('mouseMoved', grip.x)
  await mouse('mousePressed', grip.x)
  await mouse('mouseMoved', grip.x - 20)
  await mouse('mouseMoved', grip.x - 50)
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().width === 434)
  expect(await page.evaluate(() => (window as unknown as { writes: string[] }).writes.length)).toBe(0)
  await mouse('mouseReleased', grip.x - 50)
  await page.waitUntil(() => (window as unknown as { writes: string[] }).writes.length > 0)
  expect((await page.evaluate(() => (window as unknown as { writes: string[] }).writes)).map(write => JSON.parse(write))).toEqual([{ open: true, side: 434 }])

  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().width === 434)
})

test('the values of the resize separator account for what a docked dev tool holds', async () => {
  const page = await open(1280, 800)
  const values = () => page.evaluate(() => {
    const grip = document.querySelector('.kcms-editor-grip')!

    return [grip.getAttribute('aria-valuenow'), grip.getAttribute('aria-valuemax')]
  })

  expect(await values()).toEqual(['384', '928'])
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--kay-dev-inset-right', '600px')
    document.documentElement.style.paddingRight = '600px'
  })
  await page.waitUntil(() => document.querySelector('.kcms-editor-grip')!.getAttribute('aria-valuemax') === '328')
  expect(await values()).toEqual(['328', '328'])
})

test('the values of the bottom separator account for a bottom-docked dev tool, which pads the root without changing its content', async () => {
  const page = await open(390, 800)
  const grip = () => page.evaluate(() => [document.querySelector('.kcms-editor-grip')!.getAttribute('aria-valuenow'), document.querySelector('.kcms-editor-grip')!.getAttribute('aria-valuemax')])

  expect(await grip()).toEqual(['400', '640'])
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--kay-dev-inset-bottom', '400px')
    document.documentElement.style.paddingBottom = '400px'
  })
  await page.waitUntil(() => document.querySelector('.kcms-editor-grip')!.getAttribute('aria-valuemax') === '240')
  expect(await grip()).toEqual(['240', '240'])
})

test('an editor left collapsed never shows open while the page loads', async () => {
  const page = await open(390, 800)

  await page.click('.kcms-editor-head button[aria-label="Hide the editor"]')
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') === null)
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function watch() {
      const panel = document.querySelector('.kcms-editor-open')

      if (panel && getComputedStyle(panel).visibility !== 'hidden')
        window.flashed = true

      requestAnimationFrame(watch)
    })()`,
  })
  await page.reload()
  await page.waitUntil(() => document.documentElement.classList.contains('kcms-dock-bottom'))
  await Bun.sleep(300)
  expect(await page.evaluate(() => (window as unknown as { flashed?: boolean }).flashed)).toBeUndefined()
})

test('a click that lies under a fixed header at the top scrolls the element clear of it', async () => {
  const page = await open(390, 800)

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('h1')!.style.marginTop = '1000px'
    scrollTo(0, document.querySelector('h1')!.getBoundingClientRect().top + scrollY - 20)
  })
  await page.waitUntil(() => document.querySelector('h1')!.getBoundingClientRect().top < 30)
  await page.evaluate(() => document.querySelector<HTMLElement>('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 0 })))
  await page.waitUntil(() => document.querySelector('h1')!.getBoundingClientRect().top >= 48)
})

test('between 40rem and 64rem the editor takes the bottom, so the page keeps its width and a fixed header stays in view', async () => {
  const page = await open(800, 700)
  const { panel, window } = await measure(page)
  const header = await page.evaluate(() => document.querySelector('#site-header')!.getBoundingClientRect().right)
  const room = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).paddingBottom))

  expect(panel.left).toBe(0)
  expect(panel.right).toBe(window.width)
  expect(panel.bottom).toBe(window.height)
  expect(panel.top).toBeGreaterThan(48 + 100)
  expect(header).toBe(window.width)
  expect(room).toBe(window.height - panel.top)
})

test('on a phone the sheet can be resized by the keyboard, the size remembered, and collapsed', async () => {
  const page = await open(390, 800)
  const height = async () => (await measure(page)).panel.bottom - (await measure(page)).panel.top
  const before = await height()

  expect(before).toBe(400)

  await page.evaluate(() => document.querySelector<HTMLElement>('.kcms-editor-grip')!.focus())
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('separator')
  await page.press('ArrowUp')
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().height === 424)
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-grip')!.getAttribute('aria-valuenow'))).toBe('424')

  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().height === 424)

  // Down shrinks it again, never past its smallest height.
  await page.evaluate(() => document.querySelector<HTMLElement>('.kcms-editor-grip')!.focus())
  for (let press = 0; press < 20; press++)
    await page.press('ArrowDown')

  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().height === 160)

  await page.click('.kcms-editor-head button[aria-label="Hide the editor"]')
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') === null)

  const collapsed = await measure(page)

  expect(collapsed.panel.bottom - collapsed.panel.top).toBeLessThan(64)
  expect(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).paddingBottom))).toBe(0)

  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor') !== null && document.documentElement.classList.contains('kcms-dock-bottom'))
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-open'))).toBeNull()
  await page.click('.kcms-editor-head button[aria-label="Edit this page"]')
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null)
  expect(page.errors).toEqual([])
})

test('the side is resized by the keyboard and the size remembered', async () => {
  const page = await open(1280, 800)

  await page.evaluate(() => document.querySelector<HTMLElement>('.kcms-editor-grip')!.focus())
  await page.press('ArrowLeft')
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().width === 408)
  const resized = await measure(page)

  expect(resized.page.right).toBe(resized.window.width - 408)
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor')!.getBoundingClientRect().width === 408)
})

test('the dock can be switched, below 40rem only the bottom being offered', async () => {
  const page = await open(1280, 800)

  await page.click('button[aria-label="Dock the editor to the bottom"]')
  await page.waitUntil(() => document.documentElement.classList.contains('kcms-dock-bottom'))
  expect((await measure(page)).panel.left).toBe(0)
  await page.reload()
  await page.waitUntil(() => document.documentElement.classList.contains('kcms-dock-bottom'))
  expect(await page.count('button[aria-label="Dock the editor to the side"]')).toBe(1)

  const phone = await open(390, 800)

  expect(await phone.count('.kcms-editor-head button[aria-label^="Dock the editor"]')).toBe(0)
})

test('the editor sits beside the dev tool docked at the right or the bottom, and moves back when it goes', async () => {
  const page = await open(1280, 800)
  const dev = (right: string, bottom: string) => page.evaluate((r, b) => {
    document.documentElement.style.setProperty('--kay-dev-inset-right', r)
    document.documentElement.style.setProperty('--kay-dev-inset-bottom', b)
    // What the dev tool's docked drawer does to the page besides publishing it.
    document.documentElement.style.paddingRight = r
    document.documentElement.style.paddingBottom = b
  }, right, bottom)

  await dev('448px', '0px')

  const side = await measure(page)

  expect(side.panel.right).toBe(side.window.width - 448)
  expect(side.page.right).toBeLessThanOrEqual(side.panel.left)
  expect(side.panel.left).toBeGreaterThanOrEqual(280)

  await dev('0px', '0px')
  expect((await measure(page)).panel.right).toBe(side.window.width)

  await page.click('button[aria-label="Dock the editor to the bottom"]')
  await page.waitUntil(() => document.documentElement.classList.contains('kcms-dock-bottom'))
  await dev('0px', '320px')

  const bottom = await measure(page)

  expect(bottom.panel.bottom).toBe(800 - 320)
  expect(bottom.panel.top).toBeGreaterThan(48)

  await dev('448px', '0px')
  expect((await measure(page)).panel.right).toBe(side.window.width - 448)
})

test('a click on a field under the sheet scrolls it into the visible part of the page', async () => {
  const page = await open(390, 800)

  await page.evaluate(() => scrollTo(0, 0))
  await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>('h1')!

    title.style.marginTop = '1000px'
    scrollTo(0, 650)
  })
  await page.waitUntil(() => document.querySelector('h1')!.getBoundingClientRect().top > 380)
  await page.evaluate(() => document.querySelector<HTMLElement>('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 700 })))
  await page.waitUntil(() => {
    const box = document.querySelector('h1')!.getBoundingClientRect()

    return box.bottom <= document.querySelector('.kcms-editor')!.getBoundingClientRect().top && box.top >= 48
  })
})

test('a click already in the visible part leaves the page where it is, however tall the element', async () => {
  const page = await open(390, 800)

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('h1')!.style.height = '2500px'
    scrollTo(0, 500)
  })
  await page.waitUntil(() => scrollY === 500)
  await page.evaluate(() => document.querySelector<HTMLElement>('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 200 })))
  await Bun.sleep(200)
  expect(await page.evaluate(() => scrollY)).toBe(500)
})

test('the entry header stays on one line on a phone, its buttons reachable', async () => {
  const page = await open(390, 800)
  const field = '.kcms-editor input[type="text"]'

  await page.waitUntil(() => document.querySelector('.kcms-editor input[type="text"]') !== null)
  await page.click(field)
  await page.type('A title long enough that the header would wrap if it were allowed to')
  await page.waitUntil(() => document.querySelector('.kcms-entry-actions button') !== null)

  const head = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.kcms-entry-head')!
    const style = getComputedStyle(element)
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())

    return { position: style.position, height: element.getBoundingClientRect().height, buttons: buttons.map(box => [box.top, box.right]) }
  })

  expect(head.position).toBe('sticky')
  expect(head.height).toBeLessThan(72)
  expect(new Set(head.buttons.map(([top]) => top)).size).toBe(1)
  expect(Math.max(...head.buttons.map(([, right]) => right!))).toBeLessThanOrEqual(390)
})
