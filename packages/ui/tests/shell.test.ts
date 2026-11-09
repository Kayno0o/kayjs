import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const FIXTURE = `${import.meta.dir}/fixture`
const path = browserPath()

describe('the ui extension', () => {
  it('mounts one Toaster and one TooltipHost on a page that renders neither', async () => {
    const site = await testSite({ root: FIXTURE, extensions: [ui()], islands: false })

    try {
      const html = (await site.visit('/shell')).html

      expect(html.match(/class="kui-toaster /g)).toHaveLength(1)
      expect(html.match(/id="kui-tooltip"/g)).toHaveLength(1)
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the ui extension in a browser', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: FIXTURE, extensions: [ui()], browser: { path } })
  }, 120_000)

  afterAll(async () => site.close())

  it('shows a toast and a tooltip with no host and no stylesheet written in the page', async () => {
    const page = await site.open('/shell')

    // The theme's tokens and the rules of the classes the page draws, from the extension's stylesheet alone.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).not.toBe('')
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.kui-icon-btn')!).display)).toBe('inline-flex')

    await page.click('#saved')
    await page.waitFor('.kui-toast')
    expect(await page.text('.kui-toast [data-part=message]')).toBe('Saved')
    expect(await page.count('.kui-toaster')).toBe(1)

    await page.hover('#help')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    expect(await page.text('#kui-tooltip')).toBe('Help')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows a hint or a non-control\'s tooltip on a tap, hides it on a second tap or a tap elsewhere, and leaves a control\'s alone', async () => {
    const page = await site.open('/shell')
    const open = async () => page.evaluate(() => document.querySelector('#kui-tooltip')!.matches(':popover-open'))

    await page.tap('#hinted')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    expect(await page.text('#kui-tooltip')).toBe('Deals double damage')

    await page.tap('#hinted')
    await page.waitUntil(() => !document.querySelector('#kui-tooltip')!.matches(':popover-open'))

    await page.tap('#noted')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    expect(await page.text('#kui-tooltip')).toBe('Worn on the head')

    await page.tap('h1')
    await page.waitUntil(() => !document.querySelector('#kui-tooltip')!.matches(':popover-open'))

    // A tap on a control does what it asks; its tooltip stays for the mouse and the keyboard, past the show delay too.
    await page.tap('#help')
    await Bun.sleep(300)
    expect(await open()).toBe(false)

    // A mouse press still hides what the hover showed.
    await page.hover('#hinted')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    await page.click('#hinted')
    await page.waitUntil(() => !document.querySelector('#kui-tooltip')!.matches(':popover-open'))
    expect(page.errors).toEqual([])
  }, 60_000)

  it('runs a toast\'s action from its button and goes once it resolves', async () => {
    const page = await site.open('/shell')

    await page.click('#acted')
    await page.waitFor('.kui-toast [data-part=action]')
    expect(await page.text('.kui-toast [data-part=action]')).toContain('Rebase')
    await page.click('.kui-toast [data-part=action]')
    await page.waitUntil(() => document.body.dataset.rebased === 'yes')
    await page.waitUntil(() => document.querySelector('.kui-toast') === null)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('keeps a page that mounts its own Toaster showing each toast once', async () => {
    const page = await site.open('/toast-a')

    await page.click('#saved')
    await page.waitFor('.kui-toast')
    expect(await page.count('.kui-toast')).toBe(1)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('stacks toasts at the Toaster\'s position, shows at most its limit, draws a description and a link action, and settles a promise', async () => {
    const page = await site.open('/toast-rich')

    // Counts the toasts after every change to the page, so one drawn for a moment by the extension's own Toaster before the app's took over is caught, not only the count when the test looks.
    await page.evaluate(() => {
      const seen = { most: 0 }

      ;(window as { toastsSeen?: { most: number } }).toastsSeen = seen
      new MutationObserver(() => {
        seen.most = Math.max(seen.most, document.querySelectorAll('.kui-toast').length)
      }).observe(document.body, { childList: true, subtree: true })
    })
    await page.click('#stack')
    await page.waitFor('.kui-toast')
    expect(await page.count('.kui-toast')).toBe(2)
    expect(await page.evaluate(() => (window as { toastsSeen?: { most: number } }).toastsSeen?.most)).toBe(2)
    expect(await page.text('.kui-toast [data-part=message]')).toBe('Two')
    expect(await page.evaluate(() => document.querySelector('.kui-toaster')!.getAttribute('data-position'))).toBe('top-center')
    expect(await page.evaluate(() => document.querySelector('.kui-toast a[data-part=action]')?.getAttribute('href'))).toBe('/shell')
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.kui-toaster')!).top)).not.toBe('auto')

    await page.click('.kui-toast [data-part=dismiss]')
    await page.waitUntil(() => document.querySelectorAll('.kui-toast [data-part=description]').length === 1)

    await page.click('#later')
    await page.waitUntil(() => document.querySelector('.kui-toast [data-loading]') !== null)
    await page.waitUntil(() => [...document.querySelectorAll('.kui-toast [data-part=message]')].some(item => item.textContent === 'Done ok'))
    expect(page.errors).toEqual([])
  }, 60_000)

  it('runs a link action, goes to its page and closes its toast, reading the description in the alert region', async () => {
    const page = await site.open('/toast-rich')

    await page.click('#linked')
    await page.waitFor('.kui-toast a[data-part=action]')
    expect(await page.text('[role=alert]')).toContain('See it')
    await page.click('.kui-toast a[data-part=action]')
    await page.waitUntil(() => location.pathname === '/shell')
    await page.waitUntil(() => document.querySelector('.kui-toast') === null)
    expect(page.errors).toEqual([])
  }, 60_000)

  // Records the path of each page swapped in, so a link that was not followed is told from one not yet swapped by the one clicked after it.
  const watchSwaps = async (page: Awaited<ReturnType<typeof site.open>>) => page.evaluate(() => {
    const seen: string[] = []

    ;(window as { swapped?: string[] }).swapped = seen
    document.addEventListener('kay:navigate', event => seen.push(new URL((event as CustomEvent<{ url: string }>).detail.url).pathname))
  })
  const swaps = async (page: Awaited<ReturnType<typeof site.open>>) => page.evaluate(() => (window as { swapped?: string[] }).swapped)

  it('runs the onClick of a Button and an IconButton drawn as links before they navigate, and stays on the page when the handler prevents the default', async () => {
    const page = await site.open('/toast-rich')

    await watchSwaps(page)
    await page.click('#held')
    await page.waitUntil(() => document.body.dataset.clicked === 'held')
    await page.click('#icon')
    await page.waitUntil(() => document.body.dataset.clicked === 'icon')
    await page.click('#go')
    await page.waitUntil(() => location.pathname === '/shell')
    expect(await swaps(page)).toEqual(['/shell'])
    expect(page.errors).toEqual([])
  }, 60_000)

  it('runs a link action and closes its toast without a page swap when another listener prevents the click', async () => {
    const page = await site.open('/toast-rich')

    await watchSwaps(page)
    await page.evaluate(() => document.addEventListener('click', (event) => {
      if ((event.target as Element).closest('.kui-toast a[data-part=action]'))
        event.preventDefault()
    }))
    await page.click('#linked')
    await page.waitFor('.kui-toast a[data-part=action]')
    await page.click('.kui-toast a[data-part=action]')
    await page.waitUntil(() => document.body.dataset.ran === 'yes' && document.querySelector('.kui-toast') === null)
    await page.click('#go')
    await page.waitUntil(() => location.pathname === '/shell')
    expect(await swaps(page)).toEqual(['/shell'])
    expect(page.errors).toEqual([])
  }, 60_000)

  it('keeps a link action\'s toast on a ctrl-click', async () => {
    const page = await site.open('/toast-rich')

    await page.click('#linked')
    await page.waitFor('.kui-toast a[data-part=action]')
    await page.evaluate(() => {
      const link = document.querySelector<HTMLAnchorElement>('.kui-toast a[data-part=action]')!

      link.addEventListener('click', event => event.preventDefault(), { once: true })
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await page.count('.kui-toast')).toBe(1)
    expect(await page.evaluate(() => location.pathname)).toBe('/toast-rich')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('replaces the drawing of a toast with the Toaster\'s toast block, whose dismiss closes it', async () => {
    const page = await site.open('/toast-block')

    await page.click('#saved')
    await page.waitFor('#custom')
    expect(await page.text('#custom')).toBe('Saved')
    expect(await page.count('.kui-toast [data-part=message]')).toBe(0)
    await page.click('#custom-close')
    await page.waitUntil(() => document.querySelector('.kui-toast') === null)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('lets a utility passed through class beat the component\'s own rule beside the app\'s stylesheet', async () => {
    const page = await site.open('/shell-class')
    const display = async (id: string) => page.evaluate((selector: string) => getComputedStyle(document.querySelector(selector)!).display, id as never)

    expect(await display('#plain')).toBe('inline-flex')
    expect(await display('#utility')).toBe('block')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('lets the app\'s own theme import and tokens win over the extension\'s', async () => {
    const page = await site.open('/skin')

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).toBe('#123456')
  }, 60_000)

  it('restyles a Button from the app\'s own accent', async () => {
    const page = await site.open('/skin')

    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#plain')!).backgroundColor)).toBe('rgb(18, 52, 86)')
  }, 60_000)
})
