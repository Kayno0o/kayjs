import type { DefinitionBase, Elysia, EphemeralType, MetadataBase, RouteBase, SingletonBase } from 'elysia'
import type { Level, PolicyContext, Requirement } from './types'

const READ_METHODS = new Set(['GET', 'HEAD'])
const DECIDED = Symbol('auth.decided')

// The scope a route asks of a scoped bearer token, any one of a list, or false to let every token through.
export type ScopeRequirement<S extends string> = S | S[] | false

// What the gate needs wired in: who is asking and whether they may.
export interface GateDeps<P, G extends string, S extends string = string> {
  principal: (ctx: object) => Promise<P | null>
  authorize: (principal: P | null, requirement: Requirement<P, G>, level: Level, ctx: PolicyContext) => Promise<boolean>
  // Applied to routes with no `auth:`, so a route that forgets one stays closed.
  defaultRequirement: Requirement<P, G>
  // The scopes of the bearer token a request came with; null for a session, or a token with every scope.
  scopes?: ((ctx: object) => Promise<readonly string[] | null>) | undefined
  // Applied to routes with no `scope:`; without it a scoped token passes only routes naming one of its scopes.
  defaultScope?: ScopeRequirement<S> | undefined
}

// The slice of the Elysia context the gate reads, plus the stamps it leaves on it, each gate's own under its own symbols.
interface GateContext<P, G extends string> extends PolicyContext {
  request: Request
  set: { status?: number | string }
  [DECIDED]?: Set<Requirement<P, G>>
  [stamp: symbol]: unknown
}

// Whether `scopes`, a token's, meet what a route asks; a session, or a token with every scope, meets anything.
export function scopeAllows(scopes: readonly string[] | null, wanted: ScopeRequirement<string> | undefined): boolean {
  if (scopes === null || wanted === false)
    return true

  return wanted !== undefined && [wanted].flat().some(scope => scopes.includes(scope))
}

// The macro only stamps the route's requirement; one local beforeHandle enforces it, so routes added through `group`, `guard`, `use`, `route`, `all` or `ws` fall back to `defaultRequirement` too.
// Routes of the instance it is used on take `auth: <Requirement>` to override the default and `auth: false` to opt out, and `scope:` for what a scoped bearer token needs. Answers 401 to an anonymous caller and 403 to a signed-in one who is denied.
export function createGate<P, G extends string, S extends string = string>(deps: GateDeps<P, G, S>) {
  // Generic over the app's own types, so what it holds already, such as `auth`, reaches the routes after it.
  return <Base extends string, Single extends SingletonBase, Defs extends DefinitionBase, Meta extends MetadataBase, Routes extends RouteBase, Eph extends EphemeralType, Vol extends EphemeralType>(app: Elysia<Base, Single, Defs, Meta, Routes, Eph, Vol>) => {
    // Elysia runs a route's `auth:` through the nearest gate's macro only, while every enclosing gate's hook runs: stamped under this gate's own symbols, the route's choice binds this gate alone, and the gates around it keep their own requirement.
    const ownRequirement = Symbol('auth.requirement')
    const ownScope = Symbol('auth.scope')
    const gated = app
      .macro({
        auth: (requirement: Requirement<P, G> | false | undefined) => ({
          transform(ctx: object) {
            (ctx as GateContext<P, G>)[ownRequirement] = requirement ?? deps.defaultRequirement
          },
        }),
        scope: (scope: ScopeRequirement<S> | undefined) => ({
          transform(ctx: object) {
            if (scope !== undefined)
              (ctx as GateContext<P, G>)[ownScope] = scope
          },
        }),
      })

    // Hooked as a plain instance: the hook changes no type, and the app's own make its context too deep to check.
    const plain = gated as unknown as Elysia

    plain.onBeforeHandle({ as: 'local' }, async (context) => {
      const ctx = context as unknown as GateContext<P, G>
      const requirement = (ctx[ownRequirement] as Requirement<P, G> | false | undefined) ?? deps.defaultRequirement

      if (requirement === false)
        return

      // A route nested in two gated instances runs this once per gate: each holds it to its own requirement, and a requirement already met is not asked again.
      if (!ctx[DECIDED]?.has(requirement)) {
        const user = await deps.principal(ctx)
        const level: Level = READ_METHODS.has(ctx.request.method) ? 'read' : 'write'

        if (!(await deps.authorize(user, requirement, level, { params: ctx.params, body: ctx.body, query: ctx.query }))) {
          ctx.set.status = user === null ? 401 : 403

          return user === null ? 'Unauthorized' : 'Forbidden'
        }

        (ctx[DECIDED] ??= new Set()).add(requirement)
      }

      if (deps.scopes && !scopeAllows(await deps.scopes(ctx), (ctx[ownScope] as ScopeRequirement<string> | undefined) ?? deps.defaultScope)) {
        ctx.set.status = 403

        return 'Forbidden'
      }
    })

    return gated
  }
}
