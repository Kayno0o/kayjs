import type { Level, PolicyContext, Principal, Requirement } from './types'
import { meetsRequirement } from './requirement'

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
  if (principal == null || !store.hasCredential(principal))
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
  return meetsRequirement(principal, requirement, ctx, async (grant) => {
    const type = typeof grant === 'string' ? grant : grant.type
    const resourceId = typeof grant === 'string' ? undefined : grant.resourceId

    const permission = await store.getPermission(store.subjectId(principal), type, resourceId)

    if (!permission)
      return false

    return level === 'read' || permission === 'write'
  })
}
