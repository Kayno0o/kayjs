import type { ChangePasswordResult } from '../account'
import type { Off } from '../core'
import type { MailRequestResult, ResetPasswordResult } from '../email'
import type { PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from '../password'
import type { Proof } from '../proof'
import type { SignInOptions } from '../signInOptions'
import type { RequestState } from '../state'
import { OFF } from '../core'
import { load } from '../load'
import { chooseRemember } from '../sessions'

// `auth.password`: registering, signing in, resets and changes; each answers `off` with `password: false`.
export class PasswordMethods {
  constructor(private readonly state: RequestState) {}

  // A new user with an email and a password, signed in on this session; field errors come back as codes. With `redirect`, the mail verifying the address leads on to that page.
  async register(input: RegisterInput, options?: Pick<SignInOptions, 'remember' | 'captcha' | 'redirect'>): Promise<RegisterResult | Off> {
    if (!this.state.core.switches.password)
      return OFF

    await chooseRemember(this.state, options?.remember)

    return (await load.password()).register(this.state, input, options)
  }

  // Signs in with an email or a username and a password; a wrong password and an unknown account answer alike.
  async signIn(input: PasswordSignInInput, options?: SignInOptions): Promise<PasswordSignInResult | Off> {
    if (!this.state.core.switches.password)
      return OFF

    await chooseRemember(this.state, options?.remember)

    return (await load.password()).signInWithPassword(this.state, input, options ?? {})
  }

  // Mails a reset link to that address when an account has it; answers alike when none does. The reset signs in to `redirect` when given.
  async requestReset(email: string, options: Pick<SignInOptions, 'captcha' | 'redirect'> = {}): Promise<MailRequestResult | Off> {
    if (!this.state.core.switches.password)
      return OFF

    return (await load.email()).requestPasswordReset(this.state, email, options.captcha, options.redirect)
  }

  // Spends a reset link's token on a new password, signing the user out everywhere else and in here.
  async reset(token: string, password: string): Promise<ResetPasswordResult | Off> {
    return !this.state.core.switches.password ? OFF : (await load.email()).resetPassword(this.state, token, password)
  }

  // Sets the signed-in user's password, or a first one, and ends their other sessions.
  async change(proof: Proof, password: string): Promise<ChangePasswordResult | Off> {
    return !this.state.core.switches.password ? OFF : (await load.account()).changePassword(this.state, proof, password)
  }
}
