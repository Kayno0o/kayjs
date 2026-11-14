import type { SignInHook } from 'kay/test'
import type { BareUser } from './core'
import type { CreateUserInput } from './password'
import type { AuthTest } from './test'

declare module 'kay/test' {
  interface SignInFields extends Omit<CreateUserInput, 'roles'> {
    // The roles of the member `site.signInAs` makes, with the `email` or `username` kayjs-auth reads.
    roles?: string[] | undefined
    // The fields of the app's `user` schema.
    data?: object | undefined
  }

  interface SignedIn {
    // The member the site was signed in as.
    user?: BareUser | undefined
  }
}

// The part `site.signInAs` and `site.signOut` take in auth: a `who` with an `email` or a `username` signs a member in.
export function signInHook(as: Pick<AuthTest, 'signInAs' | 'signOut'>): SignInHook {
  return {
    name: 'auth',
    signIn: async (who) => {
      const { email, username } = who as { email?: string, username?: string }

      return email === undefined && username === undefined ? undefined : { user: await as.signInAs(who) }
    },
    signOut: () => as.signOut(),
  }
}
