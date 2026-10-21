import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true, dev: true })
const PATH = '/admin/page?path=/blog/hello'

afterAll(async () => {
  await built.close()
})

let shared: Awaited<ReturnType<typeof built.open>> | undefined

// Opens the page with the real dev tool in a window of the given size, its bar in the given corner, on one tab all the tests share so the file holds one.
async function open(width: number, height: number, corner: string) {
  const page = shared ??= await built.open(PATH, { strict: false })

  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.evaluate((layout) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('kay-dev-layout', JSON.stringify({ dock: 'float', corner: layout, max: false, bottom: 320, right: 448 }))
  }, corner)
  await page.reload()
  await page.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('.bar') != null && document.querySelector('.kcms-editor-open') !== null && document.documentElement.classList.contains('kcms-dock-side') !== document.documentElement.classList.contains('kcms-dock-bottom'))

  return page
}

// Whether two boxes share any area.
const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

async function measureBar(page: Awaited<ReturnType<typeof open>>) {
  return page.evaluate(() => ({
    editor: document.querySelector('.kcms-editor')!.getBoundingClientRect().toJSON() as DOMRect,
    bar: document.querySelector('kay-dev')!.shadowRoot!.querySelector('.bar')!.getBoundingClientRect().toJSON() as DOMRect,
  }))
}

// Whether the middle of each button of the editor's header is the button itself, not the dev tool's bar above it.
async function reachable(page: Awaited<ReturnType<typeof open>>): Promise<boolean[]> {
  return page.evaluate(() => [...document.querySelectorAll('.kcms-editor-head button')].map((button) => {
    const box = button.getBoundingClientRect()

    return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  }))
}

test('the dev tool bar at the bottom sits above the bottom sheet, not over it', async () => {
  const page = await open(390, 800, 'bottom-left')
  const { editor, bar } = await measureBar(page)

  expect(meets(bar, editor)).toBe(false)
  expect(bar.bottom).toBeLessThanOrEqual(editor.top)
})

test('the dev tool bar at the top right leaves the header of the editor at the side reachable', async () => {
  const page = await open(1280, 800, 'top-right')

  expect(await reachable(page)).toEqual([true, true, true, true, true])
})

test('the dev tool bar at the bottom right leaves the collapsed editor button reachable', async () => {
  const page = await open(390, 800, 'bottom-right')

  await page.click('.kcms-editor-head button[aria-label="Hide the editor"]')
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') === null)
  expect(await reachable(page)).toEqual([true])
})

// Opens the dev tool's floating drawer and measures it, the bar and the editor.
async function drawerBeside(page: Awaited<ReturnType<typeof open>>) {
  await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.bar > button')!.click())
  await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.drawer')!.hidden === false)

  return page.evaluate(() => {
    const shadow = document.querySelector('kay-dev')!.shadowRoot!
    const editor = document.querySelector('.kcms-editor')!.getBoundingClientRect()
    const drawer = shadow.querySelector('.drawer')!.getBoundingClientRect()
    const bar = shadow.querySelector('.bar')!.getBoundingClientRect()

    return { editor: editor.toJSON() as DOMRect, drawer: drawer.toJSON() as DOMRect, bar: bar.toJSON() as DOMRect }
  })
}

for (const [width, height, corner] of [[390, 800, 'bottom-left'], [800, 700, 'bottom-right'], [1280, 800, 'bottom-left'], [1280, 800, 'top-right']] as const) {
  test(`a floating dev tool drawer opened at ${width}px from the ${corner} corner leaves the editor and its own bar clear`, async () => {
    const page = await open(width, height, corner)
    const { editor, drawer, bar } = await drawerBeside(page)

    expect(meets(drawer, editor)).toBe(false)
    expect(meets(bar, editor)).toBe(false)
    expect(drawer.width).toBeGreaterThan(200)
    expect(drawer.height).toBeGreaterThan(120)
  })
}

test('a drawer docked at the right keeps the full window height beside the editor, and a drawer the user sized is left as sized', async () => {
  const page = await open(1280, 800, 'bottom-left')

  await page.evaluate(() => {
    localStorage.setItem('kay-dev-layout', JSON.stringify({ dock: 'right', corner: 'bottom-left', max: false, bottom: 320, right: 448 }))
    sessionStorage.clear()
  })
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null)
  const { drawer } = await drawerBeside(page)

  expect(drawer.top).toBe(0)
  expect(drawer.height).toBe(800)

  await page.evaluate(() => {
    localStorage.setItem('kay-dev-layout', JSON.stringify({ dock: 'float', corner: 'bottom-left', max: false, bottom: 320, right: 448, box: { left: 20, top: 10, width: 500, height: 780 } }))
    sessionStorage.clear()
  })
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null)

  const sized = await drawerBeside(page)

  expect(sized.drawer.height).toBe(780)
})
