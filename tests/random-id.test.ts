import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { randomId } from '../src/runtime'
import { hold } from '../src/runtime/live-value.client'
import { presence } from '../src/runtime/presence'
import { sha256 } from '../src/server/sha256'

describe('randomId', () => {
  it('gives 2 * bytes lowercase hex characters, 32 by default, and never twice the same', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/)
    expect(randomId(10)).toMatch(/^[0-9a-f]{20}$/)
    expect(randomId(4)).toMatch(/^[0-9a-f]{8}$/)
    expect(randomId()).not.toBe(randomId())
  })

  it('takes 0 as the empty string and refuses a negative count', () => {
    expect(randomId(0)).toBe('')
    expect(randomId(65_536)).toHaveLength(131_072)
    expect(() => randomId(-1)).toThrow()
  })

  it('makes a component an island', () => {
    expect(compileKay('---\nimport { randomId } from \'kay\'\nconst key = randomId()\n---\np {key}', 'a.kay').island).toBeDefined()
  })

  it('names a presence tab with 24 characters', () => {
    const globals = globalThis as { KAY_BROWSER?: boolean }

    globals.KAY_BROWSER = true

    try {
      delete hold.tab
      presence('room')
      expect(hold.tab).toMatch(/^[0-9a-f]{24}$/)
    }
    finally {
      delete globals.KAY_BROWSER
      delete hold.tab
    }
  })
})

describe('sha256', () => {
  it('writes the digest as hex, base64 or base64url, cut to a length, plain or keyed', () => {
    expect(sha256('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    expect(sha256('a', { length: 32 })).toBe('ca978112ca1bbdcafac231b39a23dc4d')
    expect(sha256('a', { encoding: 'base64' })).toBe(Buffer.from(sha256('a'), 'hex').toString('base64'))
    expect(sha256('a', { encoding: 'base64url', length: 22 })).toBe(Buffer.from(sha256('a'), 'hex').toString('base64url').slice(0, 22))
    expect(sha256('a', { key: 'k' })).toBe(new Bun.CryptoHasher('sha256', 'k').update('a').digest('hex'))
    // A fixed HMAC, so a stored token's format cannot drift with the helper.
    expect(sha256('a', { key: 'k', encoding: 'base64url' })).toBe('eNqRUR5nVYf1ud94vt669VYNoqu4gWLuh13N90SVHZ4')
  })
})
