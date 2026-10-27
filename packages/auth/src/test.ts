import type { BareUser } from './core'
import type { OAuthSite, OAuthTest } from './oauthTest'
import type { CreateUserInput } from './password'
import type { TotpEnrolment } from './twoFactor'
import { builtOwn } from './own'

// What `auth.test(site)` gives.
export interface AuthTest {
  // Signs the site in as a member, made when none has that email or username; `data` holds the fields of the app's `user` schema.
  signInAs: (who: Omit<CreateUserInput, 'roles'> & { roles?: string[] | undefined, data?: object | undefined }) => Promise<BareUser>
  // Signs the site out, its other cookies kept.
  signOut: () => void
  // The `Cookie` header of a new session signed in as that user.
  sessionCookie: (userId: string, options?: { secure?: boolean }) => Promise<string>
  // Turns two-factor on for that member as the app would, so a password sign-in asks for a code: the authenticator's `secret`, `code(offset?)` for the current step and the `recoveryCodes`, all usable at the next sign-in. Throws for a missing member or one who has it already.
  enrollTotp: (userId: string) => Promise<TotpEnrolment>
  // Signs in through an OAuth provider with no request to it: `await oauth.stub('discord', { id, email })` makes it answer with that account (or `{ error }` for a refused consent, a rejected code or a provider down), and `await oauth.signIn('discord')` leaves for it and comes back through the site, answering the callback's response.
  oauth: OAuthTest
}

export interface OwnTest {
  test: (site: OAuthSite) => AuthTest
}

// The `auth.test(site)` of an app whose kay.config.ts holds `auth()` and no `src/auth.ts` module: the auth that site's `testSite()` built, found as a call needs it, so call it after `testSite()`.
export function authTest(site: OAuthSite): AuthTest {
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
    enrollTotp: async userId => made().enrollTotp(userId),
    oauth: {
      stub: async (provider, outcome) => made().oauth.stub(provider, outcome),
      signIn: async (provider, options) => made().oauth.signIn(provider, options),
    },
  }
}
