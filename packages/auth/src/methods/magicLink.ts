import type { Off } from '../core'
import type { Result } from '../failure'
import type { SignInOptions } from '../signInOptions'
import type { RequestState } from '../state'
import { OFF } from '../core'
import { load } from '../load'
import { chooseRemember } from '../sessions'

// `auth.magicLink`: sign-in links and codes mailed to the address; each answers `off` with `magicLink: false`.
export class MagicLinkMethods {
  constructor(private readonly state: RequestState) {}

  // Mails a sign-in link to that address when an account has it; answers alike when none does. `remember` holds for the link opened in this browser, or the code typed in it.
  async request(email: string, options: SignInOptions = {}): Promise<Result<object, 'limited' | 'captcha' | 'unavailable'> | Off> {
    if (!this.state.core.switches.magicLink)
      return OFF

    await chooseRemember(this.state, options.remember)

    return (await load.email()).requestMagicLink(this.state, email, options.redirect, options.captcha)
  }

  // Spends a magic link's token, signing its user in.
  async signIn(token: string): Promise<Result<{ redirect: string }, 'invalid' | 'limited' | 'banned'> | Off> {
    return !this.state.core.switches.magicLink ? OFF : (await load.email()).signInWithMagicLink(this.state, token)
  }

  /** @deprecated Use `email.signInWithCode`. Removed in 1.108.0; `deprecated-auth-methods` rewrites it. */
  async signInWithCode(code: string): Promise<Result<{ redirect: string }, 'invalid' | 'expired' | 'limited' | 'banned'> | Off> {
    return !this.state.core.switches.magicLink ? OFF : (await load.email()).signInWithEmailCode(this.state, code)
  }
}
