import type { Predicate, Principal } from './types'
import { declareIsGranted } from '@kaynooo/utils'

/** Parent role -> the roles it inherits (Symfony-style role hierarchy). */
export type RoleHierarchy<R extends string> = Record<R, R[]>

/** Role-hierarchy checker plus a `Requirement` bridge: `isGranted` walks the hierarchy, `hasRole` wraps it as a `Predicate` for `auth:`. `getRoles` projects a principal's roles. */
export function roleHierarchy<P, R extends string>(
  hierarchy: RoleHierarchy<R>,
  getRoles: (principal: P) => R[],
) {
  const isGranted = declareIsGranted(hierarchy)

  const hasRole = (required: R): Predicate<P> =>
    (principal: Principal<P>) => principal != null && isGranted(required, getRoles(principal))

  return { isGranted, hasRole }
}

/** @deprecated Renamed `roleHierarchy` in 1.91, as a constructor is a noun (`create*` is for what writes schema); the old name works until 1.94. */
export const createRoleHierarchy = roleHierarchy
