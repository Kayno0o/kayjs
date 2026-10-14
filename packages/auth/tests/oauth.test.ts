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
