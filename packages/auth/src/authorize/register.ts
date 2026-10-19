import type { Core } from '../core'
import type { TokenReply } from './reply'
import { randomToken } from '../keys'
import { spend } from '../limits'
import { plainName } from './clients'
import { refused } from './reply'
import { validRedirectUris } from './uris'

// Dynamic client registration (RFC 7591): a public client names its redirect URIs and is given an ID, with no secret to keep.
export async function registerClient(core: Core, address: string, document: unknown): Promise<TokenReply> {
  const all = core.limits.oauthRegisterAll

  if (await spend(core.store, `oauth-register:${address}`, core.limits.oauthRegister) || (all !== undefined && await spend(core.store, 'oauth-register:all', all)))
    return refused('invalid_client_metadata', 'Too many registrations', 429)

  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return refused('invalid_client_metadata', 'The body must be a JSON object')

  const given = document as Record<string, unknown>
  const uris = given.redirect_uris

  if (!validRedirectUris(uris))
    return refused('invalid_redirect_uri', 'redirect_uris must be 1 to 10 https URLs or loopback http URLs, 2048 characters in all')

  if (given.token_endpoint_auth_method !== undefined && given.token_endpoint_auth_method !== 'none')
    return refused('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none) are supported')

  const name = plainName(given.client_name) ?? 'Unnamed client'
  const id = `kc_${randomToken()}`
  const createdAt = new Date()

  await core.store.oauth!.clients.create({ id, name, redirectUris: [...new Set(uris)], createdAt })

  return {
    status: 201,
    body: { client_id: id, client_id_issued_at: Math.floor(createdAt.getTime() / 1000), client_name: name, redirect_uris: [...new Set(uris)], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
  }
}
