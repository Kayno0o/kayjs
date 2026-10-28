import type { BareUser } from './core'
import type { RoleHierarchy } from './roles'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { meetsRequirement } from './requirement'
import { createRoleHierarchy } from './roles'

// What decides whether a user meets a requirement, settled from the `roles` and `authorize` options when the core is made.
export interface Access<Role extends string> {
  hasRole: (required: Role) => Predicate<BareUser>
  isGranted: (role: Role, roles: string[]) => boolean
  authorize: (user: BareUser | null, requirement: Requirement<BareUser, Role>, level: Level, ctx: PolicyContext) => Promise<boolean>
}

export function accessOf<Role extends string>(options: { roles?: Record<Role, Role[]> | undefined, authorize?: Access<Role>['authorize'] | undefined }): Access<Role> {
  const { hasRole, isGranted } = createRoleHierarchy<BareUser, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  // The default decision reads a string as a role and runs a predicate.
  const evaluate = async (user: BareUser, requirement: Requirement<BareUser, Role>, ctx: PolicyContext): Promise<boolean> => meetsRequirement(user, requirement, ctx, (grant) => {
    if (typeof grant === 'string')
      return isGranted(grant, user.roles)

    // A grant on one record needs the app's own `authorize`.
    return grant.resourceId == null && isGranted(grant.type, user.roles)
  })

  return {
    hasRole,
    isGranted: (role, roles) => isGranted(role, roles),
    authorize: options.authorize ?? (async (user, requirement, _level, ctx) => user !== null && evaluate(user, requirement, ctx)),
  }
}
