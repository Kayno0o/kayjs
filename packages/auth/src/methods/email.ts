import type { Off } from '../core'
import type { PendingEmailCode } from '../email'
import type { Result } from '../failure'
import type { Proof, ProofFailure } from '../proof'
import type { EmailProblem } from '../rules'
import type { RequestState } from '../state'
import { OFF } from '../core'
import { load } from '../load'

// `auth.email`: verifying the address and changing it.
export class EmailMethods {
  constructor(private readonly state: RequestState) {}

  // Mails a new link verifying the address to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of with an 'unverified' answer.
  async sendVerification(): Promise<Result<object, 'limited' | 'captcha' | 'unavailable' | 'signed-out' | 'verified'>> {
    return (await load.email()).sendVerification(this.state)
  }

  // Spends a verification link's token in the browser signed in as the account, that registered it or that proved its password, or given the account's password: `{ ok: false, error: { code: 'confirm' } }` asks for one of them, the link still usable.
  async verify(token: string, password?: string): Promise<Result<{ redirect: string }, 'invalid' | 'limited' | 'banned' | 'confirm'>> {
    return (await load.email()).verifyEmail(this.state, token, password)
  }

  // Signs in with the code a magic link mail carried, typed in the browser that asked for it.
  async signInWithCode(code: string): Promise<Result<{ redirect: string }, 'invalid' | 'expired' | 'limited' | 'banned'> | Off> {
    return !this.state.core.switches.magicLink ? OFF : (await load.email()).signInWithEmailCode(this.state, code)
  }

  // Verifies the address with the code its verification mail carried, typed in the browser that asked for it.
  async verifyCode(code: string): Promise<Result<{ redirect: string }, 'invalid' | 'expired' | 'limited' | 'banned'>> {
    return (await load.email()).verifyEmailCode(this.state, code)
  }

  // The code this browser waits for, sign-in or verification, and the address it went to; null when none.
  async pendingCode(): Promise<PendingEmailCode> {
    return (await load.email()).pendingCode(this.state)
  }

  // Mails the signed-in user's new address a link confirming it.
  async change(proof: Proof, email: string): Promise<Result<object, ProofFailure | 'unavailable', { email: EmailProblem | 'taken' | 'unchanged' }>> {
    return (await load.email()).changeEmail(this.state, proof, email)
  }

  // Spends an email change link's token: the account moves to the new address, and the user's other sessions end.
  async confirmChange(token: string): Promise<Result<{ redirect: string }, 'invalid' | 'limited' | 'banned'>> {
    return (await load.email()).confirmEmailChange(this.state, token)
  }
}
