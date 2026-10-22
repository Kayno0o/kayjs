import type { Guard, GuardContext } from 'kay'
import { log } from './log'

// The part of kayjs-auth's `ctx.locals.auth` the cms reads: found by its shape, so the cms works without it installed.
interface AuthLike {
  bareUser?: () => Promise<MemberLike | null>
  user?: () => Promise<MemberLike | null>
  isGranted?: (role: string, user: MemberLike) => boolean
  signInUrl?: (back?: string) => string
  signOut?: () => Promise<void>
  requireUser?: (options: { require: string }) => Promise<unknown>
}

interface MemberLike {
  id?: unknown
  email?: unknown
  username?: unknown
  roles?: unknown
}

export function authOf(ctx: GuardContext): AuthLike | undefined {
  const auth = (ctx.locals as { auth?: unknown } | undefined)?.auth

  return typeof auth === 'object' && auth !== null && (typeof (auth as AuthLike).bareUser === 'function' || typeof (auth as AuthLike).user === 'function') ? auth : undefined
}

let unauthed = false

// What `cms({ role })` guards with: kayjs-auth's `requireUser({ require: role })`, so the app's `authorize` decides as in `auth.guard()`; a request with no kayjs-auth in its locals is refused, never let through.
export function roleGuard(role: string): Guard {
  return async (ctx) => {
    const auth = authOf(ctx)

    if (typeof auth?.requireUser !== 'function') {
      if (!unauthed) {
        unauthed = true
        log.error(`cms({ role: '${role}' }) found no kayjs-auth on the request, so it refuses every editor: list auth() in the extensions of kay.config.ts, or give cms({ guard }) instead`)
      }

      return ctx.deny(403)
    }

    await auth.requireUser({ require: role })
  }
}
