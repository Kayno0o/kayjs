import type { Core } from '../core'
import type { RequestState } from '../state'
import type { OAuthGrantRecord, UserRecord } from '../store'
import type { OAuthClient } from './clients'
import { banned } from '../core'
import { impersonatorOf, report } from '../events'
import { digest, randomToken } from '../keys'
import { resolveClient } from './clients'
import { redirectUriRegistered, withParams } from './uris'

// How long an authorization code can be spent for, seconds.
export const CODE_LIFETIME = 60
const PARAM_MAX_LENGTH = 2048
const CHALLENGE = /^[\w-]{43}$/
const WHITESPACE = /\s+/
// Asked by clients that want a refresh token, which every client is given.
const IMPLIED_SCOPES = new Set(['offline_access'])

// What the authorization endpoint reads off the request, as the client sent it.
export type AuthorizeParams = Partial<Record<'client_id' | 'redirect_uri' | 'response_type' | 'code_challenge' | 'code_challenge_method' | 'scope' | 'state' | 'resource' | 'prompt', string | undefined>>

// What the consent form posts back to be checked again.
export interface ConsentFields {
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  state: string
  resource: string
}

export type AuthorizeOutcome
  // The client or its redirect URI cannot be trusted, so no one is sent there: the page says so.
  = | { kind: 'error', error: 'client' | 'redirect_uri' }
  // Back to the client, with the code or the error.
    | { kind: 'redirect', url: string }
  // The visitor signs in first.
    | { kind: 'sign-in' }
    | { kind: 'consent', client: { id: string, name: string, host: string | null }, redirectHost: string, scopes: string[] | null, fields: ConsentFields }

interface Checked {
  client: OAuthClient
  redirectUri: string
  challenge: string
  scopes: string[] | null
  resource: string | null
  params: AuthorizeParams
}

function oneOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= PARAM_MAX_LENGTH ? value : undefined
}

// Whether `held` covers `wanted`: null is every scope.
export function covers(held: readonly string[] | null, wanted: readonly string[] | null): boolean {
  if (held === null)
    return true

  return wanted !== null && wanted.every(scope => held.includes(scope))
}

// Whether an approval already given covers a request: an approval for every scope, given while the app declared none, covers no scope the app declares since.
function approves(held: readonly string[] | null, wanted: readonly string[] | null): boolean {
  return held === null ? wanted === null : covers(held, wanted)
}

// The scopes of an approval once the user approves more: both sets together, with the new ones alone when the approval held every scope of an app declaring none.
function together(held: readonly string[] | null, wanted: readonly string[] | null): string[] | null {
  if (wanted === null)
    return null

  return held === null ? [...wanted] : [...new Set([...held, ...wanted])]
}

// The scopes a request asks for, null for every one (an app declaring none); undefined when it asks for one the app does not declare.
export function requestedScopes(core: Core, scope: string | undefined): string[] | null | undefined {
  // An app declaring no scopes gives its tokens every one, whatever a client asks for.
  if (core.scopes.size === 0)
    return null

  const asked = (scope ?? '').split(WHITESPACE).filter(each => each !== '' && !IMPLIED_SCOPES.has(each))

  // A client asking for no scope is given the app's default ones, none unless it names some.
  if (asked.length === 0)
    return [...core.oauthServer?.defaultScopes ?? []]

  return asked.every(each => core.scopes.has(each)) ? [...new Set(asked)] : undefined
}

function failure(checked: Pick<Checked, 'redirectUri' | 'params'>, root: string, error: string, description: string): AuthorizeOutcome {
  return { kind: 'redirect', url: withParams(checked.redirectUri, { error, error_description: description, state: oneOf(checked.params.state), iss: root }) }
}

// Reads the request as far as the client and its redirect URI, then the rest; an outcome means it stops there.
async function check(state: RequestState, params: AuthorizeParams, root: string): Promise<Checked | AuthorizeOutcome> {
  const clientId = oneOf(params.client_id)
  const client = clientId === undefined ? undefined : await resolveClient(state.core, clientId, state.client)

  if (!client)
    return { kind: 'error', error: 'client' }

  const redirectUri = oneOf(params.redirect_uri)

  if (redirectUri === undefined || !redirectUriRegistered(client.redirectUris, redirectUri))
    return { kind: 'error', error: 'redirect_uri' }

  const base = { redirectUri, params }
  const challenge = oneOf(params.code_challenge)

  if (oneOf(params.response_type) !== 'code')
    return failure(base, root, 'unsupported_response_type', 'Only the code response type is supported')

  if (challenge === undefined || !CHALLENGE.test(challenge) || params.code_challenge_method !== 'S256')
    return failure(base, root, 'invalid_request', 'A PKCE code_challenge with code_challenge_method S256 is required')

  const scopes = requestedScopes(state.core, oneOf(params.scope))

  if (scopes === undefined)
    return failure(base, root, 'invalid_scope', 'A scope asked for is not one this server has')

  const resource = oneOf(params.resource)

  if (resource !== undefined && !sameSite(resource, root))
    return failure(base, root, 'invalid_target', 'The resource is not one of this server')

  return { client, redirectUri, challenge, scopes, resource: resource ?? null, params }
}

// Whether two URLs are the same resource, however they are spelled.
export function sameResource(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href
  }
  catch {
    return false
  }
}

// Whether `resource` is a URL of the site the OAuth server is of.
export function sameSite(resource: string, root: string): boolean {
  try {
    const url = new URL(resource)

    return url.origin === new URL(root).origin && url.hash === ''
  }
  catch {
    return false
  }
}

function isOutcome(value: Checked | AuthorizeOutcome): value is AuthorizeOutcome {
  return 'kind' in value
}

// Spends the user's approval on a code for the client, and answers where the browser goes back to it.
async function approve(state: RequestState, record: UserRecord, checked: Checked, root: string): Promise<string> {
  const { core } = state
  const oauth = core.store.oauth!
  const now = new Date()
  const code = randomToken()
  const held = await oauth.grants.get(record.id, checked.client.id)
  const granted = held ? together(held.scopes, checked.scopes) : checked.scopes
  const grant: OAuthGrantRecord = { userId: record.id, clientId: checked.client.id, clientName: checked.client.name, scopes: granted, createdAt: held?.createdAt ?? now, lastUsedAt: held?.lastUsedAt ?? null }

  await oauth.grants.upsert(grant)
  await oauth.codes.create({ digest: digest(code), userId: record.id, clientId: checked.client.id, redirectUri: checked.redirectUri, challenge: checked.challenge, scopes: checked.scopes, family: crypto.randomUUID(), resource: checked.resource, createdAt: now, expiresAt: new Date(now.getTime() + CODE_LIFETIME * 1000), usedAt: null })

  if (!held || !approves(held.scopes, checked.scopes))
    await report(state, record, 'oauth-client-approved', checked.client.name)

  return withParams(checked.redirectUri, { code, state: oneOf(checked.params.state), iss: root })
}

// The user a page may approve for: signed in by a session of their own, not an admin acting as them.
export async function approver(state: RequestState): Promise<UserRecord | undefined> {
  const record = await state.current()

  if (!record || record.guest || banned(record) || state.via() !== 'session' || await impersonatorOf(state) !== undefined)
    return undefined

  return record
}

// What the authorization endpoint does with a request: the visitor signs in, sees the consent page, or goes back to the client with a code when they approved this client for these scopes already.
export async function authorize(state: RequestState, params: AuthorizeParams, root: string): Promise<AuthorizeOutcome> {
  const checked = await check(state, params, root)

  if (isOutcome(checked))
    return checked

  const record = await approver(state)

  const prompt = oneOf(params.prompt)?.split(WHITESPACE) ?? []

  if (!record) {
    if (await impersonatorOf(state) !== undefined)
      return failure(checked, root, 'access_denied', 'Not while acting as a user')

    return prompt.includes('none') ? failure(checked, root, 'login_required', 'The user is signed out') : { kind: 'sign-in' }
  }

  const held = await state.core.store.oauth!.grants.get(record.id, checked.client.id)

  if (held && approves(held.scopes, checked.scopes) && !prompt.includes('consent'))
    return { kind: 'redirect', url: await approve(state, record, checked, root) }

  if (prompt.includes('none'))
    return failure(checked, root, 'consent_required', 'The user has not approved this client for these scopes')

  return {
    kind: 'consent',
    redirectHost: new URL(checked.redirectUri).host,
    client: { id: checked.client.id, name: checked.client.name, host: checked.client.host },
    scopes: checked.scopes,
    fields: { client_id: checked.client.id, redirect_uri: checked.redirectUri, code_challenge: checked.challenge, scope: oneOf(params.scope) ?? '', state: oneOf(params.state) ?? '', resource: oneOf(params.resource) ?? '' },
  }
}

// The user's answer on the consent page, checked again as the request is: where the browser goes back to the client.
export async function decide(state: RequestState, fields: AuthorizeParams, allow: boolean, root: string): Promise<{ ok: true, redirect: string } | { ok: false, error: 'client' | 'redirect_uri' | 'signed-out' }> {
  const checked = await check(state, { ...fields, response_type: 'code', code_challenge_method: 'S256' }, root)

  if (isOutcome(checked))
    return checked.kind === 'redirect' ? { ok: true, redirect: checked.url } : { ok: false, error: checked.kind === 'error' ? checked.error : 'signed-out' }

  const record = await approver(state)

  if (!record)
    return { ok: false, error: 'signed-out' }

  if (!allow)
    return { ok: true, redirect: withParams(checked.redirectUri, { error: 'access_denied', error_description: 'The user denied the request', state: oneOf(checked.params.state), iss: root }) }

  return { ok: true, redirect: await approve(state, record, checked, root) }
}
