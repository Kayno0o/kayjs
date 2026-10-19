import type { Core } from '../core'
import type { OAuthCodeRecord, OAuthGrantRecord, OAuthRefreshRecord } from '../store'
import type { TokenReply } from './reply'
import { createHash, timingSafeEqual } from 'node:crypto'
import { banned } from '../core'
import { digest, randomToken } from '../keys'
import { spend } from '../limits'
import { refused } from './reply'
import { covers, sameResource, sameSite } from './request'

// Seconds an access token works for, a refresh token unused, and a whole family of them from its first token.
export const ACCESS_LIFETIME = 60 * 60
export const REFRESH_LIFETIME = 30 * 24 * 60 * 60
export const FAMILY_LIFETIME = 90 * 24 * 60 * 60
const VERIFIER = /^[\w.~-]{43,128}$/
const WHITESPACE = /\s+/

function matches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)

  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

// A bearer token and a refresh token of one family for the grant, which is how `user()`, `via()` and `requireUser({ scope })` see the client; the family ends at `familyEnd` whatever its rotations.
async function issue(core: Core, grant: OAuthGrantRecord, scopes: string[] | null, family: string, familyEnd: Date | undefined, resource: string | null): Promise<TokenReply> {
  const oauth = core.store.oauth!
  const now = new Date()
  const access = randomToken()
  const refresh = randomToken()

  await core.store.bearerTokens.create({
    id: crypto.randomUUID(),
    userId: grant.userId,
    label: grant.clientName,
    digest: digest(access),
    scopes,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: new Date(now.getTime() + ACCESS_LIFETIME * 1000),
    oauth: { clientId: grant.clientId, family, resource },
  })
  await oauth.refresh.create({ digest: digest(refresh), userId: grant.userId, clientId: grant.clientId, scopes, family, resource, createdAt: now, expiresAt: familyEnd ?? new Date(now.getTime() + FAMILY_LIFETIME * 1000), usedAt: null })

  return {
    status: 200,
    body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_LIFETIME, refresh_token: refresh, ...scopes !== null && scopes.length > 0 && { scope: scopes.join(' ') } },
  }
}

// The resource the tokens are bound to: the one the code asked for, which a request may name again or leave out but not change or add. A reply when the request names another.
function boundResource(form: URLSearchParams, root: string, bound: string | null | undefined, legacy = false): { resource: string | null } | TokenReply {
  const asked = form.getAll('resource')

  if (asked.length === 0)
    return { resource: bound ?? null }

  if (asked.length > 1 || !sameSite(asked[0]!, root))
    return refused('invalid_target', 'The resource is not one of this server')

  // A refresh token stored before the column has no resource to compare, and a client names its resource on every refresh: it stays unbound.
  if (legacy && bound == null)
    return { resource: null }

  return bound != null && sameResource(asked[0]!, bound) ? { resource: bound } : refused('invalid_target', 'The resource is not the one the tokens were asked for')
}

// The grant the tokens are issued under, while its user can sign in and has not revoked the client.
async function liveGrant(core: Core, userId: string, clientId: string): Promise<OAuthGrantRecord | undefined> {
  const [grant, record] = await Promise.all([core.store.oauth!.grants.get(userId, clientId), core.store.users.get(userId)])

  return grant && record && !banned(record) ? grant : undefined
}

// What a code exchange asks for against the code: the resource the tokens are bound to, or the reply refusing a redirect_uri, a verifier or a resource the code does not hold.
function codeAsk(form: URLSearchParams, root: string, issued: OAuthCodeRecord, verifier: string): { resource: string | null } | TokenReply {
  if (issued.redirectUri !== form.get('redirect_uri'))
    return refused('invalid_grant', 'The code does not match this request')

  if (!VERIFIER.test(verifier) || !matches(verifier, issued.challenge))
    return refused('invalid_grant', 'The code_verifier does not match the code_challenge')

  return boundResource(form, root, issued.resource)
}

// A refresh token past the thirty days it may sit unused, or past the end of its family.
function lapsed(held: OAuthRefreshRecord): boolean {
  return held.expiresAt <= new Date() || held.createdAt.getTime() + REFRESH_LIFETIME * 1000 <= Date.now()
}

async function exchangeCode(core: Core, form: URLSearchParams, root: string): Promise<TokenReply> {
  const code = form.get('code')
  const verifier = form.get('code_verifier')
  const clientId = form.get('client_id')

  if (code === null || verifier === null || clientId === null)
    return refused('invalid_request', 'code, code_verifier and client_id are required')

  const key = digest(code)
  const peeked = await core.store.oauth!.codes.get?.(key)

  // A request refused for what it asks leaves a live code unspent, so a mistake once does not cost the sign-in on the retry. A spent code goes on to `use`, which revokes what it issued, and so does a code another client presented.
  if (peeked && peeked.usedAt === null && peeked.clientId === clientId && peeked.expiresAt > new Date()) {
    const asked = codeAsk(form, root, peeked, verifier)

    if ('status' in asked)
      return asked
  }

  const spent = await core.store.oauth!.codes.use(key, new Date())

  if (!spent)
    return refused('invalid_grant', 'The code is not valid')

  if (spent.reused) {
    await core.store.oauth!.refresh.revokeFamily(spent.code.userId, spent.code.family)

    return refused('invalid_grant', 'The code was used already')
  }

  const issued = spent.code

  if (issued.expiresAt <= new Date() || issued.clientId !== clientId)
    return refused('invalid_grant', 'The code does not match this request')

  const asked = codeAsk(form, root, issued, verifier)

  if ('status' in asked)
    return asked

  // A code issued with every scope before the app declared some does not give them all now.
  if (issued.scopes === null && core.scopes.size > 0)
    return refused('invalid_grant', 'The client must be approved again')

  const grant = await liveGrant(core, issued.userId, issued.clientId)

  return grant ? issue(core, grant, issued.scopes, issued.family, undefined, asked.resource) : refused('invalid_grant', 'The client is not approved')
}

// What a refresh asks for: the scopes and the resource the new tokens get, or the reply refusing a scope the token lacks or a resource it is not bound to.
function refreshAsk(form: URLSearchParams, root: string, held: OAuthRefreshRecord): { scopes: string[] | null, resource: string | null } | TokenReply {
  const asked = form.get('scope')
  const scopes = asked === null ? held.scopes : asked.split(WHITESPACE).filter(Boolean)

  if (asked !== null && !covers(held.scopes, scopes))
    return refused('invalid_scope', 'A refresh cannot add scopes')

  const bound = boundResource(form, root, held.resource, true)

  return 'status' in bound ? bound : { scopes, resource: bound.resource }
}

async function rotate(core: Core, form: URLSearchParams, root: string): Promise<TokenReply> {
  const presented = form.get('refresh_token')
  const clientId = form.get('client_id')

  if (presented === null || clientId === null)
    return refused('invalid_request', 'refresh_token and client_id are required')

  const key = digest(presented)
  const peeked = await core.store.oauth!.refresh.get?.(key)

  // A request refused for what it asks leaves a live token unspent, so a mistake once does not cost the family on the retry. A spent token goes on to `use`, which revokes the family.
  if (peeked && peeked.usedAt === null && peeked.clientId === clientId && !lapsed(peeked)) {
    const asked = refreshAsk(form, root, peeked)

    if ('status' in asked)
      return asked
  }

  const spent = await core.store.oauth!.refresh.use(key, new Date())

  if (!spent)
    return refused('invalid_grant', 'The refresh token is not valid')

  const held = spent.token

  if (spent.reused) {
    await core.store.oauth!.refresh.revokeFamily(held.userId, held.family)

    return refused('invalid_grant', 'The refresh token was used already')
  }

  if (lapsed(held) || held.clientId !== clientId)
    return refused('invalid_grant', 'The refresh token does not match this request')

  // A token holding every scope, issued while the app declared none, does not cover those it declares since.
  if (held.scopes === null && core.scopes.size > 0)
    return refused('invalid_grant', 'The client must be approved again')

  const asked = refreshAsk(form, root, held)

  if ('status' in asked)
    return asked

  const grant = await liveGrant(core, held.userId, held.clientId)

  return grant ? issue(core, grant, asked.scopes, held.family, held.expiresAt, asked.resource) : refused('invalid_grant', 'The client is not approved')
}

// The token endpoint: the authorization code grant with PKCE, and refresh tokens that rotate, a token used twice ending its family.
export async function tokenEndpoint(core: Core, address: string, form: URLSearchParams, root: string): Promise<TokenReply> {
  if (await spend(core.store, `oauth-token:${address}`, core.limits.oauthToken))
    return refused('invalid_request', 'Too many requests', 429)

  const type = form.get('grant_type')

  if (type === 'authorization_code')
    return exchangeCode(core, form, root)

  return type === 'refresh_token' ? rotate(core, form, root) : refused('unsupported_grant_type', 'Only authorization_code and refresh_token are supported')
}
