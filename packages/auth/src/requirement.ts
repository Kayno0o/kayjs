import type { PolicyContext, Requirement } from './types'

/** Whether any rule of a requirement passes: an array passes on any entry, a predicate on its answer, and a grant on what `granted` says of it. */
export async function meetsRequirement<P, G extends string>(
  principal: P,
  requirement: Requirement<P, G>,
  ctx: PolicyContext,
  granted: (grant: Exclude<Requirement<P, G>, ((...args: never[]) => unknown) | unknown[]>) => boolean | Promise<boolean>,
): Promise<boolean> {
  if (Array.isArray(requirement)) {
    for (const rule of requirement) {
      if (await meetsRequirement(principal, rule, ctx, granted))
        return true
    }

    return false
  }

  if (typeof requirement === 'function')
    return Boolean(await requirement(principal, ctx))

  return granted(requirement as Parameters<typeof granted>[0])
}
