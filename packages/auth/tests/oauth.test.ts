import { describe, expect, test } from 'bun:test'
import { createPkcePair } from '../src/oauth/pkce'
import { safeRedirect } from '../src/oauth/redirect'

describe('safeRedirect', () => {
  test('allows same-origin absolute paths', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard')
    expect(safeRedirect('/a/b?x=1')).toBe('/a/b?x=1')
  })

  test('rejects open-redirect targets, falling back', () => {
    expect(safeRedirect('//evil.com')).toBe('/')
    expect(safeRedirect('/\\evil.com')).toBe('/')
    expect(safeRedirect('/\t//evil.com')).toBe('/')
    expect(safeRedirect('https://evil.com')).toBe('/')
    expect(safeRedirect(null)).toBe('/')
    expect(safeRedirect(undefined, '/home')).toBe('/home')
  })

  test('rejects a path that normalises to another host, and answers the others normalised', () => {
    for (const path of ['/.//evil.com', '/./\\evil.com', '/%2e//evil.com', '/a/../..//evil.com', '/%2F%2Fevil.com', '/%2fevil.com', '/./%5Cevil.com'])
      expect([path, safeRedirect(path)]).toEqual([path, '/'])

    for (const path of ['/.%2f/evil.com', '/a/..%2f/evil.com', '/%2e%2e%2f%2e%2e%2f/evil.com', '/%252F/evil.com', '/%E0%A4%A'])
      expect([path, safeRedirect(path)]).toEqual([path, '/'])

    expect(safeRedirect('/a/./b/../c?next=//x#top')).toBe('/a/c?next=//x#top')
    expect(safeRedirect('/a/%2F')).toBe('/a/%2F')
    expect(['/../x', '/a?', '/é?q=é', '/a b'].map(path => safeRedirect(path))).toEqual(['/x', '/a', '/%C3%A9?q=%C3%A9', '/a%20b'])
    expect(safeRedirect(safeRedirect('/a/./é'))).toBe(safeRedirect('/a/./é'))
  })

  // Hostile values that must fall back, and the invariant for every answer: on the site's origin both resolved raw and decoded once.
  const hostile = [
    '/%09/evil.com',
    '/%0a/evil.com',
    '/%0d/evil.com',
    '/%0A/evil.com',
    '/%0D/evil.com',
    '/%09%0a%0d/evil.com',
    '/%0a%09/evil.com',
    '/%09%09/evil.com',
    '/%5cevil.com',
    '/%5Cevil.com',
    '/%09%5cevil.com',
    '/%0a%5cevil.com',
    '/\\evil.com',
    '/\t\\evil.com',
    '//evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    '\t//evil.com',
    ' //evil.com',
    '/%2f/evil.com',
    '/%2F/evil.com',
    '/%09/%2fevil.com',
    '/%2509/evil.com',
    '/%250a/evil.com',
    '/%252F/evil.com',
    '/%255cevil.com',
    '/%252509/evil.com',
    '/%2509/evil.com?%25',
    '/%2509/evil.com/%25zz',
    '/%2509/evil.com#100%25',
    '/%250a/evil.com?q=%25',
    `/%${'25'.repeat(9)}09/evil.com`,
    '/%E0%A4%A',
    '/%E0%A4%A?x=1',
    '/a%3Fb%',
    '/%E0%A4%A#%',
    '/a%?x=1',
    '/%2F/evil.com?x=%',
    '/%5Cevil.com#%',
    '/%2509/evil.com?x=%zz',
    '/%09/%E0%A4%A',
    'https://evil.com',
    'http:evil.com',
    'javascript:alert(1)',
    'evil.com',
  ]

  test('rejects tab, newline and backslash hidden behind an escape', () => {
    for (const path of hostile)
      expect([path, safeRedirect(path)]).toEqual([path, '/'])
  })

  test('a bare percent after the path no longer rejects the value', () => {
    const legit = ['/a?x=%25zz#%', '/a?x=%', '/a#%', '/a?x=%zz&y=%E0%A4%A#100%', '/a/b?next=%09//x%']

    expect(legit.map(path => safeRedirect(path))).toEqual(legit)
  })

  test('only a literal question mark or hash ends the strict part', () => {
    expect(['/%3F%2F/evil.com', '/%253F%252F/evil.com', '/a%23?%'].map(path => safeRedirect(path))).toEqual(['/%3F%2F/evil.com', '/%253F%252F/evil.com', '/a%23?%'])
  })

  test('every answer stays on the site, resolved raw and decoded once', () => {
    const legit = ['/dashboard', '/a/b?x=1#top', '/a/%2F', '/a/%09b', '/a?next=%09//x', '/a?q=%0a', '/é?q=é', '/a b', '/a/%5Cb', '/%7Euser', '/a/..%2fb', '/.%09/evil.com', '/a/..%09/evil.com', '/ /evil.com', '/%2e%09/evil.com', '/a?q=100%25']

    for (const path of [...hostile, ...legit]) {
      const answer = safeRedirect(path)

      for (const form of [answer, decodeURIComponent(answer)]) {
        const url = new URL(form, 'http://site.test')

        expect([path, url.origin]).toEqual([path, 'http://site.test'])
      }
    }

    expect(['/a/%09b', '/a?next=%09//x', '/a?q=%0a', '/a/%5Cb', '/a?q=100%25'].map(path => safeRedirect(path))).toEqual(['/a/%09b', '/a?next=%09//x', '/a?q=%0a', '/a/%5Cb', '/a?q=100%25'])
  })
})

describe('pkce', () => {
  test('produces an S256 verifier/challenge pair', async () => {
    const a = await createPkcePair()
    const b = await createPkcePair()

    expect(a.method).toBe('S256')
    expect(a.verifier).not.toBe(b.verifier)
    // RFC 7636: the challenge is base64url(sha256(verifier)), unpadded.
    expect(a.challenge).toBe(new Bun.CryptoHasher('sha256').update(a.verifier).digest('base64url'))
    expect(a.verifier).toMatch(/^[\w-]{43,128}$/)
  })
})
