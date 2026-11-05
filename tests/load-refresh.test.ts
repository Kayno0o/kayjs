import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { testSite } from '../src/test'

const routesDir = 'tests/fixtures/load-refresh/src/routes'
const site = await testSite({ routesDir, islands: false })
const based = await testSite({ routesDir, islands: false, base: '/shop', trailingSlash: 'always' })
const developing = await testSite({ routesDir, islands: false, dev: true })
const localized = await testSite({ routesDir, islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } })
const { counts, reset } = await import(join(import.meta.dir, 'fixtures/load-refresh/src/calls.ts')) as typeof import('./fixtures/load-refresh/src/calls')

const LOADS = 'x-kay-loads'

afterAll(async () => {
  await Promise.all([site.close(), based.close(), developing.close(), localized.close()])
})

beforeEach(reset)

async function asked(path: string, loads: string, target = site): Promise<{ html: string, response: Response }> {
  const response = await target.fetch(path, { headers: { [LOADS]: loads } })

  return { html: await response.text(), response }
}

// The loads a whole render of the path runs: a refresh runs the same ones, whatever it names.
async function wholeRun(path: string, target = site): Promise<Record<string, number>> {
  reset()
  await (await target.fetch(path)).text()

  const ran = { ...counts }

  reset()

  return ran
}

function placeholders(html: string): string[] {
  return [...html.matchAll(/<([a-z0-9-]+) data-kay-kept data-kay-u="[\w-]+"><\/\1>/g)].map(match => match[1]!)
}

describe('a refresh asking for some of the page loads', () => {
  it('renders the page whole and runs every load without the header', async () => {
    const response = await site.fetch('/')
    const html = await response.text()

    expect(counts).toEqual({ cart: 1, wishlist: 1, user: 1 })
    expect(html).not.toContain('data-kay-kept')
    expect(html).toContain('Hi Ada 1')
    expect(response.headers.get('vary') ?? '').not.toContain(LOADS)
  })

  it('sends the elements reading the named load and leaves the elements reading the others to the page', async () => {
    const { html, response } = await asked('/', 'cart')

    expect({ ...counts }).toEqual(await wholeRun('/'))
    expect(placeholders(html)).toEqual(['h1', 'section'])
    expect(html).toContain('cart 1')
    expect(html).toContain('<li>apple</li>')
    expect(html).not.toContain('Hi Ada')
    expect(html).toContain('<title>Shop</title>')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain(LOADS)
    expect(response.headers.get('etag')).toBeNull()
  })

  it('sends the elements of several loads named together, in any order and with spaces', async () => {
    const { html } = await asked('/', ' wishlist , user')

    expect({ ...counts }).toEqual(await wholeRun('/'))
    expect(placeholders(html)).toEqual(['section'])
    expect(html).toContain('Hi Ada 1')
  })

  it('takes a name derived from a load for the load it reads', async () => {
    const { html } = await asked('/', 'label')

    expect({ ...counts }).toEqual(await wholeRun('/'))
    expect(html).toContain('cart 1')
  })

  it('sends nothing new for a name that matches no load, and shows the page whole again afterwards', async () => {
    const { html } = await asked('/', 'nothing')

    expect({ ...counts }).toEqual(await wholeRun('/'))
    expect(placeholders(html)).toEqual(['main'])

    const plain = await (await site.fetch('/')).text()

    expect(plain).not.toContain('data-kay-kept')
    expect(counts).toEqual({ cart: 1, wishlist: 1, user: 1 })
  })

  it('sends an element reading the named load and another, and leaves the one reading neither', async () => {
    const { html } = await asked('/both', 'cart')

    expect({ ...counts }).toEqual(await wholeRun('/both'))
    expect(placeholders(html)).toEqual(['section'])
    expect(html).toMatch(/<p [^>]*class="both"[^>]*>1 1<\/p>/)
  })

  it('sends the elements of the loads a named load reads', async () => {
    const { html } = await asked('/needs', 'items')

    expect({ ...counts }).toEqual(await wholeRun('/needs'))
    expect(placeholders(html)).toEqual(['p'])
    expect(html).toMatch(/<p [^>]*class="items"[^>]*>1 of 1<\/p>/)
  })

  it('sends markup outside any element every time', async () => {
    const { html } = await asked('/root', 'cart')

    expect({ ...counts }).toEqual(await wholeRun('/root'))
    expect(html).toContain('Signed in')
    expect(placeholders(html)).toEqual([])
  })

  it('takes a header of hostile values for no names at all, or for names matching nothing', async () => {
    const hostile = ['', ' , ,', '<script>alert(1)</script>', 'a-b', 'x'.repeat(65), '__proto__ ', 'cart'.repeat(2000), ''.padEnd(3000, 'a,')]

    for (const value of hostile) {
      const response = await site.fetch('/', { headers: { [LOADS]: value } })
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).not.toContain('<script>alert')
    }

    // A value asking for no load shows the page whole, and the fence runs for every one.
    expect(counts.cart).toBe(hostile.length)
  })

  it('reads at most 32 names', async () => {
    const names = [...Array.from({ length: 40 }, (_, index) => `n${index}`), 'cart']
    const { html } = await asked('/', names.join(','))

    expect({ ...counts }).toEqual(await wholeRun('/'))
    expect(placeholders(html)).toEqual(['main'])
  })

  it('does not look a name up on the prototype', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      reset()
      await asked('/', name)
      expect({ ...counts }).toEqual(await wholeRun('/'))
    }
  })

  it('runs the loads a conditional and a loop show together with the one named, and keeps only what reads neither', async () => {
    const { html } = await asked('/cond', 'cart')

    expect({ ...counts }).toEqual(await wholeRun('/cond'))
    expect(placeholders(html)).toEqual(['p'])
    expect(html).toMatch(/<p [^>]*class="a"[^>]*>1<\/p>/)
    expect(html).toContain('>a 1</li>')
    expect(html).toContain('>b 1</li>')
  })

  it('sends the elements around the slot of a layout and never leaves the page to the browser', async () => {
    const { html } = await asked('/shell', 'cart')

    expect({ ...counts }).toEqual(await wholeRun('/shell'))
    expect(html).toContain('data-theme="dark"')
    expect(placeholders(html)).toEqual(['header'])

    reset()

    const other = await asked('/shell', 'user')

    expect({ ...counts }).toEqual(await wholeRun('/shell'))
    expect(other.html).toContain('data-theme="dark"')
    expect(placeholders(other.html)).toEqual(['main'])
  })

  it('maps a template constant back to the loads it reads, for the elements reading it', async () => {
    const { html } = await asked('/derived', 'wishlist')

    expect({ ...counts }).toEqual(await wholeRun('/derived'))
    expect(placeholders(html)).toEqual(['section'])
    expect(html).not.toContain('NaN')

    reset()

    const own = await asked('/derived', 'cart')

    expect(own.html).toMatch(/class="total"[^>]*>2</)
  })

  it('reads a load spread in the fence like any other', async () => {
    const { html, response } = await asked('/spread', 'wishlist')

    expect(response.status).toBe(200)
    expect({ ...counts }).toEqual(await wholeRun('/spread'))
    expect(html).toMatch(/class="all"[^>]*>2</)
  })

  it('runs a statement of the fence for every refresh, and sends what it changes', async () => {
    const { html } = await asked('/mutate', 'wishlist')

    expect({ ...counts }).toEqual(await wholeRun('/mutate'))
    expect(placeholders(html)).toEqual(['p'])

    const own = await asked('/mutate', 'cart')

    expect(own.html).toMatch(/class="totals"[^>]*>2</)
  })

  it('gives every element left to the page an id of its own, and the element it stands for the same one', async () => {
    const whole = await (await site.fetch('/')).text()
    const ids = [...whole.matchAll(/data-kay-u="([\w-]+)"/g)].map(match => match[1]!)

    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)

    const { html } = await asked('/', 'cart')

    for (const [, id] of html.matchAll(/data-kay-kept data-kay-u="([\w-]+)"/g))
      expect(ids).toContain(id!)
  })

  it('answers a refresh with the redirect or the error the whole page answers, for a guard in the fence', async () => {
    for (const [path, loads] of [['/guard-redirect', 'secret'], ['/guard-throw', 'secret'], ['/guard-load', 'stats'], ['/guard-owner', 'doc']] as const) {
      const whole = await site.fetch(path, { redirect: 'manual' })
      const scoped = await site.fetch(path, { redirect: 'manual', headers: { [LOADS]: loads } })

      expect(whole.status).not.toBe(200)
      expect(scoped.status).toBe(whole.status)
      expect(scoped.headers.get('location')).toBe(whole.headers.get('location'))
      expect(await scoped.text()).not.toContain('class="secret"')
    }
  })

  it('reads the defaults of a pattern and the names a statement changes', async () => {
    const { html } = await asked('/defaults', 'wishlist')

    expect({ ...counts }).toEqual(await wholeRun('/defaults'))
    expect(html).toMatch(/class="alias"[^>]*>2</)
    expect(html).toMatch(/class="name"[^>]*>x</)
  })

  it('answers a special page rendered for a refresh as a refresh, uncached', async () => {
    const response = await site.fetch('/nope', { headers: { [LOADS]: 'cart' } })

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain(LOADS)
  })

  it('answers a prerendered page asked for some of its loads', async () => {
    const response = await site.fetch('/static', { headers: { [LOADS]: 'cart' } })

    expect(response.status).toBe(200)
    expect(response.headers.get('vary')).toContain(LOADS)
  })

  it('warns once, in development, of a name no load answers to', async () => {
    const logged: string[] = []
    const previous = logSink()

    setLogSink((_level, message) => void logged.push(message))

    try {
      await asked('/', 'nothing', developing)
      await asked('/', 'nothing', developing)
      await asked('/', 'cart', developing)
    }
    finally {
      setLogSink(previous)
    }

    expect(logged.filter(message => message.includes('`nothing`'))).toHaveLength(1)
    expect(logged.some(message => message.includes('`cart`'))).toBe(false)
  })

  it('sends what a statement ties to the named load, a call changing another value included', async () => {
    const x = await asked('/tie', 'x')

    expect(placeholders(x.html)).toEqual(['p'])
    expect(x.html).toMatch(/class="len"[^>]*>1</)

    const y = await asked('/tie', 'y')

    expect(placeholders(y.html)).toEqual(['p', 'p'])
  })

  it('does not render an element left to the page, so its template error shows on a whole render only', async () => {
    const whole = await site.fetch('/broken-unit')
    const scoped = await asked('/broken-unit', 'cart')

    expect(whole.status).toBe(500)
    expect(scoped.response.status).toBe(200)
    expect(placeholders(scoped.html)).toEqual(['p'])
  })

  it('answers a prefixed locale the same way, keeping its lang and placeholders', async () => {
    const { html, response } = await asked('/en', 'cart', localized)

    expect(response.status).toBe(200)
    expect(html).toContain('lang="en"')
    expect(placeholders(html)).toEqual(['h1', 'section'])
    expect(response.headers.get('vary')).toContain(LOADS)

    const other = await asked('/', 'cart', localized)

    expect(other.html).toContain('lang="fr"')
    expect(placeholders(other.html)).toEqual(['h1', 'section'])
  })

  it('answers a refresh whose names are all in the header the same whatever their order', async () => {
    const first = await asked('/', 'cart,wishlist')
    const second = await asked('/', 'wishlist,cart')

    expect(placeholders(first.html)).toEqual(placeholders(second.html))
  })

  it('answers the same way under a base and with trailing slashes', async () => {
    const { html, response } = await asked('/shop/', 'wishlist', based)

    expect(response.status).toBe(200)
    expect({ ...counts }).toEqual(await wholeRun('/shop/', based))
    expect(placeholders(html)).toEqual(['h1', 'section'])
    expect(response.headers.get('cache-control')).toBe('private, no-store')

    const whole = await (await based.fetch('/shop/')).text()

    expect(whole).not.toContain('data-kay-kept')
  })
})
