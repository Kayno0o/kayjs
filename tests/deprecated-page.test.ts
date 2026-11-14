import { describe, expect, it } from 'bun:test'

import { compileKay } from '../src/compiler'

function fixed(source: string, code: string): { found: number, text: string } {
  const diagnostics = compileKay(source, 'x.kay', { check: true }).diagnostics.filter(one => one.code === code)
  const edits = diagnostics.flatMap(one => one.fixes?.find(fix => fix.safe)?.edits ?? [])
  const unique = [...new Map(edits.map(edit => [`${edit.start}:${edit.end}`, edit])).values()]

  return { found: diagnostics.length, text: unique.toSorted((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source) }
}

const page = (settings: string) => `--- server\nexport const page = ${settings}\n---\np Hi\n`

describe('deprecated-page-seo', () => {
  it('moves the settings into one seo group, each diagnostic carrying the same fix', () => {
    expect(fixed(page('{ noindex: true }'), 'deprecated-page-seo')).toEqual({ found: 1, text: page('{ seo: { noindex: true } }') })
    expect(fixed(page('{ prerender: true, noindex: true, sitemap: false }'), 'deprecated-page-seo')).toEqual({ found: 2, text: page('{ prerender: true, seo: { noindex: true, sitemap: false } }') })
  })

  it('keeps the object whole with three or more inline settings, whatever their order', () => {
    expect(fixed(page('{ noindex: true, search: false, sitemap: false }'), 'deprecated-page-seo').text).toBe(page('{ seo: { noindex: true, search: false, sitemap: false } }'))
    expect(fixed(page('{ feed: false, prerender: true, lastmod: \'2026-01-01\', noindex: true }'), 'deprecated-page-seo').text).toBe(page('{ seo: { feed: false, lastmod: \'2026-01-01\', noindex: true }, prerender: true }'))
  })

  it('takes a setting on its own line out with its line', () => {
    expect(fixed(page('{\n  prerender: true,\n  noindex: true,\n  search: false,\n}'), 'deprecated-page-seo').text).toBe(page('{\n  prerender: true,\n  seo: { noindex: true, search: false },\n}'))
  })

  it('reports with no fix a setting beside a seo the page has, and leaves the ones inside it alone', () => {
    const result = fixed(page('{ noindex: true, seo: { title: \'A\' } }'), 'deprecated-page-seo')

    expect(result.found).toBe(1)
    expect(result.text).toBe(page('{ noindex: true, seo: { title: \'A\' } }'))
    expect(fixed(page('{ seo: { noindex: true, title: \'A\' } }'), 'deprecated-page-seo').found).toBe(0)
  })
})

describe('deprecated-page-cache', () => {
  it('writes a lone ttl, or a lone cacheControl: false, as cache', () => {
    expect(fixed(page('{ prerender: true, ttl: \'1h\' }'), 'deprecated-page-cache')).toEqual({ found: 1, text: page('{ prerender: true, cache: \'1h\' }') })
    expect(fixed(page('{ cacheControl: false }'), 'deprecated-page-cache').text).toBe(page('{ cache: false }'))
  })

  it('reports with no fix a header written out, both settings, or a cache already there', () => {
    for (const settings of ['{ cacheControl: \'public, max-age=9\' }', '{ ttl: \'1h\', cacheControl: false }', '{ ttl: \'1h\', cache: \'2h\' }']) {
      const result = fixed(page(settings), 'deprecated-page-cache')

      expect(result.found).toBeGreaterThan(0)
      expect(result.text).toBe(page(settings))
    }
  })
})
