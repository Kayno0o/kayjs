import { afterAll, describe, expect, it } from 'bun:test'
import { persistedCookie, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/settled/src/routes', islands: false })

afterAll(async () => {
  await site.close()
})

describe('the settled view of a streamed page', () => {
  it('shows each await block as the visitor ends up seeing it', async () => {
    const page = await site.visit('/')

    expect(page.text()).not.toContain('42')
    expect(page.html).toContain('data-kay-await')
    expect(page.text()).toContain('Scoring')
    expect(page.settled.text()).toBe('Bill42')
    expect(page.settled.html).not.toContain('Scoring')
    expect(page.settled.html).not.toContain('kay-await')
    expect(page.settled.html).not.toContain('$kayAwait')
    expect(page.settled.find('.score')[0]?.text).toBe('42')
    expect(page.settled.find('.pending')).toEqual([])
  })

  it('leaves a template of the page itself in place', async () => {
    const page = await site.visit('/')

    expect(page.settled.html).toContain('<template>')
    expect(page.settled.html).toContain('Kept')
  })

  it('is the page itself when nothing streams', async () => {
    const page = await site.visit('/plain')

    expect(page.settled.html).toBe(page.html)
  })
})

describe('persistedCookie', () => {
  it('sets a persisted value the first render reads', async () => {
    const light = await site.as(persistedCookie('scheme', 'light')).visit('/theme')

    expect(light.find('main')[0]?.attributes['data-theme']).toBe('light')
    expect((await site.visit('/theme')).find('main')[0]?.attributes['data-theme']).toBe('system')
  })

  it('stacks with other cookies by name', async () => {
    const both = site.as('a=1').as(persistedCookie('scheme', 'dark'))

    expect((await both.visit('/theme')).find('p.scheme')[0]?.text).toBe('dark')
  })

  it('encodes values that are not strings', () => {
    expect(persistedCookie('n', 5)).toBe(`n=${encodeURIComponent('[5]')}`)
  })
})
