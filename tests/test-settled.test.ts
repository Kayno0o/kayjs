import { afterAll, describe, expect, it } from 'bun:test'
import { persistedCookie, testSite } from '../src/test'
import { settledHtml } from '../src/test/page'

const site = await testSite({ routes: 'tests/fixtures/settled/src/routes', islands: false })

afterAll(async () => {
  await site.close()
})

describe('the settled view of a streamed page', () => {
  it('shows each await block as the visitor ends up seeing it', async () => {
    const page = await site.visit('/')

    expect(page.text()).not.toContain('42')
    expect(page.html).toContain('data-kay-await')
    expect(page.html).toMatch(/data-kay-await="\w[\dA-Za-z]*_\w+"/)
    expect(page.text()).toContain('Scoring')
    expect(page.settled.text()).toBe('Bill4242')
    expect(page.settled.html).not.toContain('Scoring')
    expect(page.settled.html).not.toContain('kay-await')
    expect(page.settled.html).not.toContain('$kayAwait')
    expect(page.settled.find('.score')[0]?.text).toBe('42')
    expect(page.settled.find('.pending')).toEqual([])
    expect(page.settled.find('.again')[0]?.text).toBe('42')
  })

  it('keeps the last part of a block that streams several, a block that settles to nothing and a catch', async () => {
    const page = await site.visit('/parts')

    expect(page.settled.find('p.word').map(found => found.text)).toEqual(['two'])
    expect(page.settled.find('.pending, .gone, .fail')).toEqual([])
    expect(page.settled.find('.caught')[0]?.text).toBe('Caught')
    expect(page.settled.html).not.toContain('kay-await')
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

describe('settledHtml on a stream that ended early', () => {
  const pending = (id: string) => `<!--kay-await:${id}--><p>pending ${id}</p><!--/kay-await:${id}-->`

  it('swaps the blocks that arrived whole and leaves out the template the stream ended inside', () => {
    const html = `<body>${pending('a')}${pending('b')}<template data-kay-await="a"><p>done a</p></template><template data-kay-await="b"><p>done b<template><i>kept</i>`

    expect(settledHtml(html)).toBe(`<body><p>done a</p>${pending('b')}`)
  })

  it('leaves the page as it came when the only template is cut short', () => {
    const html = `<body>${pending('a')}<template data-kay-await="a"><p>done`

    expect(settledHtml(html)).toBe(html)
  })

  it('reads a template of the page\'s own inside a block, whole, before the cut', () => {
    const html = `<body>${pending('a')}<template data-kay-await="a"><p>done</p><template><i>kept</i></template></template>`

    expect(settledHtml(html)).toBe('<body><p>done</p><template><i>kept</i></template>')
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

  it('encodes special characters so a cookie header carries them', () => {
    expect(persistedCookie('s', 'a b;c,d%+"\\é')).not.toMatch(/[ ;,]/)
  })

  it('refuses a name no persisted signal reads', () => {
    expect(() => persistedCookie('a b', 1)).toThrow(TypeError)
  })

  it('encodes values that are not strings', () => {
    expect(persistedCookie('n', 5)).toBe(`n=${encodeURIComponent('[5]')}`)
  })
})
