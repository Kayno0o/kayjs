import type { BareUser, Core, SignedIn } from './core'
import type { RequestState } from './state'
import type { PolicyContext } from './types'
import { localPath } from 'kay'
import { isNavigation, withBack } from './core'

export interface TwoFactorAsk {
  // true asks every user, as a guard's own `twoFactor: true`; else the `twoFactor.require` of the app decides by the user's roles.
  wanted?: true | undefined
  // The path asked for: the security page, the second-factor page and the sign-out route are never held back, so a user lacking two-factor can always turn it on.
  path?: string | undefined
  // The locale the page is served in, whose prefix the path may carry.
  locale?: string | undefined
  ctx?: PolicyContext | undefined
}

// The pages and routes a user lacking two-factor must still reach: exactly those paths, bare or under the prefix of the locale being served, never a route that merely ends like one.
function exempt(core: Core, path: string, locale?: string): boolean {
  const bare = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  return [core.securityPage, core.twoFactorPage, `${core.prefix}/sign-out`].some(page => page !== undefined && (bare === page || (locale !== undefined && bare === `/${locale}${page}`)))
}

// Whether the second factor is satisfied: it is on, or the sign-in was a passkey (user verification makes it two factors), or an admin acting as the user, who proved theirs to start.
function satisfied(user: BareUser, signedIn: SignedIn | undefined): boolean {
  return user.twoFactor || signedIn?.passkey === true || signedIn?.impersonator !== undefined
}

// Whether `user` must have two-factor and does not. A guest and a session or OAuth sign-in with no authenticator app lack it; a throwing predicate in `twoFactor.require` throws, so the request fails closed. Off with `twoFactor: false`.
export async function lacksTwoFactor(state: RequestState, user: BareUser, ask: TwoFactorAsk = {}): Promise<boolean> {
  const { core } = state

  if (!core.switches.twoFactor || user.twoFactor || (ask.path !== undefined && exempt(core, ask.path, ask.locale)))
    return false

  if (satisfied(user, await state.session.get('auth')))
    return false

  if (ask.wanted === true)
    return true

  return core.twoFactorRequire !== undefined && core.access.authorize(user, core.twoFactorRequire, 'write', ask.ctx ?? {})
}

// What `ctx.redirect` and `ctx.deny` are in a guard, a page or an action.
export interface Stoppers {
  redirect: (location: string) => never
  deny: (status?: number, message?: string) => never
}

// A page opening goes to the security page to turn two-factor on, coming back after; anything else, and an app with no such page, gets the 403.
export function sendToEnrolment(core: Core, request: Request, { redirect, deny }: Stoppers): never {
  if (core.securityPage !== undefined && isNavigation(request)) {
    const here = new URL(request.url)

    // kay-allow external-redirect: the app's own security page, the visited path rides in its query
    redirect(withBack(core.securityPage, localPath(here.pathname + here.search, '/')))
  }

  return deny(403, 'Two-factor authentication is required')
}
