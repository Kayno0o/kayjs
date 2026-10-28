import type { Elysia } from 'elysia'
import type { BareUser, Core } from './core'
import type { OAuthSite, OAuthTest } from './oauthTest'
import type { CreateUserInput } from './password'
import type { TotpEnrolment } from './twoFactor'
import { load } from './load'
import { dropSession } from './testCookies'

// Who `signInAs` signs in: `createUser`'s fields and the app's own user `data` fields.
export type TestMember<Role extends string, UserData extends object> = Omit<CreateUserInput, 'roles'> & { roles?: Role[] | undefined, data?: { [Field in keyof UserData]?: UserData[Field] | undefined } | undefined }

// The calls a test makes on the auth of its site, with no form round trip.
export function testHelpers<Role extends string, UserData extends object>(core: Core, plugin: Elysia) {
  const helpers = {
    // The `Cookie` header of a new session signed in as `userId`, as `signIn` makes it, for a test or a script to send by hand; throws for a missing or banned user.
    // The cookie is the one kay's server names for the scheme it sees: by default the plugin signs in over `http://localhost/`, so the server's own rule applies (an https `site` in kay.config.ts makes it `__Host-kay_session` in production); `secure: true` mints the one an https request reads, `secure: false` the plain one.
    async sessionCookie(userId: string, cookieOptions: { secure?: boolean } = {}): Promise<string> {
      return (await import('./testing')).mintSessionCookie(plugin, userId, cookieOptions.secure)
    },

    // Signs a test site in as a member, making them first when no user has their email or username, with no form round trip: `createUser`'s fields (`email`, `username`, `password`, `roles`, `emailVerified`, `locale`) for a new member, and the app's own user `data` fields. An existing member is signed in as they are, and throws when the email, username, roles or data given differ from theirs. It sets the session cookie in the site's cookie jar, so a second call switches member; returns the user.
    async signInAs(site: { cookies: Bun.CookieMap }, who: TestMember<Role, UserData>): Promise<BareUser> {
      return (await import('./testing')).signInAs(core, plugin, site, who)
    },

    // Turns two-factor on for a member as confirming a code would, for a test: it answers the authenticator's `secret`, `code(offset?)` for the current step and the `recoveryCodes`, all usable at the next sign-in. Throws for a missing member or one who has it already.
    async enrollTotp(userId: string): Promise<TotpEnrolment> {
      return (await load.twoFactor()).enrollTotp(core, userId)
    },

    // The provider calls of a test site: `await oauth.stub(provider, { id, email })` makes the provider answer with that account with no request leaving the test (or `{ error: 'access_denied' | 'invalid_grant' | 'server_error' }` a refused consent, a rejected code or a provider down), and `await oauth.signIn(provider)` leaves for it and comes back through the site, answering the callback's response.
    oauth(site: OAuthSite): OAuthTest {
      const made = async () => (await import('./oauthTest')).oauthTest(core, plugin, site)

      return {
        stub: async (provider, outcome) => (await made()).stub(provider, outcome),
        signIn: async (provider, options) => (await made()).signIn(provider, options),
      }
    },

    // Signs a test site out, however it was signed in, by dropping its session cookie: the site is anonymous again, its other cookies kept.
    signOut(site: { cookies: Bun.CookieMap }): void {
      dropSession(site.cookies)
    },
  }

  return {
    ...helpers,
    // The test calls on one test site, so a test names the site once: `const as = auth.test(site)`, then `await as.signInAs({ email })` and `as.signOut()`.
    test: (site: OAuthSite) => ({
      signInAs: async (who: TestMember<Role, UserData>) => helpers.signInAs(site, who),
      signOut: () => helpers.signOut(site),
      sessionCookie: async (userId: string, cookieOptions?: { secure?: boolean }) => helpers.sessionCookie(userId, cookieOptions),
      enrollTotp: async (userId: string) => helpers.enrollTotp(userId),
      oauth: helpers.oauth(site),
    }),
  }
}
