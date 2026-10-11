import { describe, expect, test } from 'bun:test'
import { createRoleHierarchy } from '../src/roles'

type Role = 'ROLE_USER' | 'ROLE_ADMIN' | 'ROLE_SUPER_ADMIN'

interface User { roles: Role[] }

const hierarchy: Record<Role, Role[]> = {
  ROLE_USER: [],
  ROLE_ADMIN: ['ROLE_USER'],
  ROLE_SUPER_ADMIN: ['ROLE_ADMIN'],
}

const { isGranted, hasRole } = createRoleHierarchy<User, Role>(hierarchy, u => u.roles)

describe('createRoleHierarchy', () => {
  test('isGranted walks inherited roles', () => {
    expect(isGranted('ROLE_USER', ['ROLE_ADMIN'])).toBe(true)
    expect(isGranted('ROLE_ADMIN', ['ROLE_SUPER_ADMIN'])).toBe(true)
    expect(isGranted('ROLE_SUPER_ADMIN', ['ROLE_ADMIN'])).toBe(false)
    expect(isGranted('ROLE_ADMIN', ['ROLE_USER'])).toBe(false)
  })

  test('hasRole builds a predicate that reads the principal roles', () => {
    const requireUser = hasRole('ROLE_USER')

    expect(requireUser({ roles: ['ROLE_ADMIN'] }, {})).toBe(true)
    expect(requireUser({ roles: ['ROLE_USER'] }, {})).toBe(true)
    expect(requireUser({ roles: [] }, {})).toBe(false)
  })

  test('hasRole denies an anonymous principal', () => {
    expect(hasRole('ROLE_USER')(null, {})).toBe(false)
  })
})
