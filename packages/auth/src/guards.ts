import type { Guard } from 'kay'
import type { BareUser, Core } from './core'
import type { ScopeRequirement } from './gate'
import type { AuthRequirement } from './request'
import type { PolicyContext, Predicate } from './types'
import { READ_METHODS } from 'kay/library'
import { guardPageOf, isNavigation, withBack } from './core'
import { authGate, scopeAllows } from './gate'
import { load } from './load'
import { authOf, STATE } from './request'
import { lacksTwoFactor, sendToEnrolment } from './requiredTwoFactor'

export interface RouteGuardOptions<Role extends string, Scope extends string> {
  redirect?: string | undefined
  require?: AuthRequirement<Role> | undefined
  scope?: ScopeRequirement<Scope> | undefined
  // true asks every user this guard lets through for two-factor; left out, `twoFactor.require` of the app decides. The security page and the second-factor page are never held back, whatever guard runs.
  twoFactor?: true | undefined
}

const signedIn: Predicate<BareUser> = user => user !== null

// A `_guard.ts` default export. An anonymous GET or HEAD that may be a page opening (not a browser fetch, nor a request for JSON) goes to `redirect`, the prebuilt sign-in page with `pages`, else `signInPage`, with where they were going as `?redirect=`, or gets a 401 without any, as does any post; a user who does not meet `require` gets a 403.
// A scoped bearer token passes only with one of `scope`. A user lacking a two-factor the app asks of them (`twoFactor`) goes to the security page when opening a page, else gets a 403.
export function guardOf<Role extends string, Scope extends string>(core: Core, options: RouteGuardOptions<Role, Scope> = {}): Guard {
  const redirect = options.redirect === undefined || options.redirect === '' ? guardPageOf(core) : options.redirect

  return async (ctx) => {
    const user = await authOf(ctx.locals).bareUser()
    const reading = READ_METHODS.has(ctx.request.method)

    if (!user) {
      if (redirect !== undefined && isNavigation(ctx.request))
        // kay-allow external-redirect: `redirect` is the app's own sign-in page, the visited path rides in its query
        ctx.redirect(withBack(redirect, ctx.url.pathname + ctx.url.search))

      ctx.deny(401, 'Sign in to continue')
    }

    // kay before 1.23 gives a guard no params, and `memberOf` then refuses rather than skip the check.
    if (options.require !== undefined && !(await core.access.authorize(user, options.require, reading ? 'read' : 'write', { params: ctx.params })))
      ctx.deny(403)

    if (!scopeAllows(await authOf(ctx.locals).scopes(), options.scope))
      ctx.deny(403)

    if (user !== null && await lacksTwoFactor(authOf(ctx.locals)[STATE], user, { wanted: options.twoFactor, path: ctx.url.pathname, locale: ctx.locale, ctx: { params: ctx.params } }))
      sendToEnrolment(core, ctx.request, ctx)
  }
}

// The gate of `auth.gate()`, before the plugin is used on the instance it closes.
export function gateOf<Role extends string, Scope extends string>(core: Core, options: { require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> }) {
  return authGate<BareUser, Role, Scope>({
    principal: async ctx => authOf(ctx).bareUser(),
    authorize: core.access.authorize,
    // A user lacking the two-factor the app asks of them is denied like one missing a role, bar the library's own enrolment pages.
    refuse: async (ctx, user) => lacksTwoFactor(authOf(ctx)[STATE], user, { path: new URL((ctx as { request: Request }).request.url).pathname, ctx: { params: (ctx as PolicyContext).params, body: (ctx as PolicyContext).body, query: (ctx as PolicyContext).query } }),
    defaultRequirement: options.require ?? signedIn,
    scopes: async ctx => authOf(ctx).scopes(),
    defaultScope: options.scope,
  })
}

// A requirement met by a member of the organization the route's `param` names, by id or slug, holding `role` there when given: `auth: auth.memberOf('admin')`.
export function memberOf<OrgRole extends string>(core: Core, role?: OrgRole, options: { param?: string } = {}): Predicate<BareUser> {
  return async (user, ctx) => {
    const ref: unknown = ctx.params?.[options.param ?? core.organizations?.param ?? 'org']

    return user !== null && typeof ref === 'string' && (await load.organizations()).holdsInOrganization(core, user.id, ref, role)
  }
}
