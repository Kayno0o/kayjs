import { afterEach, describe, expect, it } from 'bun:test'
import { sanitizeHtml } from '../src/runtime/sanitize'
import { setSite } from '../src/runtime/site'

const BASE = 'https://blog.example/post/'
const OUT = ' target="_blank" rel="nofollow ugc noopener" data-new-tab'
const KEPT = { tags: ['img'], attributes: { img: ['src', 'srcset', 'alt'] } }

const clean = (markup: string, options?: Parameters<typeof sanitizeHtml>[1]) => String(sanitizeHtml(markup, options))

afterEach(() => {
  setSite(undefined)
})

describe('sanitizeHtml base', () => {
  it('resolves a kept href and src against it', () => {
    setSite('https://app.example')

    expect(clean('<a href="/x">x</a><img src="a.png">', { base: BASE, ...KEPT }))
      .toBe(`<a href="https://blog.example/x"${OUT}>x</a><img src="https://blog.example/post/a.png">`)
    expect(clean('<a href="../up?q=1&amp;r=2#h">x</a>', { base: BASE })).toContain('href="https://blog.example/up?q=1&amp;r=2#h"')
    expect(clean('<a href="https://other.example/a">x</a>', { base: BASE })).toContain('href="https://other.example/a"')
    expect(clean('<a href="mailto:a@b.example">x</a>', { base: BASE })).toBe('<a href="mailto:a@b.example" rel="nofollow ugc">x</a>')
  })

  it('drops a javascript: or data: URL, as written or after resolution', () => {
    const markup = [
      '<a href="javascript:alert(1)">a</a>',
      '<a href=" javascript:alert(1)">b</a>',
      '<a href="java&#9;script:alert(1)">c</a>',
      '<a href="java\tscript:alert(1)">d</a>',
      '<a href="data:text/html,x">e</a>',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="JaVaScRiPt:alert(1)">',
    ].join('')
    const html = clean(markup, { base: BASE, ...KEPT })

    expect(html).not.toMatch(/javascript|data:/i)
    expect(html).not.toContain('href')
    expect(html).not.toContain('src')
  })

  it('reads a protocol-relative URL as the base\'s scheme and host, never as a path', () => {
    setSite('https://app.example')

    expect(clean('<a href="//cdn.example/a">x</a>', { base: 'http://blog.example/' })).toBe(`<a href="http://cdn.example/a"${OUT}>x</a>`)
    expect(clean('<img src="//cdn.example/a.png">', { base: BASE, ...KEPT })).toBe('<img src="https://cdn.example/a.png">')
    expect(clean('<a href="///evil.example">x</a><a href="/\\evil.example">y</a><a href="\\\\evil.example">z</a>', { base: BASE })).not.toContain('href')
    expect(clean('<a href="//cdn.example/a">x</a>')).not.toContain('href')
    expect(clean('<a href="//cdn.example/a">x</a>', { relativeUrls: true })).not.toContain('href')
  })

  it('drops the relative URLs of a base that is relative or invalid, and keeps the absolute ones', () => {
    for (const base of ['/post/', 'post/', 'not a url', '', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.example', 'file:///etc/', 'ftp://blog.example/', '//blog.example/']) {
      const html = clean('<a href="/x">a</a><a href="y.html">b</a><a href="#h">c</a><a href="https://other.example/z">d</a><img src="a.png">', { base, ...KEPT })

      expect(html).toBe(`<a>a</a><a>b</a><a>c</a><a href="https://other.example/z"${OUT}>d</a><img>`)
    }
  })

  it('does not throw on a base that is not a string', () => {
    expect(clean('<a href="/x">x</a>', { base: undefined })).toBe('<a href="/x" rel="nofollow ugc">x</a>')
    expect(clean('<a href="/x">x</a>', { base: 5 as unknown as string })).toBe('<a>x</a>')
  })

  it('resolves each candidate of a srcset, and drops the srcset when one is unsafe', () => {
    expect(clean('<img srcset="a.png 1x, /b.png 2x,//c.example/c.png 3x">', { base: BASE, ...KEPT }))
      .toBe('<img srcset="https://blog.example/post/a.png 1x, https://blog.example/b.png 2x, https://c.example/c.png 3x">')
    expect(clean('<img srcset="a.png 1x, javascript:alert(1) 2x">', { base: BASE, ...KEPT })).toBe('<img>')
    expect(clean('<img srcset="a.png 1x, data:image/png;base64,AAAA 2x">', { base: BASE, ...KEPT })).toBe('<img>')
    expect(clean('<img srcset="a.png 1x,">', { base: BASE, ...KEPT })).toBe('<img>')
    expect(clean('<img srcset="a.png">', { base: BASE, ...KEPT })).toBe('<img srcset="https://blog.example/post/a.png">')
  })

  it('cannot be made to break out of an attribute', () => {
    const html = clean('<a href="/x&quot; onclick=&quot;alert(1)">a</a><a href="/x&#34;y">b</a><a href=\'/q?a=1&amp;b="2"\'>c</a><a href="/it\'s">d</a>', { base: BASE })

    expect(html).toBe('<a>a</a><a>b</a><a>c</a><a>d</a>')
  })
})

describe('sanitizeHtml outside links', () => {
  it('opens a link to another origin than the app in a new tab, marked', () => {
    setSite('https://app.example')

    expect(clean('<a href="https://other.example/a?x=1&amp;y=2">x</a>')).toBe(`<a href="https://other.example/a?x=1&amp;y=2"${OUT}>x</a>`)
    expect(clean('<a href="HTTPS://Other.Example/up">x</a>')).toContain(OUT)
    expect(clean('<a href="https://app.example@evil.example/">x</a>')).toContain(OUT)
    expect(clean('<a href="https://app.example.evil.example/">x</a>')).toContain(OUT)
  })

  it('leaves a link of the app, an anchor and a mail link in the tab', () => {
    setSite('https://app.example')

    for (const href of ['https://app.example/a', '/a', '#top', 'mailto:a@other.example'])
      expect(clean(`<a href="${href}">x</a>`)).toBe(`<a href="${href}" rel="nofollow ugc">x</a>`)

    expect(clean('<a href="./a">x</a>', { relativeUrls: true })).toBe('<a href="./a" rel="nofollow ugc">x</a>')
  })

  it('takes any absolute link as leaving while no site is known', () => {
    expect(clean('<a href="https://other.example/">x</a>')).toContain(OUT)
    expect(clean('<a href="/a">x</a>')).not.toContain('target')
  })

  it('counts a link to the base\'s own origin as outside, as it is relative to the app', () => {
    setSite('https://app.example')

    expect(clean('<a href="/own">x</a><a href="https://blog.example/own2">y</a>', { base: BASE }))
      .toBe(`<a href="https://blog.example/own"${OUT}>x</a><a href="https://blog.example/own2"${OUT}>y</a>`)
    // The app's own origin, even named by the base, stays in the tab.
    expect(clean('<a href="/own">x</a>', { base: 'https://app.example/docs/' })).toBe('<a href="https://app.example/own" rel="nofollow ugc">x</a>')
  })

  it('writes nothing under links.outside: same-tab', () => {
    setSite('https://app.example', 'never', false, true)

    expect(clean('<a href="https://other.example/a">x</a>')).toBe('<a href="https://other.example/a" rel="nofollow ugc">x</a>')
    expect(clean('<a href="/x">x</a>', { base: BASE })).toBe('<a href="https://blog.example/x" rel="nofollow ugc">x</a>')
  })

  it('keeps a target a link writes itself, unmarked, and never lets it set rel', () => {
    setSite('https://app.example')

    const options = { attributes: { a: ['target', 'rel'] } }

    expect(clean('<a href="https://other.example/" target="_self" rel="opener">x</a>', options)).toBe('<a href="https://other.example/" target="_self" rel="nofollow ugc">x</a>')
    expect(clean('<a target="_blank" rel="external" href="https://other.example/">x</a>', options)).toBe('<a target="_blank" href="https://other.example/" rel="nofollow ugc">x</a>')
    expect(clean('<a href="/a" rel="opener" target="x">x</a>', options)).toBe('<a href="/a" target="x" rel="nofollow ugc">x</a>')
    // Not kept by the options, a target or rel is dropped and the link marked.
    expect(clean('<a href="https://other.example/" target="_self" rel="opener">x</a>')).toBe(`<a href="https://other.example/"${OUT}>x</a>`)
  })

  it('marks no link without an href', () => {
    expect(clean('<a name="x">x</a>')).toBe('<a>x</a>')
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
  })
})
