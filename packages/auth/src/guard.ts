import type { Auth, AuthRequirement } from './auth'
import { guard as kayGuard } from 'kay'

/** What `authGuard()` takes, as `auth.guard()` does: where an anonymous visitor goes, the requirement a user meets and the scope a token holds, and whether two-factor is asked of the user (see `twoFactor.require`). */
export interface GuardOptions {
  redirect?: string | undefined
  require?: AuthRequirement<string> | undefined
  scope?: string | string[] | false | undefined
  twoFactor?: true | undefined
}

// The `auth.guard()` of the app's `auth()`, for a `_guard.ts` with no module to import it from: `export default authGuard()`. It asks the `auth` of the request, so it works with a `authCore` of the app's own too.
export function authGuard(options: GuardOptions = {}) {
  return kayGuard<{ auth: Auth }>(async (ctx) => {
    const { auth } = ctx.locals

    if (typeof auth?.guarded !== 'function')
      throw new Error('kayjs-auth: no `auth` in this context; add auth() to kay.config.ts, or `.use(auth.plugin)` before the routes')

    await auth.guarded(ctx, options)
  })
}
