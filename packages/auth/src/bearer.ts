import type { Duration } from 'kay'
import type { Core } from './core'
import type { RequestState } from './state'
import type { BearerTokenRecord, UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { durationSeconds } from 'kay/library'
import { banned, TOUCH_EVERY_MS } from './core'
import { digest, randomToken } from './keys'
import { notify } from './notify'
import { plainName } from './text'
import { reprove } from './twoFactor'

const LABEL_MAX_LENGTH = 64
const BEARER = /^Bearer\s+(\S+)$/i
const TOKEN = /^\S{32,4096}$/
const MIN_DISTINCT_CHARACTERS = 10
const TOKEN_PREFIX = 'kat_'
const DEFAULT_EXPIRY_SECONDS = 90 * 24 * 60 * 60

// A prefix lets a secret scanner recognise a leaked token; the digest the store keeps covers it.
function newToken(): string {
  return TOKEN_PREFIX + randomToken()
}

// A bearer token as the app lists it; the token itself is shown once, when minted.
export interface BearerToken {
  id: string
  label: string
  // Null for every scope.
  scopes: string[] | null
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  expired: boolean
}

export interface TokenOptions<Scope extends string = string> {
  // What the token may reach, from the scopes the app declares; every one when left out.
  scopes?: Scope[] | undefined
  // How long until it stops working, a string such as '30d'; 90 days when left out, never with null.
  maxAge?: Duration | null | undefined
  /** @deprecated Since 1.70, dropped in 1.73: this is `maxAge`. */
  expiresIn?: Duration | null | undefined
}

// The seconds a token lives, undefined for a value that is no positive duration.
function expirySeconds(maxAge: Duration): number | undefined {
  try {
    return durationSeconds(maxAge, 'maxAge')
  }
  catch {
    return undefined
  }
}

type TokenProblem = 'label' | 'scope' | 'expiry'

export type CreateTokenResult = { ok: true, token: string, id: string } | { ok: false, error: ProofFailure | TokenProblem }

export type IssueTokenResult = { ok: true, token: string, id: string } | { ok: false, error: TokenProblem | 'token' | 'not-found' | 'banned' }

function tokenProblem(core: Core, name: string, options: TokenOptions): TokenProblem | undefined {
  if (name.length === 0 || name.length > LABEL_MAX_LENGTH)
    return 'label'

  if (options.scopes && (options.scopes.length === 0 || options.scopes.some(scope => !core.scopes.has(scope))))
    return 'scope'

  const maxAge = tokenMaxAge(options)

  return maxAge != null && expirySeconds(maxAge) === undefined ? 'expiry' : undefined
}

// The seconds a token lives: the default when left out, null for never.
function lifetime(maxAge: Duration | null | undefined): number | null {
  if (maxAge === undefined)
    return DEFAULT_EXPIRY_SECONDS

  return maxAge === null ? null : expirySeconds(maxAge)!
}

// `maxAge`, or the `expiresIn` it was called before 1.70.
function tokenMaxAge(options: TokenOptions): Duration | null | undefined {
  return options.maxAge === undefined ? options.expiresIn : options.maxAge
}

async function storeToken(core: Core, userId: string, name: string, options: TokenOptions, token: string): Promise<string> {
  const id = crypto.randomUUID()
  const seconds = lifetime(tokenMaxAge(options))

  await core.store.bearerTokens.create({
    id,
    userId,
    label: name,
    digest: digest(token),
    scopes: options.scopes ? [...new Set(options.scopes)] : null,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: seconds === null ? null : new Date(Date.now() + seconds * 1000),
  })

  return id
}

// A token for a device or an API client of the signed-in user, minted from a session only, never from another token.
export async function createToken(state: RequestState, proof: Proof, label: string, options: TokenOptions = {}): Promise<CreateTokenResult> {
  const name = plainName(label)
  const problem = tokenProblem(state.core, name, options)

  if (problem)
    return { ok: false, error: problem }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  if (state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const token = newToken()
  const id = await storeToken(state.core, proved.record.id, name, options, token)

  await notify(state, proved.record, 'token-created', name)

  return { ok: true, token, id }
}

// A token for `userId` with no proof, for the app to gate; `token` adopts one it handed out before, 32 to 4096 characters without whitespace, as a bearer header carries.
export async function issueToken(core: Core, userId: string, label: string, options: TokenOptions & { token?: string | undefined } = {}): Promise<IssueTokenResult> {
  const name = plainName(label)
  const problem = tokenProblem(core, name, options)

  if (problem)
    return { ok: false, error: problem }

  if (options.token !== undefined && (!TOKEN.test(options.token) || new Set(options.token).size < MIN_DISTINCT_CHARACTERS))
    return { ok: false, error: 'token' }

  const record = await core.store.users.get(userId)

  if (!record)
    return { ok: false, error: 'not-found' }

  if (banned(record))
    return { ok: false, error: 'banned' }

  const token = options.token ?? newToken()

  return { ok: true, token, id: await storeToken(core, record.id, name, options, token) }
}

export async function listTokens(state: RequestState): Promise<BearerToken[]> {
  const record = await state.current()

  return record && state.via() === 'session' ? (await state.core.store.bearerTokens.listByUser(record.id)).filter(token => !token.oauth).map(publicToken) : []
}

export async function revokeToken(state: RequestState, id: string): Promise<boolean> {
  const record = await state.current()

  return record && state.via() === 'session' ? state.core.store.bearerTokens.delete(record.id, id) : false
}

// Whether a request carries an `Authorization: Bearer` token, which no page can add to a cross-site request; a browser sends Basic credentials on its own.
export function bearerRequest(request: Request): boolean {
  return BEARER.test(request.headers.get('authorization') ?? '')
}

// The user a request's `Authorization: Bearer` token belongs to, with the token's scopes.
export async function bearerUser(core: Core, request: Request): Promise<{ record: UserRecord, scopes: string[] | null } | undefined> {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1]

  return token === undefined ? undefined : tokenUser(core, token)
}

// The user a bearer token belongs to, as a websocket handshake checks one; an expired token is refused.
export async function tokenUser(core: Core, token: string): Promise<{ record: UserRecord, scopes: string[] | null } | undefined> {
  const { bearerTokens, users } = core.store
  const hash = digest(token)
  // One query for the token and its user when the store has it, else two.
  const joined = bearerTokens.findByDigestWithUser ? await bearerTokens.findByDigestWithUser(hash) : undefined
  const found = bearerTokens.findByDigestWithUser ? joined?.token : await bearerTokens.findByDigest(hash)
  const now = new Date()

  if (!found || (found.expiresAt !== null && found.expiresAt <= now))
    return undefined

  const record = joined ? joined.user : await users.get(found.userId)

  if (!record)
    return undefined

  if (found.lastUsedAt === null || now.getTime() - found.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await core.store.bearerTokens.touch(found.id, now)

    // The account page's "last used" of an approved app is its last call, not its last refresh.
    if (found.oauth)
      await core.store.oauth?.grants.touch(found.userId, found.oauth.clientId, now)
  }

  return { record, scopes: found.scopes }
}

function publicToken(token: BearerTokenRecord): BearerToken {
  return {
    id: token.id,
    label: token.label,
    scopes: token.scopes,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    expired: token.expiresAt !== null && token.expiresAt <= new Date(),
  }
}
