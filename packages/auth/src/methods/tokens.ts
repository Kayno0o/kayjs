import type { BearerToken, TokenOptions, TokenProblem } from '../bearer'
import type { Result } from '../failure'
import type { Proof, ProofFailure } from '../proof'
import type { RequestState } from '../state'
import { scopeAllows } from '../gate'
import { load } from '../load'

// `auth.tokens`: the signed-in user's bearer tokens, for their devices and API clients.
export class TokenMethods<Scope extends string = string> {
  constructor(private readonly state: RequestState, private readonly held: () => Promise<string[] | null>) {}

  // The scopes of the bearer token this request came with; null for a session, or a token with every scope.
  async scopes(): Promise<string[] | null> {
    return this.held()
  }

  // Whether this request may reach what `scope` guards: a session may, and a token given that scope or every one.
  async hasScope(scope: Scope): Promise<boolean> {
    return scopeAllows(await this.held(), scope)
  }

  // A bearer token for a device or an API client of the signed-in user, shown this once; minted from a session only, never from another token.
  async create(proof: Proof, label: string, options: TokenOptions<Scope> = {}): Promise<Result<{ token: string, id: string }, ProofFailure | TokenProblem>> {
    return (await load.bearer()).createToken(this.state, proof, label, options)
  }

  // The signed-in user's bearer tokens, without the tokens themselves.
  async list(): Promise<BearerToken[]> {
    return (await load.bearer()).listTokens(this.state)
  }

  // Revokes one of the signed-in user's bearer tokens, from a browser session only: `signed-out` through a token, `not-found` for one that is not theirs.
  async revoke(id: string): Promise<Result<object, 'signed-out' | 'not-found'>> {
    return (await load.bearer()).revokeToken(this.state, id)
  }
}
