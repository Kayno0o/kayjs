import type { Level, PolicyContext, Principal, Requirement } from './types'

/** Injected grant lookups the decision needs. No built-in super-user: model it as a role (`hasRole('ROLE_SUPER_ADMIN')`). */
export interface GrantStore<P, G extends string> {
  /** Whether the principal currently holds a live credential (e.g. a valid OAuth token). */
  hasCredential: (principal: P) => boolean
  /** The key a grant is looked up by (e.g. a Discord id). */
  subjectId: (principal: P) => string
  getPermission: (subjectId: string, type: G, resourceId?: number | null) => Promise<Level | null>
}

/** App-wide authorization decision: requires a live credential, then evaluates the requirement against the grant store. */
export async function decide<P, G extends string>(
  store: GrantStore<P, G>,
  principal: Principal<P>,
  requirement: Requirement<P, G>,
  level: Level,
  ctx: PolicyContext = {},
): Promise<boolean> {
  if (!principal || !store.hasCredential(principal))
    return false

  return evaluate(store, principal, requirement, level, ctx)
}

async function evaluate<P, G extends string>(
  store: GrantStore<P, G>,
  principal: P,
  requirement: Requirement<P, G>,
  level: Level,
  ctx: PolicyContext,
): Promise<boolean> {
  if (Array.isArray(requirement)) {
    for (const rule of requirement) {
      if (await evaluate(store, principal, rule, level, ctx))
        return true
    }

    return false
  }

  if (typeof requirement === 'function')
    return Boolean(await requirement(principal, ctx))

  const type = typeof requirement === 'string' ? requirement : requirement.type
  const resourceId = typeof requirement === 'string' ? undefined : requirement.resourceId

  const permission = await store.getPermission(store.subjectId(principal), type, resourceId)

  if (!permission)
    return false

  return level === 'read' || permission === 'write'
}
