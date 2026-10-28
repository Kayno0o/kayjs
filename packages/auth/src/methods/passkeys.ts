import type { Off } from '../core'
import type { Passkey, PasskeyOptionsResult, PasskeySignInResult, RegisterPasskeyResult, RenamePasskeyResult, RevokePasskeyResult } from '../passkeys'
import type { Proof, ProofFailure } from '../proof'
import type { SignInOptions } from '../signInOptions'
import type { RequestState } from '../state'
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '../webauthn'
import { configError } from 'kay/library'
import { OFF } from '../core'
import { load } from '../load'
import { chooseRemember } from '../sessions'

// `auth.passkeys`: making passkeys, signing in and re-proving with one; making one and signing in answer `off` with `passkeys: false`.
export class PasskeyMethods {
  constructor(private readonly state: RequestState) {}

  // The options for `makePasskey` of `@kaynooo/kayjs-auth/browser`, to make a passkey for the signed-in user once `proof` re-proves them, the second factor when it is on.
  async registrationOptions(proof: Proof): Promise<PasskeyOptionsResult<PublicKeyCredentialCreationOptionsJSON, ProofFailure | Off['error']>> {
    return !this.state.core.switches.passkeys ? OFF : (await load.passkeys()).passkeyRegistrationOptions(this.state, proof)
  }

  // Keeps the passkey `makePasskey` made, under `name` or the browser and system it was made on.
  async register(response: RegistrationResponseJSON, name?: string): Promise<RegisterPasskeyResult | Off> {
    return !this.state.core.switches.passkeys ? OFF : (await load.passkeys()).registerPasskey(this.state, response, name)
  }

  async list(): Promise<Passkey[]> {
    return (await load.passkeys()).listPasskeys(this.state)
  }

  // Renames one of the signed-in user's passkeys; refused with `not-found` for one that is not theirs and `invalid-name` for a blank name.
  async rename(id: string, name: string): Promise<RenamePasskeyResult> {
    return (await load.passkeys()).renamePasskey(this.state, id, name)
  }

  async revoke(id: string, proof: Proof): Promise<RevokePasskeyResult> {
    return (await load.passkeys()).removePasskey(this.state, id, proof)
  }

  // The options for `askPasskey` of `@kaynooo/kayjs-auth/browser`, naming no account; with its `autofill` the browser offers the passkeys in the sign-in field's autofill.
  async signInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!this.state.core.switches.passkeys)
      throw configError('passkeys are switched off: `passkeys: false` in the options of createAuth or auth()')

    return (await load.passkeys()).passkeySignInOptions(this.state)
  }

  // Signs in with the passkey that answered `signInOptions`, with no second factor after it.
  async signIn(response: AuthenticationResponseJSON, options: Pick<SignInOptions, 'redirect' | 'remember'> = {}): Promise<PasskeySignInResult | Off> {
    if (!this.state.core.switches.passkeys)
      return OFF

    await chooseRemember(this.state, options.remember)

    return (await load.passkeys()).signInWithPasskey(this.state, response, options.redirect, this.state.establish)
  }

  // The options for re-proving with a passkey, its answer then passed as `{ passkey }` wherever a proof is asked.
  async proofOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.state.core.switches.passkeys ? OFF : (await load.passkeys()).passkeyProofOptions(this.state)
  }
}
