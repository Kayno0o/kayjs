import { describe, expect, it } from 'bun:test'
import * as auth from '../src'
import { pgAuth, pgStore } from '../src/pg'

describe('the constructor names of 1.91', () => {
  it('keeps each old name as the same function', () => {
    expect(auth.createAuth).toBe(auth.authCore)
    expect(auth.createGate).toBe(auth.authGate)
    expect(auth.createRoleHierarchy).toBe(auth.roleHierarchy)
    expect(auth.createWsAuthStore).toBe(auth.wsAuthStore)
    expect(auth.memoryAuthStore).toBe(auth.memoryAuth)
    expect(pgStore).toBe(pgAuth)
  })

  it('names the URL path when pgAuth is given a connection instead of a Database', () => {
    expect(() => pgAuth('postgres://localhost/app' as never)).toThrow('auth({ store: { url } })')
    expect(() => pgAuth({ sql: {} } as never)).toThrow('pg-orm `Database`')
  })
})
