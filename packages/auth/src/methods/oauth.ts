import type { Result } from '../failure'
import type { Proof, ProofFailure } from '../proof'
import type { RequestState } from '../state'
import { failed } from '../failure'
import { load } from '../load'

// `auth.oauth`: the providers the signed-in user signs in with.
export class OAuthMethods {
  constructor(private readonly state: RequestState, private readonly forget: () => void) {}

  // Where to send the browser to link `provider` to the signed-in user once `proof` re-proves them, the second factor when it is on; it comes back to `redirect`.
  async link(provider: string, proof: Proof, options: { redirect?: string } = {}): Promise<Result<{ url: string }, ProofFailure | 'not-found' | 'unavailable'>> {
    return this.state.core.oauth.has(provider) ? (await load.flow()).startLink(this.state, provider, proof, options.redirect) : failed('not-found')
  }

  // Unlinks a provider from the signed-in user, unless it is their last way in.
  async unlink(provider: string, proof: Proof): Promise<Result<object, ProofFailure | 'not-linked' | 'last-way-in'>> {
    this.forget()

    return (await load.account()).unlink(this.state, provider, proof)
  }

  // The providers the signed-in user has linked.
  async identities(): Promise<string[]> {
    const record = await this.state.current()

    return record ? (await this.state.core.store.identities.listByUser(record.id)).map(identity => identity.provider) : []
  }

  // A fresh access token for the signed-in user's account at `provider`, refreshed when about to expire; null without one, or once the provider refuses a refresh.
  async providerToken(provider: string): Promise<string | null> {
    return (await load.flow()).providerToken(this.state, provider)
  }
}
