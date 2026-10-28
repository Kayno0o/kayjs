import type { ChangeEmailResult, CodeResult, LinkResult, PendingEmailCode, SendVerificationResult, VerifyEmailResult } from '../email'
import type { Proof } from '../proof'
import type { RequestState } from '../state'
import { load } from '../load'

// `auth.email`: verifying the address and changing it.
export class EmailMethods {
  constructor(private readonly state: RequestState) {}

  // Mails a new link verifying the address to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of with an 'unverified' answer.
  async sendVerification(): Promise<SendVerificationResult> {
    return (await load.email()).sendVerification(this.state)
  }

  // Spends a verification link's token in the browser signed in as the account, that registered it or that proved its password, or given the account's password: `{ ok: false, error: 'confirm' }` asks for one of them, the link still usable.
  async verify(token: string, password?: string): Promise<VerifyEmailResult> {
    return (await load.email()).verifyEmail(this.state, token, password)
  }

  // Verifies the address with the code its verification mail carried, typed in the browser that asked for it.
  async verifyCode(code: string): Promise<CodeResult> {
    return (await load.email()).verifyEmailCode(this.state, code)
  }

  // The code this browser waits for, sign-in or verification, and the address it went to; null when none.
  async pendingCode(): Promise<PendingEmailCode> {
    return (await load.email()).pendingCode(this.state)
  }

  // Mails the signed-in user's new address a link confirming it.
  async change(proof: Proof, email: string): Promise<ChangeEmailResult> {
    return (await load.email()).changeEmail(this.state, proof, email)
  }

  // Spends an email change link's token: the account moves to the new address, and the user's other sessions end.
  async confirmChange(token: string): Promise<LinkResult> {
    return (await load.email()).confirmEmailChange(this.state, token)
  }
}
