import { describe, expect, test } from 'bun:test'
import { deriveKeys, digest } from '../src/keys'

const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'
const OTHER = 'another-test-secret-that-is-long-enough-too'

describe('deriveKeys', () => {
  test('encrypted text opens with the same context only', () => {
    const keys = deriveKeys(SECRET)
    const sealed = keys.encrypt('JBSWY3DPEHPK3PXP', 'totp:u1')

    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(keys.decrypt(sealed, 'totp:u1')).toBe('JBSWY3DPEHPK3PXP')
    expect(keys.decrypt(sealed, 'totp:u2')).toBeUndefined()
  })

  test('a rotated list opens what an older secret wrote and writes with the first', () => {
    const old = deriveKeys(OTHER)
    const rotated = deriveKeys([SECRET, OTHER])

    expect(rotated.decrypt(old.encrypt('x', 'c'), 'c')).toBe('x')
    expect(old.decrypt(rotated.encrypt('x', 'c'), 'c')).toBeUndefined()
  })

  test('a forged or truncated value opens to nothing', () => {
    const keys = deriveKeys(SECRET)

    expect(keys.decrypt('', 'c')).toBeUndefined()
    expect(keys.decrypt(`${keys.encrypt('x', 'c').slice(0, -2)}AA`, 'c')).toBeUndefined()
  })

  test('fingerprints depend on the secret', () => {
    expect(deriveKeys(SECRET).fingerprint('1.2.3.4')).toBe(deriveKeys(SECRET).fingerprint('1.2.3.4'))
    expect(deriveKeys(SECRET).fingerprint('1.2.3.4')).not.toBe(deriveKeys(OTHER).fingerprint('1.2.3.4'))
  })

  test('a token digest is stable and does not hold the token', () => {
    expect(digest('token')).toBe(digest('token'))
    expect(digest('token')).not.toContain('token')
  })
})
