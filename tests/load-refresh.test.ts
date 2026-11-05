import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const routesDir = 'tests/fixtures/load-refresh/src/routes'
const site = await testSite({ routesDir, islands: false })
const based = await testSite({ routesDir, islands: false, base: '/shop', trailingSlash: 'always' })
const { counts, reset } = await import(join(import.meta.dir, 'fixtures/load-refresh/src/calls.ts')) as typeof import('./fixtures/load-refresh/src/calls')

const LOADS = 'x-kay-loads'

afterAll(async () => {
  await Promise.all([site.close(), based.close()])
})

beforeEach(reset)

async function asked(path: string, loads: string, target = site): Promise<{ html: string, response: Response }> {
  const response = await target.fetch(path, { headers: { [LOADS]: loads } })

  return { html: await response.text(), response }
}

function placeholders(html: string): string[] {
  return [...html.matchAll(/<([a-z0-9-]+) data-kay-kept><\/\1>/g)].map(match => match[1]!)
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

  it('runs the named load alone and leaves the elements reading the others to the page', async () => {
    const { html, response } = await asked('/', 'cart')

    expect(counts).toEqual({ cart: 1 })
    expect(placeholders(html)).toEqual(['h1', 'section'])
    expect(html).toContain('cart 1')
    expect(html).toContain('<li>apple</li>')
    expect(html).not.toContain('Hi Ada')
    expect(html).toContain('<title>Shop</title>')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain(LOADS)
    expect(response.headers.get('etag')).toBeNull()
  })

  it('runs several loads named together, in any order and with spaces', async () => {
    const { html } = await asked('/', ' wishlist , user')

    expect(counts).toEqual({ wishlist: 1, user: 1 })
    expect(placeholders(html)).toEqual(['section'])
    expect(html).toContain('Hi Ada 1')
  })

  it('takes a name derived from a load for the load it reads', async () => {
    const { html } = await asked('/', 'label')

    expect(counts).toEqual({ cart: 1 })
    expect(html).toContain('cart 1')
  })

  it('refreshes nothing for a name that matches no load, and shows the page whole again afterwards', async () => {
    const { html } = await asked('/', 'nothing')

    expect(counts).toEqual({})
    expect(placeholders(html)).toEqual(['main'])

    const plain = await (await site.fetch('/')).text()

    expect(plain).not.toContain('data-kay-kept')
    expect(counts).toEqual({ cart: 1, wishlist: 1, user: 1 })
  })

  it('runs the loads an element reads together with the one named', async () => {
    const { html } = await asked('/both', 'cart')

    expect(counts).toEqual({ cart: 1, wishlist: 1 })
    expect(placeholders(html)).toEqual([])
    expect(html).toContain('<p class="both">1 1</p>')
  })

  it('runs the loads a named load reads', async () => {
    const { html } = await asked('/needs', 'items')

    expect(counts).toEqual({ items: 1, cart: 1 })
    expect(placeholders(html)).toEqual(['p'])
    expect(html).toContain('<p class="items">1 of 1</p>')
  })

  it('runs a load read outside any element every time', async () => {
    const { html } = await asked('/root', 'cart')

    expect(counts).toEqual({ cart: 1, user: 1 })
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

    expect(counts.cart ?? 0).toBeLessThanOrEqual(hostile.length)
  })

  it('reads at most 32 names', async () => {
    const names = [...Array.from({ length: 40 }, (_, index) => `n${index}`), 'cart']
    const { html } = await asked('/', names.join(','))

    expect(counts).toEqual({})
    expect(placeholders(html)).toEqual(['main'])
  })

  it('does not look a name up on the prototype', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      reset()
      await asked('/', name)
      expect(counts).toEqual({})
    }
  })

  it('answers the same way under a base and with trailing slashes', async () => {
    const { html, response } = await asked('/shop/', 'wishlist', based)

    expect(response.status).toBe(200)
    expect(counts).toEqual({ wishlist: 1 })
    expect(placeholders(html)).toEqual(['h1', 'section'])
    expect(response.headers.get('cache-control')).toBe('private, no-store')

    const whole = await (await based.fetch('/shop/')).text()

    expect(whole).not.toContain('data-kay-kept')
  })
})
