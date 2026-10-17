import type { TestPage, TestSite } from '../src/test'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { chromium } from 'playwright-core'
import { previewUrl } from '../src/server'
import { browserPath, testSite } from '../src/test'
import { chromeTree, killAll, removeFetcherDirs } from '../src/test/browser'
import { scratchDir } from './scratch'

// Without BUN_CHROME_PATH or a Chrome on the PATH, the Chromium playwright-core installed for the other browser tests.
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

let site: TestSite
let page: TestPage

// Only the source of a wait's function reaches the page, where this is not defined.
function elsewhere(): boolean {
  return location.pathname === '/elsewhere'
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('kay/test in a browser', () => {
  beforeAll(async () => {
    // The fixture's islands break on purpose, which the server would log.
    site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, onError: () => undefined })
    page = await site.open('/')
  }, 60_000)

  afterAll(async () => site?.close())

  it('opens a page with its islands hydrated, a click reaching their handlers', async () => {
    await page.click('button.player')
    await page.click('button.player')

    expect(await page.text('button.player')).toBe('Played 2')
    expect(await page.count('slot[data-component]')).toBeGreaterThan(0)
    expect(await page.text('p.missing')).toBeNull()
    expect(page.errors).toEqual([])
  })

  it('follows a link as a swap and goes back through history, the document kept', async () => {
    await page.evaluate((mark: string) => {
      (window as { kayMark?: string }).kayMark = mark
    }, 'kept')
    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })

    expect(await page.path()).toBe('/second')

    await page.back()

    expect(await page.text('h1')).toBe('Home')
    expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')

    await page.forward()

    expect(await page.text('h1')).toBe('Second')
  })

  it('fills a field as typing does, the form checked and posted as a user sends it', async () => {
    await page.goto('/second')
    await page.fill('input[name="title"]', 'ab')
    await page.click('form button')
    // The first submit holds the post until the checks load, then reports what they find.
    await page.waitUntil(() => document.querySelector('input')!.validationMessage !== '')

    expect(await page.evaluate(() => document.querySelector('input')!.validationMessage)).toBe('Too short')

    await page.fill('input[name="title"]', 'abcd')

    expect(await page.value('input[name="title"]')).toBe('abcd')

    await page.click('form button')
    await page.waitFor('p.done', { text: 'Added abcd' })
    await page.waitFor('form[aria-busy]', { gone: true })
    await page.fill('input[name="title"]', '')

    expect(await page.value('input[name="title"]')).toBe('')
  })

  it('solves an action\'s proof-of-work in a worker under the default csp, for a form the swap posts and an island\'s call alike', async () => {
    const costly = await site.open('/costly')

    await costly.fill('input[name="title"]', 'form')
    await costly.click('form button')
    await costly.waitFor('p.paid', { text: 'Paid form' })
    await costly.click('button.payer')
    await costly.waitFor('p.island-paid', { text: 'island' })

    expect(costly.errors).toEqual([])
  })

  it('sends a form again with the fresh challenge it is refused with, after an island\'s call or a failed post spent the page\'s', async () => {
    const costly = await site.open('/costly')

    await costly.click('button.payer')
    await costly.waitFor('p.island-paid', { text: 'island' })
    await costly.fill('input[name="title"]', 'after the island')
    await costly.click('form button')
    await costly.waitFor('p.paid', { text: 'Paid after the island' })
    await costly.fill('input[name="title"]', 'refused')
    await costly.click('form button')
    await costly.waitFor('p.refused', { text: '409' })
    await costly.fill('input[name="title"]', 'after a failure')
    await costly.click('form button')
    await costly.waitFor('p.paid', { text: 'Paid after a failure' })

    expect(costly.errors).toEqual([])
  })

  it('posts the solution of a workChallenge field in its place, for the action to check', async () => {
    const scoped = await site.open('/scoped')

    await scoped.fill('input[name="message"]', 'hello')
    await scoped.click('form button')
    await scoped.waitFor('p.sent', { text: 'Sent 5' })

    expect(scoped.errors).toEqual([])
  })

  it('collects the errors of the page, uncaught ones included', async () => {
    await page.goto('/fallback')
    await page.click('button.break')
    await page.waitFor('p.fallback', { text: 'Failed: Fragile broke' })
    await page.evaluate(() => void setTimeout(() => {
      throw new Error('Thrown later')
    }))
    await page.waitUntil(async () => new Promise(resolve => setTimeout(resolve, 50, true)))

    expect(page.errors.some(error => error.includes('Fragile broke'))).toBe(true)
    expect(page.errors.some(error => error.startsWith('Error: Thrown later'))).toBe(true)
  })

  it('fails a call once the page reports a problem kay hides in production, unless opened with strict: false', async () => {
    await expect(site.open('/mismatch')).rejects.toThrow('kay: the page reported a problem production would hide: island tests/fixtures/navigation/src/components/mismatch.kay did not match its server markup')

    const lenient = await site.open('/mismatch', { strict: false })

    await lenient.click('button.mismatch')
    expect(await lenient.text('button.mismatch')).toBe('Clicked 1')
    expect(lenient.errors).toEqual([expect.stringContaining('did not match its server markup')])
  }, 30_000)

  it('hydrates an island passing a slot to a component whose for-else tests that slot with an if', async () => {
    const page = await site.open('/empty-rows')

    await page.click('button.empty-bump')
    expect(await page.text('button.empty-bump')).toBe('Bumped 1')
    expect(await page.text('td.empty-cell .empty-note')).toBe('Nothing here')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('hydrates an island whose component reads a slot in an attribute, a ternary and an if with an alias, as well as inserting it', async () => {
    const page = await site.open('/slot-flag')

    await page.click('button.flag-bump')
    expect(await page.text('button.flag-bump')).toBe('Bumped 1')
    expect(await page.text('.slot-flag-label')).toBe('with')
    expect(await page.text('.slot-flag-ternary .flag-note')).toBe('Noted')
    expect(await page.text('.slot-flag-shown .flag-side .slot-badge')).toBe('Side')
    expect(await page.count('.flag-side')).toBe(1)
    expect(await page.count('.flag-note')).toBe(1)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('hydrates every island reading a value kept in localStorage on the markup the server rendered, then shows the value', async () => {
    const kept = await site.open('/kept')

    await kept.click('button.note')
    await kept.waitFor('p.note-shown', { text: 'Kept kept' })
    await kept.reload()

    await kept.waitFor('button.note', { text: 'Note kept' })
    expect(await kept.count('p.note-shown')).toBe(1)
    // One hydrating once visible, long after the value applied, claims the markup the server rendered too, then shows the value.
    await kept.evaluate(() => scrollTo(0, document.body.scrollHeight))
    await kept.waitFor('slot[data-hydrate] p.note-shown', { text: 'Kept kept' })
    await kept.click('slot[data-hydrate] button.forget')
    await kept.waitFor('button.note', { text: 'Note none' })
    expect(await kept.count('p.note-shown')).toBe(0)
    expect(kept.errors).toEqual([])
    kept.close()
  }, 30_000)

  it('opens each page as a new visitor, no cookie or storage of the last one kept', async () => {
    await page.goto('/state')
    await page.click('button.theme')
    await page.click('button.note')
    await page.goto('/alone')

    expect(await page.text('button.theme')).toBe('Theme dark')

    page.close()
    page = await site.open('/alone')

    expect(await page.text('button.theme')).toBe('Theme light')
    expect(await page.text('button.note')).toBe('Note none')
  })

  it('waits for an element to show up or go away, runs a function with its arguments, undefined ones included, and times out naming what it waited for', async () => {
    await page.goto('/')
    await page.evaluate(() => void setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { className: 'late' })), 200))
    await page.waitFor('p.late')
    await page.evaluate(() => void setTimeout(() => document.querySelector('p.late')!.remove(), 200))
    await page.waitFor('p.late', { gone: true })

    expect(await page.count('p.late')).toBe(0)
    expect(await page.evaluate((first: string, second?: string) => [first, second === undefined], 'a', undefined)).toEqual(['a', true])

    // A wait that times out names what it waited for.
    await expect(page.waitFor('p.nothing', { timeout: 100 })).rejects.toThrow('kay: timed out after 100ms waiting for p.nothing')
    await expect(page.waitFor('h1', { text: 'Nope', timeout: 100 })).rejects.toThrow('waiting for h1 with text "Nope"')

    // A condition that keeps throwing is named as never held, as one calling a helper of the test does.
    await expect(page.waitUntil(() => elsewhere(), { timeout: 100 })).rejects.toThrow(/waiting for the condition to hold, last throwing .*elsewhere is not defined/)
    await expect(page.waitUntil(() => false, { timeout: 100 })).rejects.toThrow(/to hold$/)
    // Thrown once, as by a page swap in flight, then only false: the error is over.
    await expect(page.waitUntil(() => {
      const counted = window as unknown as { polls?: number }

      counted.polls = (counted.polls ?? 0) + 1

      if (counted.polls === 1)
        throw new Error('Swapping')

      return false
    }, { timeout: 200 })).rejects.toThrow(/to hold$/)
  })

  it('answers the next call once a wait timed out on a try the page was still running, as on a slow machine', async () => {
    await expect(page.waitUntil(() => {
      const end = Date.now() + 300

      while (Date.now() < end);

      return false
    }, { timeout: 50 })).rejects.toThrow(/to hold$/)
    expect(await page.evaluate(() => 1)).toBe(1)
  })

  it('says why it opens no page, without a browser build or a browser', async () => {
    const plain = await testSite({ routes: 'tests/fixtures/navigation/src/routes' })

    await expect(plain.open('/')).rejects.toThrow('testSite({ browser: true })')
    await expect(site.open('/', { path: '/nowhere/chrome' })).rejects.toThrow('kay: no browser at /nowhere/chrome')
  })

  it('scrolls to what it clicks, centered past fixed bars, a click on an island hydrating once visible reaching it', async () => {
    await page.goto('/below')
    await page.click('button.player')

    expect(await page.text('button.player')).toBe('Played 1')

    await page.click('a.far')
    await page.waitUntil(() => location.hash === '#far')
    expect(page.errors).toEqual([])
    await expect(page.click('a.nowhere', { timeout: 100 })).rejects.toThrow('kay: timed out after 100ms waiting for a.nowhere')
  })

  it('replays a click on an island hydrating once visible after its onMount ran, again after a reload restoring the scroll to it', async () => {
    await page.goto('/below')
    await page.click('button.mounted')
    await page.waitFor('button.mounted', { text: 'Counted 11' })

    await page.reload()
    await page.click('button.mounted')
    await page.waitFor('button.mounted', { text: 'Counted 11' })
    expect(page.errors).toEqual([])
  })

  it('checks a page with axe-core, the whole of it or what a selector matches, again after a navigation', async () => {
    await page.goto('/contrast')

    const contrast = (await page.a11y()).find(violation => violation.id === 'color-contrast')

    expect(contrast?.impact).toBe('serious')
    expect(contrast?.nodes).toEqual([{ target: '.faint', html: '<button class="faint" style="color: #ccc; background: #fff">Faint</button>' }, { target: 'p', html: '<p class="same" style="color: #fff; background: #fff">Same</p>' }])
    expect(await page.a11y('button.plain')).toEqual([])

    await page.goto('/plain')
    await page.goto('/contrast')

    expect((await page.a11y('main')).map(violation => violation.id)).toEqual(['color-contrast'])
    await expect(page.a11y('.nowhere')).rejects.toThrow('kay: nothing matches .nowhere to check')
  })

  it('reports text the colour of its background as low contrast, but text clipped out of sight or over an image', async () => {
    await page.goto('/unreadable')

    expect((await page.a11y('main')).map(violation => [violation.id, violation.impact, violation.nodes.map(node => node.target)])).toEqual([['color-contrast', 'serious', ['.same']]])
    expect((await page.a11y('p.same')).map(violation => violation.id)).toEqual(['color-contrast'])
    expect(await page.a11y('p.shown')).toEqual([])
    expect(await page.a11y('span.hidden')).toEqual([])
    expect(await page.a11y('div.image')).toEqual([])
  })
})

// The problems the panel lists, but the accessibility check's.
async function logged(shown: TestPage): Promise<string[]> {
  return shown.evaluate(() => [...document.querySelector('kay-dev')?.shadowRoot!.querySelectorAll('.problem pre') ?? []].map(pre => pre.textContent).filter(problem => !problem.startsWith('a11y ')))
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('history after a reload', () => {
  let history: TestSite

  beforeAll(async () => {
    history = await testSite({ routes: 'tests/fixtures/history/src/routes', browser: { path } })
  }, 60_000)

  afterAll(async () => history?.close())

  it('goes back to the page a swap left, from a page without islands loaded afresh, as from one with them, an anchor on it staying put', async () => {
    const view = await history.open('/')

    await view.click('button.count')
    await view.click('a.still')
    await view.waitFor('h1', { text: 'Still' })
    // Nothing of kay's runs on it once loaded afresh: only a few bytes.
    await view.reload()

    expect(await view.count('script[src]')).toBe(0)

    await view.click('a.anchor')
    await view.back()

    expect(await view.path()).toBe('/still')
    expect(await view.text('h1')).toBe('Still')

    await view.back()
    await view.waitFor('h1', { text: 'Home' })

    expect(await view.path()).toBe('/')

    await view.forward()
    await view.waitFor('h1', { text: 'Still' })
    await view.click('a.home')
    await view.waitFor('h1', { text: 'Home' })
    await view.reload()
    await view.back()
    await view.waitFor('h1', { text: 'Still' })

    expect(view.errors).toEqual([])
  }, 60_000)

  it('leaves Back and Forward to kay\'s script across a swap to a page without islands, and an entry the app pushed to the app', async () => {
    const kept = () => (window as unknown as { kept?: boolean }).kept === true
    const view = await history.open('/')

    await view.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true
    })
    await view.click('a.still')
    await view.waitFor('h1', { text: 'Still' })
    await view.back()
    await view.waitFor('h1', { text: 'Home' })
    await view.forward()
    await view.waitFor('h1', { text: 'Still' })
    // A reload would come once the traversal is over.
    await Bun.sleep(300)

    expect(await view.evaluate(kept)).toBe(true)

    await view.reload()
    await view.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true
      window.history.pushState(null, '', '/elsewhere')
    })
    await view.back()
    await view.forward()
    await Bun.sleep(300)

    expect(await view.path()).toBe('/elsewhere')
    expect(await view.evaluate(kept)).toBe(true)
    expect(view.errors).toEqual([])
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('kay dev in a browser', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, dev: true, onError: () => undefined })
  }, 60_000)

  afterAll(async () => dev?.close())

  it('shows each problem kay recovers from on the page, a page swap leaving them behind', async () => {
    const shown = await dev.open('/mismatch', { strict: false })

    // The accessibility check lists its own problems once the page settles.
    await shown.waitUntil(() => [...document.querySelector('kay-dev')?.shadowRoot!.querySelectorAll('.problem pre') ?? []].some(pre => pre.textContent.startsWith('a11y ')))

    expect(await logged(shown)).toEqual([expect.stringMatching(/^island tests\/fixtures\/navigation\/src\/components\/mismatch\.kay did not match its server markup, rendering it again: /)])
    expect(shown.errors).toHaveLength(1)

    // A problem logged again is listed once, a warning counts, anything not kay's is left to the console.
    await shown.evaluate(() => {
      console.warn('[kay] the persisted signal note could not be kept')
      console.warn('[kay] the persisted signal note could not be kept')
      console.error('not kay')
    })
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.textContent.includes('the persisted signal'))

    expect((await logged(shown)).map(problem => problem.slice(0, 20))).toEqual(['island tests/fixture', 'the persisted signal'])

    // Dismissed, they stay so for the browser tab, a new one showing.
    await shown.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll<HTMLButtonElement>('button.tool')].find(button => button.textContent === 'Dismiss all')!.click())

    expect(await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.problem pre').length)).toBe(0)

    await shown.evaluate(() => console.error('[kay] no locale has the message "late"'))
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('.problem pre') !== null)

    expect(await shown.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.problem pre')].map(problem => problem.textContent))).toEqual(['no locale has the message "late"'])
    expect(await shown.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.bar > button:not([hidden])')].map(button => button.textContent))).toEqual(['kay', '1 problem'])

    await shown.click('a.home')
    await shown.waitFor('h1', { text: 'Home' })

    expect(await logged(shown)).toEqual([])

    // An error nothing caught shows too, with its stack.
    await shown.evaluate(() => {
      setTimeout(() => {
        throw new Error('thrown later')
      })
    })
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.textContent.includes('thrown later'))

    expect((await logged(shown))[0]).toStartWith('Error: thrown later\n    at ')

    // As do a rejection nothing handled and a source the policy blocked.
    await shown.evaluate(() => {
      const policy = document.createElement('meta')
      const image = document.createElement('img')

      policy.httpEquiv = 'Content-Security-Policy'
      policy.content = 'img-src \'self\''
      document.head.append(policy)
      image.src = 'https://blocked.example/x.png'
      document.body.append(image)
      void Promise.reject(new Error('rejected later'))
    })
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.problem pre').length >= 3)

    expect(await logged(shown)).toEqual([
      expect.stringMatching(/^Error: thrown later\n {4}at /),
      expect.stringMatching(/^Uncaught \(in promise\) Error: rejected later\n {4}at /),
      expect.stringMatching(/^blocked https:\/\/blocked\.example\/x\.png by img-src/),
    ])
  }, 60_000)

  it('sizes the page in the Performance tab with Chromium\'s own gzip, within a few percent of the same bytes gzipped here', async () => {
    const shown = await dev.open('/state', { strict: false })

    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-performance')!.click())
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-performance')!.textContent.includes('Dev sizes'))

    const [html, files] = await shown.evaluate(() => {
      const panel = document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-performance')!
      const names = [...panel.querySelectorAll('.weight > span:not(.bars):not(.v):not(.files):not(.rule)')]
      const html = names.find(name => name.textContent === 'HTML')!

      return [html.nextElementSibling!.nextElementSibling!.textContent, [...panel.querySelectorAll('.weight .files')].flatMap(note => note.textContent.split(', ').map(file => file.split(' ')))] as const
    })
    const bytes = (text: string) => {
      const [value, unit] = text.split(' ')

      return Number(value) * (unit === 'KB' ? 1024 : 1)
    }
    const near = (shown: number, here: number) => Math.abs(shown - here) <= Math.max(24, here * 0.05)

    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const [url, size, unit] = file
      const text = await (await dev.fetch(url!)).text()

      expect(near(bytes(`${size} ${unit}`), Bun.gzipSync(text).length)).toBe(true)
    }

    // The HTML is the document the browser holds, tool left out.
    const held = await shown.evaluate(() => {
      const copy = window.document.documentElement.cloneNode(true) as HTMLElement

      for (const host of copy.querySelectorAll('kay-dev'))
        host.remove()

      return `<!doctype html>${copy.outerHTML}`
    })

    expect(near(bytes(html), Bun.gzipSync(held).length)).toBe(true)
  }, 60_000)

  it('shows what axe-core finds on the rendered page in the problem panel', async () => {
    const shown = await dev.open('/contrast', { strict: false })

    // At once, as the dev server's own check starts: the two take turns.
    expect((await shown.a11y()).map(violation => violation.id)).toContain('color-contrast')

    await shown.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot!.textContent.includes('a11y color-contrast'))

    expect(await shown.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.problem pre')].map(pre => pre.textContent))).toContain('a11y color-contrast: Elements must meet minimum color contrast ratio thresholds\n  .faint\n  p\nhttps://dequeuniversity.com/rules/axe/4.14/color-contrast?application=axeAPI')
    // The dev tool is kay's, no part of the page a test checks.
    expect((await shown.a11y()).flatMap(violation => violation.nodes.map(node => node.target))).not.toContainEqual(expect.stringContaining('kay-dev'))
    expect(shown.errors).toEqual([])
  }, 60_000)

  it('keeps one drawer height whatever the tab, and its colours above 4.5:1 in both schemes', async () => {
    const shown = await dev.open('/', { strict: false })

    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.bar > button')!.click())
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.drawer')!.hidden === false)
    // The Env tab, whose panel is short and does not change: the Problems panel grows as axe-core and the dev server's checks report, at a time the test cannot know.
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-env')!.click())
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.panel:not([hidden])')!.textContent.includes('no public env'))

    const heights = async () => shown.evaluate(() => {
      const drawer = document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.drawer')!

      return { drawer: drawer.getBoundingClientRect().height, limit: Math.min(448, innerHeight * 0.6) }
    })

    const short = await heights()

    expect(short.drawer).toBeCloseTo(short.limit, 0)

    // Another tab, its panel a different length: the drawer does not move.
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-head')!.click())
    await shown.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.panel:not([hidden])')!.id === 'kay-dev-head')
    expect((await heights()).drawer).toBe(short.drawer)

    // The maximized drawer fills the window.
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.head .size')!.click())
    expect((await heights()).drawer).toBeGreaterThan((await heights()).limit)
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.head .size')!.click())

    // axe-core cannot resolve the drawer's backgrounds (it reports the contrast of each text as undetermined), so the pairs the drawer draws, hovered ones included, are measured here by the WCAG formula; the dark palette is applied by hand, as a browser reporting a dark scheme would.
    for (const scheme of ['light', 'dark']) {
      const low = await shown.evaluate((picked: string) => {
        const host = document.querySelector('kay-dev') as HTMLElement
        const dark = [...host.shadowRoot!.adoptedStyleSheets[0]!.cssRules].find(rule => rule instanceof CSSMediaRule) as CSSMediaRule

        host.removeAttribute('style')

        if (picked === 'dark') {
          const style = (dark.cssRules[0] as CSSStyleRule).style

          for (const name of style)
            host.style.setProperty(name, style.getPropertyValue(name))
        }

        const probe = document.createElement('i')

        host.shadowRoot!.querySelector('.ui')!.append(probe)

        // A token name, or a colour of them as the stylesheet mixes one.
        const rgba = (name: string) => {
          probe.style.color = name.includes('(') ? name : `var(--${name})`

          const colour = getComputedStyle(probe).color
          const [r, g, b, a] = colour.match(/[0-9.]+/g)!.map(Number)

          // A mixed colour computes as `color(srgb r g b / a)`, its channels from 0 to 1.
          return colour.startsWith('color(') ? [r! * 255, g! * 255, b! * 255, a ?? 1] : [r!, g!, b!, a ?? 1]
        }
        const over = (top: number[], under: number[]) => [0, 1, 2].map(at => top[at]! * (top[3] ?? 1) + under[at]! * (1 - (top[3] ?? 1)))
        const luminance = (colour: number[]) => {
          const [r, g, b] = colour.map((channel) => {
            const value = channel / 255

            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          }) as [number, number, number]

          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const ratio = (fg: string, ...layers: string[]) => {
          const background = layers.reduce((under, layer) => over(rgba(layer), under), [255, 255, 255])
          const [light, shade] = [luminance(over(rgba(fg), background)), luminance(background)].sort((a, b) => b - a)

          return (light! + 0.05) / (shade! + 0.05)
        }
        // The text colour, then the backgrounds under it, from the page down.
        const pairs: Record<string, string[]> = {
          'title': ['text', 'mantle'],
          'where': ['sub', 'mantle'],
          'icon': ['sub', 'mantle'],
          'icon:hover': ['text', 'surface'],
          'tab': ['sub', 'mantle'],
          'tab:hover': ['text', 'mantle', 'color-mix(in srgb, var(--surface) 60%, transparent)'],
          'tab selected': ['text', 'surface'],
          'tab count': ['sub', 'mantle'],
          'tab count selected': ['sub', 'surface', 'mantle'],
          'tab count error': ['error', 'mantle', 'surface', 'error-soft'],
          'tab count warn': ['warn', 'mantle', 'surface', 'warn-soft'],
          'dock pressed': ['accent-hi', 'mantle', 'accent-soft'],
          'bar': ['text', 'surface'],
          'bar pressed': ['accent-hi', 'surface', 'accent-soft'],
          'bar pill error': ['error', 'surface', 'error-soft'],
          'bar pill warn': ['warn', 'surface', 'warn-soft'],
          'pill': ['sub', 'surface', 'mantle'],
          'pill error': ['error', 'surface', 'error-soft'],
          'pill warn': ['warn', 'surface', 'warn-soft'],
          'pill ok': ['ok', 'surface', 'ok-soft'],
          'pill accent': ['accent-hi', 'surface', 'accent-soft'],
          'tool': ['text', 'surface'],
          'tool:hover': ['accent-hi', 'surface'],
          'tool pressed': ['accent-hi', 'surface', 'accent-soft'],
          'heading': ['sub', 'surface'],
          'note': ['sub', 'surface'],
          'link': ['accent', 'surface'],
          'chip': ['sub', 'surface'],
          'problem': ['text', 'surface', 'canvas'],
          'problem error icon': ['error', 'surface', 'canvas'],
          'problem warn icon': ['warn', 'surface', 'canvas'],
          'method': ['accent-hi', 'surface', 'accent-soft'],
          'request line': ['text', 'surface', 'canvas'],
          'serp title': ['accent', 'surface', 'canvas'],
          'serp description': ['sub', 'surface', 'canvas'],
          'meter over': ['warn', 'surface'],
          'issue error': ['error', 'surface'],
          'issue warn': ['warn', 'surface'],
          'issue warn hovered': ['warn', 'surface', 'accent-soft'],
          'issue error current': ['error', 'surface', 'accent-soft'],
          'vital': ['text', 'surface', 'canvas'],
          'vital tick': ['sub', 'surface', 'canvas'],
          'build': ['text', 'surface', 'accent-soft'],
          'route current': ['text', 'surface', 'accent-soft'],
          'route current path': ['accent', 'surface', 'accent-soft'],
          'locale chip': ['accent', 'surface'],
        }

        const found = Object.entries(pairs).map(([name, [fg, ...layers]]) => [name, ratio(fg!, ...layers)] as const).filter(([, value]) => value < 4.5).map(([name, value]) => `${picked} ${name} ${value.toFixed(2)}`)

        probe.remove()
        host.removeAttribute('style')

        return found
      }, scheme)

      expect(low).toEqual([])
    }

    expect(shown.errors).toEqual([])
  }, 60_000)

  it('scrolls no panel sideways, in the default window or a 400 px wide one, whatever the values are', async () => {
    const wide: string[] = []

    for (const width of [undefined, 400]) {
      const shown = await dev.open(`/long?${'query-without-a-break-'.repeat(8)}=1`, { strict: false, width })
      const ids = await shown.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('[role=tab]')].map(tab => tab.id))

      expect(await shown.evaluate(() => innerWidth)).toBe(width ?? 800)

      await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.bar > button')!.click())

      for (const id of ids) {
        await shown.evaluate((tab: string) => document.querySelector('kay-dev')!.shadowRoot!.getElementById(tab)!.click(), id)
        // Head, Env and Routes ask the server, and Images looks each format up after drawing its rows.
        await shown.waitUntil(() => {
          const panel = document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.panel:not([hidden])')!

          return panel.childElementCount > 0 && ![...panel.querySelectorAll('.chip')].some(chip => chip.textContent === 'format...')
        })
        await Bun.sleep(150)
        wide.push(...await shown.evaluate((label: string) => {
          const panel = document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.panel:not([hidden])')!
          const edge = panel.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(panel).paddingRight) + 1

          if (panel.scrollWidth <= panel.clientWidth)
            return []

          return [...panel.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > edge).slice(0, 3).map(element => `${label} ${element.tagName.toLowerCase()}.${element.className}`)
        }, `${width ?? 'default'} ${id}`))
      }

      // The head keeps its title clear of its buttons, dropping the words when it is too narrow for them.
      wide.push(...await shown.evaluate((label: string) => {
        const root = document.querySelector('kay-dev')!.shadowRoot!

        return root.querySelector('.title')!.getBoundingClientRect().right > root.querySelector('.dock')!.getBoundingClientRect().left ? [`${label} head`] : []
      }, String(width ?? 'default')))
      // Each dev page holds a live reload stream, and Chromium opens six connections to a host at most.
      shown.close()
    }

    expect(wide).toEqual([])
  }, 60_000)

  it('moves the drawer by its head, resizes it by an edge, docks it padding the page, lands the bar in a corner, and opens again as it was left', async () => {
    // Opening a page clears the origin's storage, so the layout starts as the default.
    const shown = await dev.open('/', { strict: false })

    // Pointer events at window coordinates, a drag from `from` to `to` on the element `selector` names in the tool.
    const drag = async (selector: string, from: [number, number], to: [number, number]) => shown.evaluate(([picked, [x, y], [toX, toY]]: [string, [number, number], [number, number]]) => {
      const element = document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>(picked)!
      const fire = (type: string, clientX: number, clientY: number) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, button: 0, clientX, clientY, pointerId: 1 }))

      fire('pointerdown', x, y)
      fire('pointermove', (x + toX) / 2, (y + toY) / 2)
      fire('pointermove', toX, toY)
      fire('pointerup', toX, toY)
      // As a browser does after a press and release on one element.
      element.click()
    }, [selector, from, to] as [string, [number, number], [number, number]])
    const rect = async (selector: string) => shown.evaluate((picked: string) => {
      const { left, top, width, height } = document.querySelector('kay-dev')!.shadowRoot!.querySelector(picked)!.getBoundingClientRect()

      const { clientWidth, clientHeight } = document.documentElement

      return { left, top, width, height, right: clientWidth - left - width, bottom: clientHeight - top - height }
    }, selector)

    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.mark')!.click())

    const start = await rect('.drawer')

    // Moved by its head 100 px right and up, then near the top edge, where it snaps 12 px from it.
    await drag('.where', [start.left + 300, start.top + 15], [start.left + 400, start.top - 85])
    expect(await rect('.drawer')).toMatchObject({ left: start.left + 100, top: start.top - 100, width: start.width })
    await drag('.where', [start.left + 400, start.top - 85], [start.left + 400, 35])
    expect((await rect('.drawer')).top).toBe(12)

    // The right edge widens it, the top left corner grows it up and left, the bottom right one shrinks it no smaller than 280 by 180.
    const moved = await rect('.drawer')

    await drag('.grip.e', [moved.left + moved.width - 2, moved.top + 100], [moved.left + moved.width + 48, moved.top + 100])
    expect((await rect('.drawer')).width).toBe(moved.width + 50)
    // Past the window, the right edge stops at it and the left one stays put.
    await drag('.grip.e', [moved.left + moved.width + 48, moved.top + 100], [moved.left + moved.width + 2000, moved.top + 100])
    expect(await rect('.drawer')).toMatchObject({ left: moved.left, right: 0 })
    await drag('.grip.se', [(await rect('.drawer')).left + (await rect('.drawer')).width - 2, moved.top + moved.height - 2], [0, 0])
    expect(await rect('.drawer')).toMatchObject({ left: moved.left, top: moved.top, width: 280, height: 180 })

    // A reload opens it where it was left, still open as the browser tab keeps it.
    await shown.reload()
    expect(await rect('.drawer')).toMatchObject({ left: moved.left, top: moved.top, width: 280, height: 180 })

    // Docked to the bottom, it spans the window, pads the page by its height and lifts the bar above it; its top edge resizes it.
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Dock to the bottom"]')!.click())

    const docked = await rect('.drawer')

    expect(docked).toMatchObject({ left: 0, right: 0, bottom: 0, height: 320 })
    expect(await shown.evaluate(() => getComputedStyle(document.documentElement).paddingBottom)).toBe('320px')
    expect((await rect('.bar')).bottom).toBe(332)
    await drag('.grip.n', [200, docked.top + 2], [200, docked.top - 38])
    expect((await rect('.drawer')).height).toBe(360)
    expect(await shown.evaluate(() => getComputedStyle(document.documentElement).paddingBottom)).toBe('360px')

    // Closed, the page has its own padding back.
    await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.mark')!.click())
    expect(await shown.evaluate(() => getComputedStyle(document.documentElement).paddingBottom)).toBe('0px')

    // The bar dragged to the top right lands 12 px from that corner, and the press opens nothing.
    const bar = await rect('.bar')

    await drag('.mark', [bar.left + 10, bar.top + 10], [bar.left + 2000, -500])
    expect(await rect('.bar')).toMatchObject({ top: 12, right: 12 })
    expect(await shown.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLElement>('.drawer')!.hidden)).toBe(true)
    shown.close()
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the dev patch in a browser', () => {
  it('applies an edit under navigation: false, leaving a class a script added and the scroll, and loads a page with a changed island fully', async () => {
    const dev = await testSite({ routes: 'tests/fixtures/patch/src/routes', browser: { path }, dev: true, navigation: false })

    try {
      const shown = await dev.open('/')

      // The page ships the live reload and kay dev's own scripts but no entry script, and the module comes from the server.
      expect(await shown.count('script[src]:not([src^="/_kay/dev/"])')).toBe(0)

      const outcome = await shown.evaluate(async () => {
        const module = '/_kay/dev/patch.js'
        const { patch } = await import(module) as { patch: (before: Document, after: Document) => boolean }
        const html = await (await fetch(location.href)).text()
        const parse = (text: string) => new DOMParser().parseFromString(text, 'text/html')

        document.querySelector('.bar')!.classList.add('in-view')
        scrollTo(0, 1500)

        const edited = patch(parse(html), parse(html.replace('Old', 'New').replace('<title>Patch', '<title>Next')))
        const island = patch(parse(html), parse(html.replace('</h1>', '</h1><slot data-component="x"></slot>')))

        return { edited, island, bar: document.querySelector('.bar')!.className, note: document.querySelector('.note')!.textContent, title: document.title, scroll: scrollY }
      })

      expect(outcome).toEqual({ edited: true, island: false, bar: 'bar in-view', note: 'New', title: 'Next', scroll: 1500 })
    }
    finally {
      await dev.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('edit mode in a browser', () => {
  it('shows a draft through the page swap, the island showing it kept alive, or where the schema refuses it', async () => {
    const secret = 'a-preview-secret-long-enough-for-kay-0123456789'
    const fixture = 'tests/fixtures/cms/src'
    const cms = await testSite({ routes: `${fixture}/routes`, content: `${fixture}/content.config.ts`, api: `${fixture}/api`, preview: { secret }, inlineStyles: false, browser: { path }, extensions: [{ name: 'editor', editor: `${fixture}/components/draft-editor.kay` }] })

    try {
      const editor = await cms.open(previewUrl('/marks/launch', { edit: true }))

      await editor.waitFor('h1', { text: 'Launch day' })
      await editor.click('button.count')
      await editor.click('button.draft')
      await editor.waitFor('h1', { text: 'Draft title' })

      expect(await editor.text('article h2')).toBe('Drafted')
      expect(await editor.text('button.count')).toBe('Clicked 1')
      expect(await editor.text('ul.edited')).toBe('news:launch')
      expect(await editor.path()).toBe('/marks/launch')

      await editor.click('button.refused')
      await editor.waitFor('p.issues', { text: '[{"collection":"news","slug":"launch","path":"title","message":"Expected property \'title\' to be string but found: 3"}]' })

      expect(await editor.text('h1')).toBe('Draft title')

      // A field typed in inside the editor keeps the focus and the caret across the swap each key shows, typed at its end or in its middle.
      const typed = async (key: string, title: string, caret: number) => {
        await editor.type(key)
        await editor.waitUntil(text => document.querySelector('h1')?.textContent === text, {}, title)

        expect(await editor.evaluate(() => [document.activeElement?.className, (document.activeElement as HTMLInputElement).selectionStart])).toEqual(['title', caret])
      }

      await editor.click('input.title')

      for (const [index, key] of [...'Typed'].entries())
        await typed(key, 'Typed'.slice(0, index + 1), index + 1)

      await editor.press('ArrowLeft')
      await editor.press('ArrowLeft')
      await typed('x', 'Typxed', 4)

      // Leaving the page while a draft renders keeps the page gone to.
      await editor.click('button.slow')
      await editor.click('a.away')
      await editor.waitFor('h1', { text: 'Next year' })
      await Bun.sleep(800)

      expect(await editor.text('h1')).toBe('Next year')
      expect(await editor.path()).toBe('/marks/roadmap')
      // The editor lived on through the navigation, given the entries of the page gone to.
      expect(await editor.text('button.count')).toBe('Clicked 1')
      expect(await editor.text('ul.edited')).toBe('news:roadmap')

      // Out of edit mode, the next page swapped in leaves the editor and its stylesheet out.
      const sheets = await editor.count('link[rel="stylesheet"]')

      // The page left from links back to the first, which no prefetch in edit mode holds.
      await editor.evaluate(async () => {
        await fetch('/_kay/preview?exit&path=/')
        document.querySelector('a.away')!.setAttribute('href', '/marks/launch')
      })
      await editor.click('a.away')
      await editor.waitFor('h1', { text: 'Launch day' })

      expect(await editor.count('ul.edited')).toBe(0)
      expect(await editor.count('link[rel="stylesheet"]')).toBe(sheets - 1)
      expect(editor.errors).toEqual([])
    }
    finally {
      await cms.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('publicEnv', () => {
  it('reads the variables the config declares public from the server\'s environment, on the server and in the browser', async () => {
    process.env.KAY_TEST_MAP_KEY = 'pk-123'
    process.env.KAY_TEST_SERVER_ONLY = 'hidden'

    const env = await testSite({ routes: 'tests/fixtures/env/src/routes', browser: { path }, publicEnv: t.Object({ KAY_TEST_MAP_KEY: t.String() }) })

    try {
      const shown = await env.open('/')

      expect(await shown.text('p.server')).toBe('pk-123')
      await shown.click('button')
      await shown.waitFor('p.browser')

      expect(await shown.text('p.browser')).toBe('pk-123')
      expect(shown.errors).toEqual([])
      expect(await (await env.fetch('/_kay/env.js')).text()).toBe('export default {"KAY_TEST_MAP_KEY":"pk-123"}\n')
    }
    finally {
      await env.close()
      delete process.env.KAY_TEST_MAP_KEY
      delete process.env.KAY_TEST_SERVER_ONLY
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a docs-like site in a browser', () => {
  it('opens a page of params with several islands, each in its own chunk, hydrated: Bun\'s router sends its files to /_kay/* rather than to the page', async () => {
    const site = await testSite({ routes: 'tests/fixtures/docs-like/src/routes', browser: { path } })

    try {
      const page = await site.open('/guide/start')

      for (const name of ['search', 'toc', 'example'])
        await page.click(`button.${name}`)

      expect([await page.text('button.search'), await page.text('button.toc'), await page.text('button.example')]).toEqual(['search 1', 'toc 1', 'example 1'])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('islands imported from the chunk their markup names', () => {
  it('hydrates the islands of a page loaded at a nested URL with a trailing slash or swapped to, the persisted one imported once', async () => {
    const site = await testSite({ routes: 'tests/fixtures/island-chunks/src/routes', trailingSlash: 'always', browser: { path } })

    try {
      const page = await site.open('/')

      await page.click('button.alpha')
      await page.click('button.kept')
      await page.click('a.deep')
      await page.waitFor('h1', { text: 'Deep' })
      await page.click('button.beta')

      expect(await page.path()).toBe('/docs/guide/page/')
      expect([await page.text('button.alpha'), await page.text('button.beta'), await page.text('button.kept')]).toEqual([null, 'Beta 1', 'Kept 1'])

      // Opened afresh at the nested URL, where a chunk resolved from the page's URL would be looked for under it.
      await page.goto('/docs/guide/page/')
      await page.click('button.beta')
      await page.click('button.kept')

      expect([await page.text('button.beta'), await page.text('button.kept')]).toEqual(['Beta 1', 'Kept 1'])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the browser\'s profile', () => {
  const LOCKED = 'kay-chrome-999999998-locked'
  const kindOf = (name: string) => {
    if (name.startsWith('kay-chrome-'))
      return 'kay'

    if (name.endsWith('.bun-chrome'))
      return 'bun'

    if (name.includes('url_fetcher'))
      return 'fetcher'

    return name.startsWith('org.chromium.') ? 'chrome' : name
  }
  const kinds = (names: string[]) => names.filter(name => name !== LOCKED).map(kindOf).sort()
  // The directory some Chrome makes of its own as it runs, Alpine's among them.
  const running = (kinds: string[]) => kinds.filter(kind => kind !== 'fetcher')
  // A temp directory of its own, short as Chrome's socket path must be, which macOS's own is not.
  const shortTemp = async () => mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'kt-'))
  const server = 'const server = Bun.serve({ port: 0, fetch: () => new Response(\'<p>Hi</p>\', { headers: { \'content-type\': \'text/html\' } }) })\n'

  it('keeps the browser for the next page a moment, then leaves nothing in the temp directory, at exit too, and removes what a killed run left as far as it can', async () => {
    const temp = await shortTemp()
    const script = join(await scratchDir('profile-'), 'run.ts')

    await mkdir(join(temp, 'kay-chrome-999999999-killed', 'profile'), { recursive: true })
    // A killed run's directory kay cannot remove, which leaves the browser to start.
    await Bun.write(join(temp, LOCKED, 'profile/f'), '')
    await chmod(join(temp, LOCKED, 'profile'), 0o500)
    await Bun.write(script, `import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { browse } from ${JSON.stringify(resolve('src/test/browser.ts'))}

${server}const open = async () => browse(\`http://localhost:\${server.port}/\`, { path: process.argv[2] })
const pages = [await open(), await open()]
const listed = () => console.log(JSON.stringify(readdirSync(tmpdir())))

listed()

for (const page of pages)
  page.close()

listed()
// The browser goes once it has been idle a moment, which the temp directory shows.
for (const limit = Date.now() + 10_000; readdirSync(tmpdir()).some(name => name !== ${JSON.stringify(LOCKED)}) && Date.now() < limit;)
  await Bun.sleep(20)

listed()
await open()
await server.stop()
process.exit(0)
`)

    try {
      const child = Bun.spawn([process.execPath, script, path!], { env: { ...process.env, TMPDIR: temp }, stdout: 'pipe', stderr: 'pipe' })
      const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const listings = out.trim().split('\n').map(line => JSON.parse(line) as string[])
      const [opened, closed] = listings.map(kinds)

      expect({ code, errors }).toEqual({ code: 0, errors: '' })
      // One owned directory, the killed run's gone; Bun's profile stays empty, Chrome running on kay's.
      expect(running(opened!)).toEqual(['bun', 'chrome', 'kay'])
      expect(running(closed!)).toEqual(['bun', 'chrome', 'kay'])
      // By name, so a directory left behind says what made it.
      expect(listings[2]?.filter(name => name !== LOCKED)).toEqual([])
      // The page opened last, left open, goes at exit.
      expect(kinds(await readdir(temp))).toEqual([])
    }
    finally {
      // Root removes it whatever its mode.
      if (existsSync(join(temp, LOCKED)))
        await chmod(join(temp, LOCKED, 'profile'), 0o700)

      await rm(temp, { recursive: true, force: true })
    }
  }, 60_000)

  it('closes the browser after the tests of bun test, which runs no exit handler, a page left open included', async () => {
    const temp = await shortTemp()
    const dir = await scratchDir('profile-test-')

    await Bun.write(join(dir, 'open.test.ts'), `import process from 'node:process'
import { expect, it } from 'bun:test'
import { browse } from ${JSON.stringify(resolve('src/test/browser.ts'))}

${server}
it('opens a page and never closes it', async () => {
  const page = await browse(\`http://localhost:\${server.port}/\`, { path: process.env.KAY_TEST_CHROME })

  expect(await page.text('p')).toBe('Hi')
}, 30_000)
`)

    try {
      const child = Bun.spawn([process.execPath, 'test', './open.test.ts'], { cwd: dir, env: { ...process.env, TMPDIR: temp, KAY_TEST_CHROME: path! }, stdout: 'pipe', stderr: 'pipe' })
      const [out, code] = await printed(child)

      expect({ code, out }).toMatchObject({ code: 0 })
      // By name, so a directory left behind says what made it.
      expect((await readdir(temp)).filter(name => name !== LOCKED)).toEqual([])
    }
    finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf((path === undefined && (process.env.CI ?? '') === '') || !existsSync('/proc'))('a page whose renderer crashes', () => {
  it('fails its pending and next calls at once, rather than at the test\'s timeout', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'kt-'))
    const script = join(await scratchDir('crash-'), 'run.ts')

    // In a process of its own, so the renderers it kills are its own browser's.
    await Bun.write(script, `import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { browse } from ${JSON.stringify(resolve('src/test/browser.ts'))}

const server = Bun.serve({ port: 0, fetch: () => new Response('<p>Hi</p>', { headers: { 'content-type': 'text/html' } }) })
const page = await browse(\`http://localhost:\${server.port}/\`, { path: process.argv[2], timeout: 20_000 })
const renderers = readdirSync('/proc').filter(name => readCmdline(name).includes(\`kay-chrome-\${process.pid}-\`) && readCmdline(name).includes('--type=renderer'))
const outcome = async (call: Promise<unknown>) => {
  const started = Date.now()

  try {
    await call
    return 'answered'
  }
  catch (error) {
    return \`\${(error as Error).message.includes('crashed') ? 'crashed' : (error as Error).message} in \${Date.now() - started < 5000 ? 'time' : 'too long'}\`
  }
}

function readCmdline(name: string): string {
  try {
    return readFileSync(\`/proc/\${name}/cmdline\`, 'utf8')
  }
  catch {
    return ''
  }
}

const pending = outcome(page.waitFor('p.never'))

for (const pid of renderers)
  process.kill(Number(pid), 'SIGKILL')

console.log(JSON.stringify({ renderers: renderers.length > 0, pending: await pending, next: [await outcome(page.goto('/')), await outcome(page.text('p')), await outcome(page.count('p')), await outcome(page.click('p'))] }))
page.close()
await server.stop()
process.exit(0)
`)

    try {
      const child = Bun.spawn([process.execPath, script, path!], { env: { ...process.env, TMPDIR: temp }, stdout: 'pipe', stderr: 'pipe' })
      const [out, code] = await printed(child)

      expect({ code, result: JSON.parse(out.slice(0, out.indexOf('\n'))) as unknown }).toEqual({ code: 0, result: { renderers: true, pending: 'crashed in time', next: Array.from({ length: 4 }).fill('crashed in time') } })
    }
    finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 60_000)
})

// What some Chrome leaves when killed, Alpine's among them, played by processes of this test's own.
describe.skipIf(!existsSync('/proc'))('a killed Chrome\'s leftovers', () => {
  const alive = (pid: number) => {
    try {
      return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
    }
    catch {
      return false
    }
  }

  it('kills the processes of a Chrome naming the profile it was given, what it started included, and no other process', async () => {
    const scratch = await scratchDir('tree-')
    const profile = join(scratch, 'profile')
    const chrome = Bun.spawn(['sh', '-c', 'sleep 30 & wait', 'sh', `--user-data-dir=${profile}`])
    const other = Bun.spawn(['sleep', '30'])

    try {
      let tree: number[] = []

      for (let attempt = 0; attempt < 50 && tree.length < 2; attempt++) {
        await Bun.sleep(20)
        tree = chromeTree(chrome.pid, profile)
      }

      expect(tree).toHaveLength(2)
      expect(chromeTree(other.pid, profile)).toEqual([])
      killAll(tree)
      expect(tree.map(alive)).toEqual([false, false])
      expect(alive(other.pid)).toBe(true)
    }
    finally {
      // A failed assertion leaves the tree running, sleep included.
      killAll(chromeTree(chrome.pid, profile))
      chrome.kill('SIGKILL')
      other.kill('SIGKILL')
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('removes the empty directories Chrome leaves in the temp directory once no Chrome runs on it, its crash handler left running', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'kt-'))
    const bin = await scratchDir('fake-chrome-')
    const fetcher = join(temp, 'org.chromium.Chromium.chromium_chrome_url_fetcher_.aB3dE9')
    const saved = process.env.TMPDIR

    await mkdir(fetcher)
    // Busybox's sleep, Alpine's, would run the applet its name says.
    await symlink(process.execPath, join(bin, 'chromium'))
    await symlink(process.execPath, join(bin, 'chrome_crashpad_handler'))

    const fake = (name: string) => Bun.spawn([join(bin, name), '-e', 'setTimeout(() => {}, 30_000)'], { env: { ...process.env, TMPDIR: temp } })
    const chrome = fake('chromium')
    const crashHandler = fake('chrome_crashpad_handler')

    // A process just spawned may not have run its command yet, its /proc entry still naming Bun, which would tell no Chrome runs.
    const started = (pid: number, name: string) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith(`${join(bin, name)}\0`)

    while (!started(chrome.pid, 'chromium') || !started(crashHandler.pid, 'chrome_crashpad_handler'))
      await Bun.sleep(5)

    process.env.TMPDIR = temp

    try {
      removeFetcherDirs()
      expect(existsSync(fetcher)).toBe(true)
      chrome.kill('SIGKILL')
      await chrome.exited
      removeFetcherDirs()
      expect(existsSync(fetcher)).toBe(false)
    }
    finally {
      // Bun sets undefined as the string "undefined".
      if (saved === undefined)
        delete process.env.TMPDIR
      else
        process.env.TMPDIR = saved

      chrome.kill('SIGKILL')
      crashHandler.kill('SIGKILL')
      await Promise.all([rm(temp, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })])
    }
  })
})

async function printed(child: { stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, exited: Promise<number> }): Promise<[string, number]> {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return [stdout + stderr, code]
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island setting the page title', () => {
  let titles: TestSite

  beforeAll(async () => {
    titles = await testSite({ routes: 'tests/fixtures/title/src/routes', seo: { name: 'Site', titleTemplate: '%s | Site' }, browser: { path } })
  }, 60_000)

  afterAll(async () => titles?.close())

  const title = async (view: TestPage) => view.evaluate(() => document.title)

  it('serves the title the island starts with, templated, and follows what it reads in the browser', async () => {
    expect((await titles.visit('/')).title()).toBe('Room | Site')

    const view = await titles.open('/')

    expect(await title(view)).toBe('Room | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Beta | Site')
    expect(view.errors).toEqual([])
  })

  it('shows the site title while the island\'s reads empty, and a raw one as it is', async () => {
    const view = await titles.open('/')

    await view.click('button.clear')

    expect(await title(view)).toBe('Site')

    const raw = await titles.open('/rawed')

    expect(await title(raw)).toBe('Raw room')

    await raw.click('button.rename')

    expect(await title(raw)).toBe('Raw beta')
  })

  it('leaves a page with no island title as it was served, the next page showing its own and going back showing the island\'s again', async () => {
    const view = await titles.open('/')

    await view.click('button.rename')
    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })

    expect(await title(view)).toBe('Other | Site')

    await view.click('a.home')
    await view.waitFor('h1', { text: 'Home' })

    expect(await title(view)).toBe('Room | Site')

    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })
    await view.back()
    await view.waitFor('h1', { text: 'Home' })

    expect(await title(view)).toBe('Room | Site')

    await view.goto('/untitled')

    expect(await title(view)).toBe('Site')
  })

  it('does not let the island of a page left set the title of the next', async () => {
    const view = await titles.open('/')
    const flip = async () => view.evaluate(() => (window as { kayFlip?: () => void }).kayFlip?.())

    await flip()

    expect(await title(view)).toBe('Stale | Site')

    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })
    await flip()

    expect(await title(view)).toBe('Other | Site')
  })

  it('takes the title of the island mounted last when a page has two', async () => {
    const view = await titles.open('/two')

    expect(await title(view)).toBe('Second | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => document.querySelectorAll<HTMLElement>('button.rename')[1]?.click())

    expect(await title(view)).toBe('Beta | Site')
  })

  it('keeps the title of the island last in the page when the first hydrates after it', async () => {
    const view = await titles.open('/reverse')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await view.waitUntil(() => (document.querySelector('[data-component]') as { _$k?: boolean } | null)?._$k === true)

    expect(await title(view)).toBe('Second | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => document.querySelectorAll<HTMLElement>('button.rename')[1]?.click())

    expect(await title(view)).toBe('Beta | Site')
  })

  const renameIn = async (view: TestPage, index: number) => view.evaluate((at: number) => document.querySelectorAll<HTMLElement>('button.rename')[at]?.click(), index)
  const allHydrated = async (view: TestPage) => view.waitUntil(() => [...document.querySelectorAll('[data-component]')].every(island => (island as { _$k?: boolean })._$k === true))

  it('keeps the served title while the island last in the page has not hydrated, then follows it', async () => {
    const view = await titles.open('/lazy')

    expect(await title(view)).toBe('Second | Site')

    await renameIn(view, 0)

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await allHydrated(view)

    expect(await title(view)).toBe('Second | Site')

    await renameIn(view, 1)

    expect(await title(view)).toBe('Beta | Site')
  })

  it('counts a titled island inside another as the island around it', async () => {
    const view = await titles.open('/nested')

    expect(await title(view)).toBe('Inner | Site')

    await renameIn(view, 0)

    expect(await title(view)).toBe('Inner | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await allHydrated(view)

    expect(await title(view)).toBe('Inner | Site')

    await renameIn(view, 1)

    expect(await title(view)).toBe('Beta | Site')
  })

  it('keeps the served title after a swap to a page whose last island is not hydrated', async () => {
    const view = await titles.open('/')

    await view.click('a.lazy')
    await view.waitFor('h1', { text: 'Lazy' })
    await view.waitUntil(() => (document.querySelector('[data-component]') as { _$k?: boolean } | null)?._$k === true)

    expect(await title(view)).toBe('Second | Site')
  })

  it('shows the title of the island last in the page after a swap to a page with two', async () => {
    const view = await titles.open('/')

    await view.click('a.two')
    await view.waitFor('h1', { text: 'Two' })
    await view.waitUntil(() => [...document.querySelectorAll('[data-component]')].every(island => (island as { _$k?: boolean })._$k === true))

    expect(await title(view)).toBe('Second | Site')
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island setting the page title under kay dev', () => {
  it('follows what it reads, templated, and gives way to the next page', async () => {
    const dev = await testSite({ routes: 'tests/fixtures/title/src/routes', seo: { name: 'Site', titleTemplate: '%s | Site' }, browser: { path }, dev: true })

    try {
      const view = await dev.open('/')

      await view.click('button.rename')

      expect(await view.evaluate(() => document.title)).toBe('Beta | Site')

      await view.click('a.other')
      await view.waitFor('h1', { text: 'Other' })

      expect(await view.evaluate(() => document.title)).toBe('Other | Site')
    }
    finally {
      await dev.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the dev tool on its own fixture', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ routes: 'tests/fixtures/dev-tool/src/routes', browser: { path }, dev: true, security: { csp: { 'style-src': ['\'self\''] } } })
  }, 60_000)

  afterAll(async () => dev?.close())

  it('draws, moves and docks under a policy refusing inline styles, styled through its adopted sheet and the CSSOM alone', async () => {
    const view = await dev.open('/')

    try {
      await view.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('.bar') !== null)

      // The policy holds: a style attribute the page adds is refused.
      const refused = await view.evaluate(async () => {
        const blocked = new Promise<string>(resolve => document.addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), { once: true }))
        const marked = document.createElement('div')

        marked.setAttribute('style', 'color: red')
        document.body.append(marked)

        return blocked
      })

      expect(refused).toStartWith('style-src')

      const drawn = await view.evaluate(async () => {
        const violations: string[] = []

        document.addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.sourceFile}`))

        const root = document.querySelector('kay-dev')!.shadowRoot!
        const drawer = root.querySelector<HTMLElement>('.drawer')!

        root.querySelector<HTMLButtonElement>('.bar > button')!.click()

        const head = root.querySelector<HTMLElement>('.head')!
        const from = head.getBoundingClientRect()
        const start = drawer.getBoundingClientRect()
        const at = { clientX: from.left + 40, clientY: from.top + 10, pointerId: 1, bubbles: true, composed: true }

        head.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0 }))
        head.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: at.clientX + 60, clientY: at.clientY - 80 }))
        head.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: at.clientX + 60, clientY: at.clientY - 80 }))

        const moved = drawer.getBoundingClientRect()
        const radius = getComputedStyle(drawer).borderTopLeftRadius

        root.querySelector<HTMLButtonElement>('.dock button[aria-label="Dock to the bottom"]')!.click()
        await new Promise(resolve => requestAnimationFrame(resolve))

        return {
          position: getComputedStyle(drawer).position,
          radius,
          moved: [Math.round(moved.left - start.left), Math.round(moved.top - start.top)],
          padded: getComputedStyle(document.documentElement).paddingBottom,
          problems: [...root.querySelectorAll('.problem pre')].map(pre => pre.textContent).filter(problem => !problem.startsWith('a11y ')),
          violations,
        }
      })

      expect(drawn.position).toBe('fixed')
      expect(drawn.radius).toBe('12px')
      expect(drawn.moved).toEqual([60, -80])
      expect(drawn.padded).not.toBe('0px')
      // The page's own refused attribute alone.
      expect(drawn.problems).toEqual(['blocked inline by style-src-attr'])
      expect(drawn.violations).toEqual([])
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('tells an SVG served under another name by the content type its fetch answered, not flagging it as oversized', async () => {
    const view = await dev.open('/')

    try {
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click())
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-images .image')?.textContent.includes('150x150') === true)

      const row = await view.evaluate(() => {
        const image = document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-images .image')!

        return [image.querySelector('.line')!.textContent, [...image.querySelectorAll('.chip')].map(chip => chip.textContent).find(chip => chip.includes('drawn')), [...image.querySelectorAll('.issue')].map(flag => flag.textContent)]
      })

      // Chromium draws an SVG without a size at 150x150, 88 times the pixels of 16x16.
      expect(row).toEqual(['/mark.png', '150x150 drawn 16x16', []])
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('lists what the page fetched with its kind and status, counting an error, leaving out the tool\'s own requests', async () => {
    const view = await dev.open('/')

    try {
      await view.evaluate(async () => {
        document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-network')!.click()
        await fetch('/nothing-here')
      })
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-network')?.textContent.includes('/nothing-here') === true)

      const listed = await view.evaluate(() => {
        const root = document.querySelector('kay-dev')!.shadowRoot!

        return {
          rows: [...root.querySelectorAll('#kay-dev-network .fetch')].map(row => `${row.querySelector('.name')!.textContent} ${row.querySelector('.line .pill')?.textContent ?? '-'} ${row.querySelector('.chip')!.textContent}`),
          count: root.querySelector('#kay-dev-tab-network .count')!.textContent,
        }
      })

      expect(listed.rows).toContain('/ 200 document')
      expect(listed.rows).toContain('/mark.png 200 image')
      expect(listed.rows).toContain('/nothing-here 404 fetch')
      expect(listed.rows.filter(row => row.includes('/_kay/dev/'))).toEqual([])
      expect(listed.count).toBe('1')
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('lists a page swap\'s own fetch under the page it brings', async () => {
    const view = await dev.open('/')

    try {
      // The island hydrated, the client script that swaps pages runs.
      await view.waitUntil(() => (document.querySelector('slot[data-component]') as { _$k?: boolean } | null)?._$k === true)
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-network')!.click())
      await view.click('a[href="/next"]')
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-network h3')?.textContent.startsWith('This page, /next') === true)

      const sections = await view.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-network .group')].map(group => [group.querySelector('h3')!.firstChild!.textContent, [...group.querySelectorAll('.fetch')].map(row => `${row.querySelector('.name')!.textContent} ${row.querySelector('.chip')!.textContent}`)]))

      expect(sections[0]![0]).toBe('This page, /next')
      expect(sections[0]![1]).toContain('/next page')
      expect(sections[1]![0]).toBe('Before, /')
      expect(sections[1]![1]).toContain('/ document')
    }
    finally {
      view.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a runtime chunk only some islands use', () => {
  it('is loaded with the island needing it, also on a page swapped to', async () => {
    const site = await testSite({ routes: 'tests/fixtures/runtime-chunks/src/routes', browser: { path } })

    try {
      const page = await site.open('/')

      await page.click('button.plain-one')
      expect(await page.text('button.plain-one')).toBe('one 1')

      await page.click('a.failing-link')
      await page.waitFor('h1', { text: 'Failing page' })
      await page.click('button.failing')
      await page.waitFor('button.failing', { text: 'Fail refused' })

      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
