import type Elysia from 'elysia'
import type { Level, PolicyContext, Requirement } from './types'

const READ_METHODS = new Set(['GET', 'HEAD'])
const REQUIREMENT = Symbol('auth.requirement')
const DECIDED = Symbol('auth.decided')

/** What the auth plugin needs wired in: how to resolve a principal and how to authorize it. */
export interface AuthPluginDeps<P, G extends string> {
  resolvePrincipal: (
    req: { cookie: any, headers: any },
    opts: { allowSubstitute?: boolean },
  ) => Promise<P | null>
  authorize: (
    principal: P | null,
    requirement: Requirement<P, G>,
    level: Level,
    ctx: PolicyContext,
  ) => Promise<boolean>
  /** Requirement applied to routes with no `auth:`; secure by default (e.g. `[hasRole('ROLE_SUPER_ADMIN')]`). */
  defaultRequirement: Requirement<P, G>
}

/** The slice of the Elysia context the gate reads, plus the stamps it leaves on it. */
interface GateContext<P, G extends string> extends PolicyContext {
  request: Request
  set: { status?: number | string }
  auth?: { user: P | null }
  [REQUIREMENT]?: Requirement<P, G> | false
  [DECIDED]?: true
}

// The macro only stamps the route's requirement; one local beforeHandle enforces it, so routes added through `group`, `guard`, `use`, `route`, `all` or `ws` fall back to `defaultRequirement` too.
/** Builds the Elysia auth surface, to mount before any route: routes fall back to `defaultRequirement`, override with `auth: <Requirement>`, opt out with `auth: false`. Answers 401 to an anonymous caller and 403 to a signed-in one who is denied. */
export function createAuthPlugin<P, G extends string>(deps: AuthPluginDeps<P, G>) {
  return (opts: { allowSubstitute?: boolean } = {}) => (app: Elysia) =>
    app
      .derive({ as: 'scoped' }, async ({ cookie, headers }) => ({
        auth: { user: await deps.resolvePrincipal({ cookie, headers }, opts) },
      }))
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

        // A route nested in two authed instances runs this twice; the first pass already decided.
        if (requirement === false || ctx[DECIDED])
          return

        const user = ctx.auth?.user ?? null
        const level: Level = READ_METHODS.has(ctx.request.method) ? 'read' : 'write'
        const ok = await deps.authorize(user, requirement, level, { params: ctx.params, body: ctx.body, query: ctx.query })

        if (ok) {
          ctx[DECIDED] = true

          return
        }

        ctx.set.status = user === null ? 401 : 403

        return user === null ? 'Unauthorized' : 'Forbidden'
      })
}
