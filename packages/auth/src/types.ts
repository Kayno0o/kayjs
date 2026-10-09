export type Level = 'read' | 'write'

/** The resolved actor, generic over the consumer's user type. `null` is anonymous. */
export type Principal<P> = P | null

/** Request-derived facts a predicate may read - a subset of the Elysia context. */
export interface PolicyContext {
  params?: Record<string, any> | undefined
  body?: any
  query?: Record<string, string> | undefined
}

/** Custom authorization check: receives the resolved principal and request context. */
export type Predicate<P> = (principal: Principal<P>, ctx: PolicyContext) => boolean | Promise<boolean>

/** What a route requires: a grant type `G`, a resource-scoped `{ type, resourceId }`, a `Predicate`, or an array where ANY entry passes. */
export type Requirement<P, G extends string>
  = | G
    | { type: G, resourceId?: number | null }
    | Predicate<P>
    | Requirement<P, G>[]
