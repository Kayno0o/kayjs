import { describe, expect, it } from 'bun:test'
import * as auth from '../src'
import * as pg from '../src/pg'
import { pgAuth } from '../src/pg'

describe('the constructor names of 1.91', () => {
  it('no longer exports the old names', () => {
    for (const old of ['createAuth', 'createGate', 'createRoleHierarchy', 'createWsAuthStore', 'memoryAuthStore'])
      expect(old in auth).toBe(false)

    expect('pgStore' in pg).toBe(false)
  })

  it('names the URL path when pgAuth is given a connection instead of a Database', () => {
    expect(() => pgAuth('postgres://localhost/app' as never)).toThrow('auth({ store: { url } })')
    expect(() => pgAuth({ sql: {} } as never)).toThrow('pg-orm `Database`')
  })
})
