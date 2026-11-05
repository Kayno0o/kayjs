import { describe, expect, it } from 'bun:test'
import { KayError } from 'kay/library'
import { UpstreamError } from '../src/eject'

describe('UpstreamError', () => {
  it('is a KayError coded upstream-invalid with the library prefix', () => {
    const error = new UpstreamError('record is bad')

    expect(error).toBeInstanceOf(KayError)
    expect([error.code, error.kind, error.name, error.message]).toEqual(['upstream-invalid', 'upstream-invalid', 'UpstreamError', 'kayjs-ui: record is bad'])
  })
})
