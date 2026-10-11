import { describe, expect, it } from 'bun:test'
import { staleWarning, wantedSource } from './sites'

describe('wantedSource', () => {
  it('names a checkout as it reads now, a registry version with its version, and any specifier as it is', () => {
    expect(wantedSource('checkout', () => 'this checkout at 23f55e2, packed')).toBe('this checkout at 23f55e2, packed')
    expect(wantedSource('1.37.6', () => '')).toBe('the registry at 1.37.6')
    expect(wantedSource('file:/tmp/kay.tgz', () => '')).toBe('file:/tmp/kay.tgz')
  })
})

describe('staleWarning', () => {
  it('warns of an install other than the one asked for, and of uncommitted changes packed earlier', () => {
    expect(staleWarning('bakery kay', 'the registry at 1.37.6', 'the registry at 1.37.7')).toBe('SKIP_PREPARE: bakery kay runs the registry at 1.37.6, not the registry at 1.37.7; prepare again to measure that')
    expect(staleWarning('bakery kay', 'this checkout at 23f55e2 with uncommitted changes, packed', 'this checkout at 23f55e2 with uncommitted changes, packed')).toContain('runs uncommitted changes as packed by the last prepare')
    expect(staleWarning('bakery kay', 'this checkout at 23f55e2, packed', 'this checkout at 23f55e2, packed')).toBeUndefined()
  })
})
