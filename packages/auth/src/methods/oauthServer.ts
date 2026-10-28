import type { ApprovedClient, RevokeGrantResult } from '../authorize/grants'
import type { AuthorizeOutcome, AuthorizeParams, DecideResult } from '../authorize/request'
import type { RequestState } from '../state'
import { siteRoot } from '../authorize/metadata'
import { load } from '../load'

// `auth.oauthServer`: the consent page MCP clients send the user to, and the apps they approved.
export class OAuthServerMethods {
  constructor(private readonly state: RequestState, private readonly request: Request) {}

  // What the authorization endpoint does with an MCP client's request: send the visitor to sign in, show the consent page, or go back to the client with a code once they approved it for these scopes.
  async authorize(params: AuthorizeParams): Promise<AuthorizeOutcome> {
    return this.state.core.oauthServer ? (await load.request()).authorize(this.state, params, siteRoot(this.state.core, this.request)) : { kind: 'error', error: 'client' }
  }

  // The user's answer on the consent page, checked again as the request is: where the browser goes next.
  async decide(fields: AuthorizeParams, allow: boolean): Promise<DecideResult> {
    return this.state.core.oauthServer ? (await load.request()).decide(this.state, fields, allow, siteRoot(this.state.core, this.request)) : { ok: false, error: 'client' }
  }

  // The apps the signed-in user approved to act as them.
  async clients(): Promise<ApprovedClient[]> {
    return (await load.grants()).approvedClients(this.state)
  }

  // Takes an app's approval back with every token it was given; refused with `not-found` when there was none, and `signed-out` outside the user's own session.
  async revokeGrant(clientId: string): Promise<RevokeGrantResult> {
    return (await load.grants()).revokeClient(this.state, clientId)
  }
}
