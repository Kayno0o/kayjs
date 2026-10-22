import type { BareUser } from './core'
import type { CreateUserInput } from './password'
import { builtOwn } from './own'

interface Site { cookies: Bun.CookieMap }

// What `auth.test(site)` gives.
export interface AuthTest {
  // Signs the site in as a member, made when none has that email or username; `data` holds the fields of the app's `user` schema.
  signInAs: (who: Omit<CreateUserInput, 'roles'> & { roles?: string[] | undefined, data?: object | undefined }) => Promise<BareUser>
  // Signs the site out, its other cookies kept.
  signOut: () => void
  // The `Cookie` header of a new session signed in as that user.
  sessionCookie: (userId: string, options?: { secure?: boolean }) => Promise<string>
}

export interface OwnTest {
  test: (site: Site) => AuthTest
}

// The `auth.test(site)` of an app whose kay.config.ts holds `auth()` and no `src/auth.ts` module: the auth that site's `testSite()` built, found as a call needs it, so call it after `testSite()`.
export function authTest(site: Site): AuthTest {
  const made = () => {
    const own = builtOwn(site)

    if (!own)
      throw new Error('kayjs-auth: authTest found no `auth()` built for this test site: await `testSite()` first, and give `authTest` the site it returned, of a project whose kay.config.ts registers `auth()` with no `module`')

    return own.test(site)
  }

  return {
    signInAs: async who => made().signInAs(who),
    signOut: () => made().signOut(),
    sessionCookie: async (userId, options) => made().sessionCookie(userId, options),
  }
}
