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
})

describe('pkce', () => {
  test('produces an S256 verifier/challenge pair', async () => {
    const a = await createPkcePair()
    const b = await createPkcePair()

    expect(a.method).toBe('S256')
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.challenge).toMatch(/^[\w-]+$/)
  })
})
