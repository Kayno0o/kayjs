import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'
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
    await page.fill('input[name="title"]', 'ab')
    await page.click('form button')

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

  it('waits for an element to show up or go away, and runs a function with its arguments, undefined ones included', async () => {
    await page.goto('/')
    await page.evaluate(() => void setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { className: 'late' })), 200))
    await page.waitFor('p.late')
    await page.evaluate(() => void setTimeout(() => document.querySelector('p.late')!.remove(), 200))
    await page.waitFor('p.late', { gone: true })

    expect(await page.count('p.late')).toBe(0)
    expect(await page.evaluate((first: string, second?: string) => [first, second === undefined], 'a', undefined)).toEqual(['a', true])
  })

  it('times out naming what it waited for', async () => {
    await expect(page.waitFor('p.nothing', { timeout: 100 })).rejects.toThrow('kay: timed out after 100ms waiting for p.nothing')
    await expect(page.waitFor('h1', { text: 'Nope', timeout: 100 })).rejects.toThrow('waiting for h1 with text "Nope"')
  })

  it('names why a condition that keeps throwing never held, as one calling a helper of the test does', async () => {
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

  it('checks a page with axe-core, the whole of it or what a selector matches, again after a navigation', async () => {
    await page.goto('/contrast')

    const contrast = (await page.a11y()).find(violation => violation.id === 'color-contrast')

    expect(contrast?.impact).toBe('serious')
    expect(contrast?.nodes).toEqual([{ target: '.faint', html: '<button class="faint" style="color: #ccc; background: #fff">Faint</button>' }])
    expect(await page.a11y('button.plain')).toEqual([])

    await page.goto('/plain')
    await page.goto('/contrast')

    expect((await page.a11y('main')).map(violation => violation.id)).toEqual(['color-contrast'])
    await expect(page.a11y('.nowhere')).rejects.toThrow('kay: nothing matches .nowhere to check')
  })
})

// The problems the panel lists, but the accessibility check's.
async function logged(shown: TestPage): Promise<string[]> {
  return shown.evaluate(() => [...document.querySelector('kay-problems')?.shadowRoot!.querySelectorAll('pre') ?? []].map(pre => pre.textContent).filter(problem => !problem.startsWith('a11y ')))
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('kay dev in a browser', () => {
  it('shows each problem kay recovers from on the page, a page swap leaving them behind', async () => {
    const dev = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, dev: true, onError: () => undefined })

    try {
      const shown = await dev.open('/mismatch', { strict: false })

      // The accessibility check lists its own problems once the page settles.
      await shown.waitUntil(() => [...document.querySelector('kay-problems')?.shadowRoot!.querySelectorAll('pre') ?? []].some(pre => pre.textContent.startsWith('a11y ')))

      expect(await logged(shown)).toEqual([expect.stringMatching(/^island tests\/fixtures\/navigation\/src\/components\/mismatch\.kay did not match its server markup, rendering it again: /)])
      expect(shown.errors).toHaveLength(1)

      // A problem logged again is listed once, a warning counts, anything not kay's is left to the console.
      await shown.evaluate(() => {
        console.warn('[kay] the persisted signal note could not be kept')
        console.warn('[kay] the persisted signal note could not be kept')
        console.error('not kay')
      })
      await shown.waitUntil(() => document.querySelector('kay-problems')!.shadowRoot!.textContent.includes('the persisted signal'))

      expect((await logged(shown)).map(problem => problem.slice(0, 20))).toEqual(['island tests/fixture', 'the persisted signal'])

      await shown.evaluate(() => document.querySelector('kay-problems')!.shadowRoot!.querySelector('button')!.click())

      expect(await shown.count('kay-problems')).toBe(0)

      await shown.evaluate(() => console.error('[kay] no locale has the message "late"'))
      await shown.waitFor('kay-problems')

      expect(await shown.evaluate(() => document.querySelector('kay-problems')!.shadowRoot!.textContent)).toBe('1 kay problemDismissno locale has the message "late"')

      await shown.click('a.home')
      await shown.waitFor('h1', { text: 'Home' })

      expect(await logged(shown)).toEqual([])
    }
    finally {
      await dev.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('kay dev checking accessibility', () => {
  it('shows what axe-core finds on the rendered page in the problem panel', async () => {
    const dev = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, dev: true, onError: () => undefined })

    try {
      const shown = await dev.open('/contrast', { strict: false })

      // At once, as the dev server's own check starts: the two take turns.
      expect((await shown.a11y()).map(violation => violation.id)).toContain('color-contrast')

      await shown.waitUntil(() => document.querySelector('kay-problems')?.shadowRoot!.textContent.includes('a11y color-contrast'))

      expect(await shown.evaluate(() => [...document.querySelector('kay-problems')!.shadowRoot!.querySelectorAll('pre')].map(pre => pre.textContent))).toContain('a11y color-contrast: Elements must meet minimum color contrast ratio thresholds\n  .faint\nhttps://dequeuniversity.com/rules/axe/4.14/color-contrast?application=axeAPI')
      // The panel is kay's, no part of the page a test checks.
      expect((await shown.a11y()).flatMap(violation => violation.nodes.map(node => node.target))).not.toContainEqual(expect.stringContaining('kay-problems'))
      expect(shown.errors).toEqual([])
    }
    finally {
      await dev.close()
    }
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

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the browser\'s profile', () => {
  const kinds = (names: string[]) => names.map(name => name.startsWith('kay-chrome-') ? 'kay' : name.endsWith('.bun-chrome') ? 'bun' : name.startsWith('org.chromium.') ? 'chrome' : name).sort()

  it('leaves nothing in the temp directory once the last page closes or the process exits, and removes what a killed run left', async () => {
    // A temp directory of its own, short as Chrome's socket path must be.
    const temp = await mkdtemp(join(tmpdir(), 'kay-temp-'))
    const script = join(await scratchDir('profile-'), 'run.ts')

    await mkdir(join(temp, 'kay-chrome-999999999-killed', 'profile'), { recursive: true })
    await Bun.write(script, `import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { browse } from ${JSON.stringify(resolve('src/test/browser.ts'))}

const server = Bun.serve({ port: 0, fetch: () => new Response('<p>Hi</p>', { headers: { 'content-type': 'text/html' } }) })
const open = async () => browse(\`http://localhost:\${server.port}/\`, { path: process.argv[2] })
const pages = [await open(), await open()]

console.log(JSON.stringify(readdirSync(tmpdir())))

for (const page of pages)
  page.close()

console.log(JSON.stringify(readdirSync(tmpdir())))
await open()
await server.stop()
process.exit(0)
`)

    try {
      const child = Bun.spawn([process.execPath, script, path!], { env: { ...process.env, TMPDIR: temp }, stdout: 'pipe', stderr: 'pipe' })
      const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const [opened, closed] = out.trim().split('\n').map(line => kinds(JSON.parse(line) as string[]))

      expect({ code, errors }).toEqual({ code: 0, errors: '' })
      // One owned directory, the killed run's gone; Bun's profile stays empty, Chrome running on kay's.
      expect(opened).toEqual(['bun', 'chrome', 'kay'])
      expect(closed).toEqual([])
      // The page opened last, left open, goes at exit.
      expect(kinds(await readdir(temp))).toEqual([])
    }
    finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 60_000)
})
