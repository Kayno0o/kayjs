import type { AuthRequirement } from './auth'
import { guard as kayGuard } from 'kay'
import { Auth } from './auth'

/** What `guard()` takes, as `auth.guard()` does: where an anonymous visitor goes, the requirement a user meets and the scope a token holds. */
export interface GuardOptions {
  redirect?: string | undefined
  require?: AuthRequirement<string> | undefined
  scope?: string | string[] | false | undefined
}

// The `auth.guard()` of the app's `auth()`, for a `_guard.ts` with no module to import it from: `export default guard()`. It asks the `auth` of the request, so it works with a `createAuth` of the app's own too.
export function guard(options: GuardOptions = {}) {
  return kayGuard<{ auth: Auth }>(async (ctx) => {
    const { auth } = ctx.locals

    if (!(auth instanceof Auth))
      throw new Error('kayjs-auth: no `auth` in this context; add auth() to kay.config.ts, or `.use(auth.plugin)` before the routes')

    await auth.guarded(ctx, options as Parameters<Auth['guarded']>[1])
  })
}
