import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true, dev: true })
const PATH = '/admin/page?path=/blog/hello'

afterAll(async () => {
  await built.close()
})

// Opens the page with the real dev tool in a window of the given size, its bar in the given corner.
async function open(width: number, height: number, corner: string) {
  const page = await built.open(PATH, { strict: false })

  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.evaluate((layout) => {
    localStorage.clear()
    localStorage.setItem('kay-dev-layout', JSON.stringify({ dock: 'float', corner: layout, max: false, bottom: 320, right: 448 }))
  }, corner)
  await page.reload()
  await page.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('.bar') != null && document.querySelector('.kcms-editor-open') !== null && document.documentElement.classList.contains('kcms-dock-side') !== document.documentElement.classList.contains('kcms-dock-bottom'))

  return page
}

// Whether the middle of each button of the editor's header is the button itself, not the dev tool's bar above it.
async function reachable(page: Awaited<ReturnType<typeof open>>): Promise<boolean[]> {
  return page.evaluate(() => [...document.querySelectorAll('.kcms-editor-head button')].map((button) => {
    const box = button.getBoundingClientRect()

    return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  }))
}

test('the dev tool bar at the bottom leaves the end of the bottom sheet reachable', async () => {
  const page = await open(390, 800, 'bottom-left')

  await page.waitUntil(() => document.querySelector('.kcms-entry-actions') !== null)

  const covered = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.kcms-editor-body')!
    const bar = document.querySelector('kay-dev')!.shadowRoot!.querySelector('.bar')!.getBoundingClientRect()

    body.scrollTop = body.scrollHeight

    const last = body.lastElementChild!.getBoundingClientRect()

    return last.bottom - bar.top
  })

  expect(covered).toBeLessThanOrEqual(0)
})

test('the dev tool bar at the top right leaves the header of the editor at the side reachable', async () => {
  const page = await open(1280, 800, 'top-right')

  expect(await reachable(page)).toEqual([true, true, true])
})

test('the dev tool bar at the bottom right leaves the collapsed editor button reachable', async () => {
  const page = await open(390, 800, 'bottom-right')

  await page.click('.kcms-editor-head button[aria-label="Hide the editor"]')
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') === null)
  expect(await reachable(page)).toEqual([true])
})
