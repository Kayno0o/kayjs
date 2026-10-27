import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sanitizeHtml } from '../src/runtime/sanitize'
import { setSite } from '../src/runtime/site'

const BASE = 'https://blog.example/post/'
const OUT = ' target="_blank" rel="nofollow ugc noopener" data-new-tab'

const clean = (markup: string, options?: Parameters<typeof sanitizeHtml>[1]) => String(sanitizeHtml(markup, options))

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://app.example/page/' })
})

afterAll(async () => {
  setSite(undefined)
  await GlobalRegistrator.unregister()
})

// In an island no site is configured, so the origin comes from `location`.
describe('sanitizeHtml in an island', () => {
  it('takes location.origin for the site, with a base and outside links', () => {
    expect(clean('<a href="https://other.example/a">x</a><a href="https://app.example/b">y</a><a href="/c">z</a>', { base: BASE }))
      .toBe(`<a href="https://other.example/a"${OUT}>x</a><a href="https://app.example/b" rel="nofollow ugc">y</a><a href="https://blog.example/c"${OUT}>z</a>`)
    expect(clean('<a href="/own">x</a>', { base: 'https://app.example/docs/' })).toBe('<a href="https://app.example/own" rel="nofollow ugc">x</a>')
    expect(clean('<a href="https://app.example@evil.example/">x</a>')).toContain(OUT)
  })

  it('writes no target under the same-tab meta', () => {
    const meta = document.createElement('meta')

    meta.name = 'kay-same-tab-links'
    document.head.append(meta)

    try {
      expect(clean('<a href="https://other.example/a">x</a>', { base: BASE })).toBe('<a href="https://other.example/a" rel="nofollow ugc">x</a>')
      expect(clean('<a href="/x">x</a>', { base: BASE })).toBe('<a href="https://blog.example/x" rel="nofollow ugc">x</a>')
    }
    finally {
      meta.remove()
    }
  })

  it('adds noopener to a kept target that opens a new context', () => {
    const options = { attributes: { a: ['target'] } }

    for (const target of ['_blank', '_BLANK', 'popup', ' _blank', '_top', '_parent', '', '_s&#101;lf'])
      expect(clean(`<a href="https://other.example/" target="${target}">x</a>`, options)).toBe(`<a href="https://other.example/" target="${target}" rel="nofollow ugc noopener">x</a>`)

    expect(clean('<a href="https://other.example/" target="_SELF">x</a>', options)).toBe('<a href="https://other.example/" target="_SELF" rel="nofollow ugc">x</a>')
    expect(clean('<a href="https://other.example/" target="_self">x</a>', options)).toBe('<a href="https://other.example/" target="_self" rel="nofollow ugc">x</a>')
  })
})
