import type Elysia from 'elysia'
import type { Level, PolicyContext, Requirement } from './types'

const READ_METHODS = new Set(['GET', 'HEAD'])
const REQUIREMENT = Symbol('auth.requirement')
const DECIDED = Symbol('auth.decided')

// What the gate needs wired in: who is asking and whether they may.
export interface GateDeps<P, G extends string> {
  principal: (ctx: object) => Promise<P | null>
  authorize: (principal: P | null, requirement: Requirement<P, G>, level: Level, ctx: PolicyContext) => Promise<boolean>
  // Applied to routes with no `auth:`, so a route that forgets one stays closed.
  defaultRequirement: Requirement<P, G>
}

// The slice of the Elysia context the gate reads, plus the stamps it leaves on it.
interface GateContext<P, G extends string> extends PolicyContext {
  request: Request
  set: { status?: number | string }
  [REQUIREMENT]?: Requirement<P, G> | false
  [DECIDED]?: Set<Requirement<P, G>>
}

// The macro only stamps the route's requirement; one local beforeHandle enforces it, so routes added through `group`, `guard`, `use`, `route`, `all` or `ws` fall back to `defaultRequirement` too.
// Routes of the instance it is used on take `auth: <Requirement>` to override the default and `auth: false` to opt out. Answers 401 to an anonymous caller and 403 to a signed-in one who is denied.
export function createGate<P, G extends string>(deps: GateDeps<P, G>) {
  return (app: Elysia) =>
    app
      .macro({
        auth: (requirement: Requirement<P, G> | false | undefined) => ({
          transform(ctx: object) {
            (ctx as GateContext<P, G>)[REQUIREMENT] = requirement ?? deps.defaultRequirement
          },
        }),
      })
      .onBeforeHandle({ as: 'local' }, async (context) => {
        const ctx = context as unknown as GateContext<P, G>
        const requirement = ctx[REQUIREMENT] ?? deps.defaultRequirement

        // A route nested in two gated instances runs this once per gate: each holds it to its own requirement, and a requirement already met is not asked again.
        if (requirement === false || ctx[DECIDED]?.has(requirement))
          return

        const user = await deps.principal(ctx)
        const level: Level = READ_METHODS.has(ctx.request.method) ? 'read' : 'write'
        const ok = await deps.authorize(user, requirement, level, { params: ctx.params, body: ctx.body, query: ctx.query })

        if (ok) {
          (ctx[DECIDED] ??= new Set()).add(requirement)

          return
        }

        ctx.set.status = user === null ? 401 : 403

        return user === null ? 'Unauthorized' : 'Forbidden'
      })
}
