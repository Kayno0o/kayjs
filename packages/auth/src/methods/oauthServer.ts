import type { ApprovedClient } from '../authorize/grants'
import type { AuthorizeOutcome, AuthorizeParams } from '../authorize/request'
import type { Result } from '../failure'
import type { RequestState } from '../state'
import { protectedResourceMetadata, rootIsFixed, rootUsable, siteRoot } from '../authorize/metadata'
import { failed } from '../failure'
import { load } from '../load'

// `auth.oauthServer`: the consent page MCP clients send the user to, and the apps they approved.
export class OAuthServerMethods {
  constructor(private readonly state: RequestState, private readonly request: Request) {}

  // What the authorization endpoint does with an MCP client's request: send the visitor to sign in, show the consent page, or go back to the client with a code once they approved it for these scopes.
  async authorize(params: AuthorizeParams): Promise<AuthorizeOutcome> {
    return this.state.core.oauthServer ? (await load.request()).authorize(this.state, params, siteRoot(this.state.core, this.request)) : { kind: 'error', error: 'client' }
  }

  // The user's answer on the consent page, checked again as the request is: where the browser goes next.
  async decide(fields: AuthorizeParams, allow: boolean): Promise<Result<{ redirect: string }, 'client' | 'redirect_uri' | 'signed-out'>> {
    return this.state.core.oauthServer ? (await load.request()).decide(this.state, fields, allow, siteRoot(this.state.core, this.request)) : failed('client')
  }

  // The RFC 9728 metadata of the protected resource `name` served at `path`, which kay's MCP endpoint asks for; null while the OAuth server is off. It points MCP clients at the app's own authorization server.
  resource(path: string, name: string): Record<string, unknown> | null {
    if (!this.state.core.oauthServer || !rootUsable(this.state.core))
      return null

    const root = siteRoot(this.state.core, this.request)

    return protectedResourceMetadata(this.state.core, root, `${root}${path}`, name)
  }

  // The origin the OAuth documents are served at, which kay's 401 pointer to them names; undefined while the OAuth server is off.
  origin(): string | undefined {
    return this.state.core.oauthServer && rootUsable(this.state.core) ? new URL(siteRoot(this.state.core, this.request)).origin : undefined
  }

  // Whether that origin is configured, so the documents may be cached for everyone; else it is the request's own.
  fixed(): boolean {
    return rootIsFixed(this.state.core)
  }

  // The apps the signed-in user approved to act as them.
  async listClients(): Promise<ApprovedClient[]> {
    return (await load.grants()).approvedClients(this.state)
  }

  // Takes an app's approval back with every token it was given; refused with `not-found` when there was none, and `signed-out` outside the user's own session.
  async revokeGrant(clientId: string): Promise<Result<object, 'signed-out' | 'not-found'>> {
    return (await load.grants()).revokeClient(this.state, clientId)
  }

  /** @deprecated Use `oauthServer.listClients`. Removed in 1.108.0; `deprecated-auth-methods` rewrites it. */
  async clients(...args: Parameters<OAuthServerMethods['listClients']>): ReturnType<OAuthServerMethods['listClients']> {
    return this.listClients(...args)
  }
}
