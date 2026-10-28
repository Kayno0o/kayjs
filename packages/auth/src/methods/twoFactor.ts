import type { Off } from '../core'
import type { PasskeyOptionsResult } from '../passkeys'
import type { Proof } from '../proof'
import type { RequestState } from '../state'
import type { DisableTwoFactorResult, EnableTwoFactorResult, RecoveryCodesResult, SetUpTwoFactorResult, TwoFactorResult } from '../twoFactor'
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '../webauthn'
import { OFF } from '../core'
import { load } from '../load'
import { challenged } from '../proof'

// `auth.twoFactor`: the second factor of a sign-in, and setting up an authenticator app; setting up answers `off` with `twoFactor: false`, a passkey answer with `passkeys: false`.
export class TwoFactorMethods {
  constructor(private readonly state: RequestState) {}

  // Whether this session holds a sign-in waiting for its second factor, for the page that asks for it.
  async pending(): Promise<boolean> {
    return challenged(this.state)
  }

  // Finishes a sign-in waiting for its second factor with an authenticator code or a recovery code.
  async verify(code: string): Promise<TwoFactorResult> {
    return (await load.twoFactor()).verifyTwoFactor(this.state, code, this.state.establish)
  }

  // A secret for the signed-in user's authenticator, as text and as a QR code; the second factor turns on once `enable` gets a code from it.
  async setUp(proof: Proof): Promise<SetUpTwoFactorResult | Off> {
    return !this.state.core.switches.twoFactor ? OFF : (await load.twoFactor()).setUpTwoFactor(this.state, proof)
  }

  // Turns the second factor on with a code from the authenticator just set up; answers the recovery codes, to show this once.
  async enable(code: string): Promise<EnableTwoFactorResult | Off> {
    return !this.state.core.switches.twoFactor ? OFF : (await load.twoFactor()).enableTwoFactor(this.state, code)
  }

  async disable(proof: Proof): Promise<DisableTwoFactorResult> {
    return (await load.twoFactor()).disableTwoFactor(this.state, proof)
  }

  // A new set of recovery codes, the old ones void.
  async regenerateRecoveryCodes(proof: Proof): Promise<RecoveryCodesResult> {
    return (await load.twoFactor()).regenerateRecoveryCodes(this.state, proof)
  }

  // How many unused recovery codes the signed-in user has, to warn when few are left.
  async recoveryCodesLeft(): Promise<number> {
    const record = await this.state.current()

    return record ? this.state.core.store.recoveryCodes.count(record.id) : 0
  }

  // The options for answering a pending sign-in's second factor with a passkey; `none` when the user has none.
  async passkeyOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.state.core.switches.passkeys ? OFF : (await load.passkeys()).twoFactorPasskeyOptions(this.state)
  }

  async verifyPasskey(response: AuthenticationResponseJSON): Promise<TwoFactorResult | Off> {
    if (!this.state.core.switches.passkeys)
      return OFF

    return (await load.passkeys()).verifyTwoFactorPasskey(this.state, response, this.state.establish)
  }
}
