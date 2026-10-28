import type { Off } from '../core'
import type { CodeResult, LinkResult, MailRequestResult } from '../email'
import type { SignInOptions } from '../signInOptions'
import type { RequestState } from '../state'
import { OFF } from '../core'
import { load } from '../load'
import { chooseRemember } from '../sessions'

// `auth.magicLink`: sign-in links and codes mailed to the address; each answers `off` with `magicLink: false`.
export class MagicLinkMethods {
  constructor(private readonly state: RequestState) {}

  // Mails a sign-in link to that address when an account has it; answers alike when none does. `remember` holds for the link opened in this browser, or the code typed in it.
  async request(email: string, options: SignInOptions = {}): Promise<MailRequestResult | Off> {
    if (!this.state.core.switches.magicLink)
      return OFF

    await chooseRemember(this.state, options.remember)

    return (await load.email()).requestMagicLink(this.state, email, options.redirect, options.captcha)
  }

  // Spends a magic link's token, signing its user in.
  async signIn(token: string): Promise<LinkResult | Off> {
    return !this.state.core.switches.magicLink ? OFF : (await load.email()).signInWithMagicLink(this.state, token)
  }

  // Signs in with the code a magic link mail carried, typed in the browser that asked for it.
  async signInWithCode(code: string): Promise<CodeResult | Off> {
    return !this.state.core.switches.magicLink ? OFF : (await load.email()).signInWithEmailCode(this.state, code)
  }
}
