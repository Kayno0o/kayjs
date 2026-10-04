import { describe, expect, test } from 'bun:test'
import { safeRedirect } from '../src/oauth/callback'
import { createPkcePair } from '../src/oauth/pkce'
import { OAuthStateError, signState, verifyState } from '../src/oauth/state'

const SECRET = 'test-secret'

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

describe('state', () => {
  test('round-trips a payload and returns the nonce', async () => {
    const { state, nonce } = await signState(SECRET, { redirect: '/x' })

    expect(await verifyState<{ redirect: string }>(SECRET, state, { expectedNonce: nonce })).toEqual({ redirect: '/x' })
  })

  test('rejects a tampered signature', async () => {
    const { state } = await signState(SECRET, { a: 1 })

    expect(verifyState(SECRET, `${state}x`)).rejects.toThrow('signature mismatch')
  })

  test('rejects a wrong secret', async () => {
    const { state } = await signState(SECRET, { a: 1 })

    expect(verifyState('other', state)).rejects.toThrow('signature mismatch')
  })

  test('rejects an expired state', async () => {
    const { state } = await signState(SECRET, { a: 1 })

    expect(verifyState(SECRET, state, { maxAgeMs: -1 })).rejects.toThrow('expired')
  })

  test('rejects a mismatched nonce (login-CSRF binding)', async () => {
    const { state } = await signState(SECRET, { a: 1 }, { nonce: 'cookie-nonce' })

    expect(verifyState(SECRET, state, { expectedNonce: 'attacker' })).rejects.toThrow('nonce mismatch')
  })

  test('failures are OAuthStateError carrying the failed check as reason', async () => {
    const { state } = await signState(SECRET, { a: 1 }, { nonce: 'cookie-nonce' })
    // Thunks, not promises: a promise built ahead of its await can reject first and read as unhandled.
    const cases: [() => Promise<unknown>, OAuthStateError['reason']][] = [
      [() => verifyState(SECRET, 'no-dot'), 'malformed'],
      [() => verifyState(SECRET, `${state}x`), 'signature'],
      [() => verifyState(SECRET, state, { maxAgeMs: -1 }), 'expired'],
      [() => verifyState(SECRET, state, { expectedNonce: 'attacker' }), 'nonce'],
    ]

    for (const [verify, reason] of cases) {
      let err: unknown

      try {
        await verify()
      }
      catch (e) {
        err = e
      }

      expect(err).toBeInstanceOf(OAuthStateError)
      expect((err as OAuthStateError).reason).toBe(reason)
    }
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
