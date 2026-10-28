import type { BearerToken, CreateTokenResult, RevokeTokenResult, TokenOptions } from '../bearer'
import type { Proof } from '../proof'
import type { RequestState } from '../state'
import { load } from '../load'

// `auth.tokens`: the signed-in user's bearer tokens, for their devices and API clients.
export class TokenMethods<Scope extends string = string> {
  constructor(private readonly state: RequestState) {}

  // A bearer token for a device or an API client of the signed-in user, shown this once; minted from a session only, never from another token.
  async create(proof: Proof, label: string, options: TokenOptions<Scope> = {}): Promise<CreateTokenResult> {
    return (await load.bearer()).createToken(this.state, proof, label, options)
  }

  // The signed-in user's bearer tokens, without the tokens themselves.
  async list(): Promise<BearerToken[]> {
    return (await load.bearer()).listTokens(this.state)
  }

  // Revokes one of the signed-in user's bearer tokens, from a browser session only: `signed-out` through a token, `not-found` for one that is not theirs.
  async revoke(id: string): Promise<RevokeTokenResult> {
    return (await load.bearer()).revokeToken(this.state, id)
  }
}
