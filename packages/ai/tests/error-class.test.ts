import { describe, expect, it } from 'bun:test'
import { KayError } from 'kay/library'
import { AiError } from '../src'

describe('AiError', () => {
  it('is a KayError coded ai-error, its kind the failure and its status the provider\'s', () => {
    const cause = new Error('socket')
    const error = new AiError('rate-limited', 'slow down', { status: 429, retryAfter: 3, cause })

    expect(error).toBeInstanceOf(KayError)
    expect(error).toBeInstanceOf(AiError)
    expect([error.code, error.kind, error.name, error.status, error.retryAfter]).toEqual(['ai-error', 'rate-limited', 'AiError', 429, 3])
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('kayjs-ai: slow down')
  })
})
