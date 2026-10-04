import type { Core } from './core'
import type { RequestState } from './state'
import type { BearerTokenRecord, UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { digest, randomToken } from './keys'
import { notify } from './notify'
import { reprove } from './twoFactor'

// A use is recorded at most this often, so a busy device does not write on every request.
const TOUCH_EVERY_MS = 5 * 60 * 1000
const LABEL_MAX_LENGTH = 64
const BEARER = /^Bearer\s+(\S+)$/i

// A bearer token as the app lists it; the token itself is shown once, when minted.
export interface BearerToken {
  id: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
}

// A token for a device or an API client of the signed-in user, minted from a session only, never from another token.
export async function createToken(state: RequestState, proof: Proof, label: string): Promise<{ ok: true, token: string, id: string } | { ok: false, error: ProofFailure | 'label' }> {
  const name = label.trim()

  if (name.length === 0 || name.length > LABEL_MAX_LENGTH)
    return { ok: false, error: 'label' }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  if (state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const token = randomToken()
  const id = crypto.randomUUID()

  await state.core.store.bearerTokens.create({ id, userId: proved.record.id, label: name, digest: digest(token), createdAt: new Date(), lastUsedAt: null })
  await notify(state.core, proved.record, 'token-created', name)

  return { ok: true, token, id }
}

export async function listTokens(state: RequestState): Promise<BearerToken[]> {
  const record = await state.current()

  return record ? (await state.core.store.bearerTokens.listByUser(record.id)).map(publicToken) : []
}

export async function revokeToken(state: RequestState, id: string): Promise<boolean> {
  const record = await state.current()

  return record ? state.core.store.bearerTokens.delete(record.id, id) : false
}

// The user a request's `Authorization: Bearer` token belongs to.
export async function bearerUser(core: Core, request: Request): Promise<UserRecord | undefined> {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1]

  return token === undefined ? undefined : tokenUser(core, token)
}

// The user a bearer token belongs to, as a websocket handshake checks one.
export async function tokenUser(core: Core, token: string): Promise<UserRecord | undefined> {
  const found = await core.store.bearerTokens.findByDigest(digest(token))
  const record = found && await core.store.users.get(found.userId)

  if (!found || !record)
    return undefined

  const now = new Date()

  if (found.lastUsedAt === null || now.getTime() - found.lastUsedAt.getTime() > TOUCH_EVERY_MS)
    await core.store.bearerTokens.touch(found.id, now)

  return record
}

function publicToken(token: BearerTokenRecord): BearerToken {
  return { id: token.id, label: token.label, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt }
}
