import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

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
