import type { Core } from '../core'
import type { TokenReply } from './reply'
import { digest } from '../keys'
import { spend } from '../limits'
import { refused } from './reply'

// RFC 7009: ends the session of the client that holds the token, access or refresh, with the rest of its family. It answers 200 for a token that is unknown, expired or another client's, so it tells nothing about tokens.
export async function revokeEndpoint(core: Core, address: string, form: URLSearchParams): Promise<TokenReply> {
  if (await spend(core.rates, `oauth-revoke:${address}`, core.limits.oauthToken))
    return refused('invalid_request', 'Too many requests', 429)

  const presented = form.get('token')
  const clientId = form.get('client_id')

  if (presented === null || presented === '' || clientId === null || clientId === '')
    return refused('invalid_request', 'token and client_id are required')

  const { bearerTokens, oauth } = core.store
  const key = digest(presented)
  const access = await bearerTokens.findByDigest(key)

  if (access?.oauth) {
    if (access.oauth.clientId === clientId)
      await oauth!.refresh.revokeFamily(access.userId, access.oauth.family)

    return { status: 200, body: {} }
  }

  // Looked at without spending it where the store can; a store without `get` can only spend it, which a holder of the token could do at the token endpoint too.
  const refresh = oauth!.refresh.get ? await oauth!.refresh.get(key) : (await oauth!.refresh.use(key, new Date()))?.token

  if (refresh?.clientId === clientId)
    await oauth!.refresh.revokeFamily(refresh.userId, refresh.family)

  return { status: 200, body: {} }
}
