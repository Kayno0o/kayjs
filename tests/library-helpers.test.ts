import { describe, expect, it } from 'bun:test'
import { acceptedLocales, durationSeconds, escapeHtml, matchLocale, openWith, sameText, sealWith, weakSecrets } from 'kay/library'
import { escape, escapeAttribute } from '../src/runtime/escape'

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

// What kay hands its libraries in place of their own copies.
describe('kay/library', () => {
  it('escapes for any place in markup what escape and escapeAttribute escape for theirs', () => {
    const text = `Tom & "Jerry" <b>it's</b> > all`

    expect(escapeHtml(text)).toBe('Tom &amp; &quot;Jerry&quot; &lt;b&gt;it&#39;s&lt;/b&gt; &gt; all')

    for (const char of '&<>"\'') {
      if (escape(char) !== char || escapeAttribute(char) !== char)
        expect(escapeHtml(char)).not.toBe(char)
    }
  })

  it('opens what it sealed under any of its keys and the same context, and nothing else', () => {
    const sealed = sealWith(KEY, 'secret', 'session')

    expect(openWith([OTHER_KEY, KEY], sealed, 'session')).toEqual({ text: 'secret', key: 1 })
    expect(openWith([KEY], sealed, 'flash')).toBeUndefined()
    expect(openWith([KEY], sealed)).toBeUndefined()
    expect(openWith([OTHER_KEY], sealed, 'session')).toBeUndefined()
    expect(openWith([KEY], `${sealed.slice(0, -2)}AA`, 'session')).toBeUndefined()
    expect(openWith([KEY], 'short', 'session')).toBeUndefined()
    expect(openWith([KEY], sealWith(KEY, 'no context'))).toEqual({ text: 'no context', key: 0 })
  })

  it('compares texts of any length and refuses missing or short secrets', () => {
    expect(sameText('abc', 'abc')).toBe(true)
    expect(sameText('abc', 'abd')).toBe(false)
    expect(sameText('abc', 'abcd')).toBe(false)
    expect(weakSecrets([])).toBe(true)
    expect(weakSecrets(['x'.repeat(32), 'short'])).toBe(true)
    expect(weakSecrets(['x'.repeat(32)])).toBe(false)
  })

  it('reads an Accept-Language header most wanted first, leaving out *, refused and malformed tags', () => {
    expect(acceptedLocales('fr-CA;q=0.8, en;q=0.9, *;q=0.5, de;q=0, x_bad, pt-BR')).toEqual(['pt-BR', 'en', 'fr-CA'])
    expect(acceptedLocales('')).toEqual([])
    expect(matchLocale(['en', 'fr'], ['de', 'FR-ca'])).toBe('fr')
    expect(matchLocale(['en', 'fr-CA'], ['fr'])).toBe('fr-CA')
    expect(matchLocale(['en', 'fr'], ['de'])).toBeUndefined()
  })

  it('names the library a wrong duration comes from', () => {
    expect(durationSeconds('2m', 'retry')).toBe(120)
    expect(() => durationSeconds('soon', 'retry', 'kayjs-mail')).toThrow(/^kayjs-mail:/)
  })
})
