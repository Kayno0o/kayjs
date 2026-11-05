import { describe, expect, it } from 'bun:test'
import { KayError } from 'kay/library'
import { OAuthExchangeError } from '../src/oauth/client'

describe('OAuthExchangeError', () => {
  it('is a KayError whose status is the provider\'s, with the cause passed through', () => {
    const cause = new Error('down')
    const error = new OAuthExchangeError(502, 'token request failed', { cause })

    expect(error).toBeInstanceOf(KayError)
    expect([error.code, error.kind, error.name, error.status]).toEqual(['oauth-exchange', 'oauth-exchange', 'OAuthExchangeError', 502])
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('kayjs-auth: token request failed')
  })
})
