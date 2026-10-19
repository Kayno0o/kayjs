import type { Core, User } from './core'
import type { SecurityEvent } from './mail'
import type { RequestState } from './state'
import type { AuditCursor, UserRecord } from './store'
import { clamp } from '@kaynooo/utils'
import { truncatedAddress } from './address'
import { linkedUser } from './core'
import { log } from './log'
import { PRUNE_EVERY_MS } from './prune'

const OAUTH_PREFIX = 'oauth:'

// The audit log is pruned of what outlived its age at most this often.
const AUDIT_PAGE_MAX = 200

// What happens to an account without changing what protects it, handed to `onAuthEvent` but never mailed. An admin's doing, a role or a ban, or a manager's in an organization, names them in the context's `actor`.
// An organization event's detail is its id, then the roles given for `member-joined` and `member-roles-changed`.
export type ActivityEvent = 'signed-in' | 'signed-out' | 'sign-in-failed' | 'role-granted' | 'role-revoked' | 'banned' | 'unbanned' | 'impersonation-started' | 'impersonation-ended' | 'organization-created' | 'organization-deleted' | 'member-joined' | 'member-left' | 'member-removed' | 'member-roles-changed' | 'oauth-client-approved' | 'oauth-client-revoked'

export type AuthEvent = SecurityEvent | ActivityEvent

// What each event says besides who it happened to and where from, as `onAuthEvent` hears it.
export interface EventFields {
  // `method` is how: `password`, `register`, `reset-password`, `magic-link`, `email-code`, `passkey`, `guest`, `app` (the app called `auth.signIn`), `oauth` with the `provider`, or `unknown`.
  'signed-in': { method: string, provider?: string }
  'signed-out': Record<never, never>
  // `method` is the attempt that failed: `password`, `passkey`, `two-factor` or `oauth`.
  'sign-in-failed': { method: string }
  'role-granted': { role: string }
  'role-revoked': { role: string }
  'banned': { reason?: string }
  'unbanned': Record<never, never>
  'impersonation-started': Record<never, never>
  'impersonation-ended': Record<never, never>
  'organization-created': { organizationId: string }
  'organization-deleted': { organizationId: string }
  'member-joined': { organizationId: string, roles: string[] }
  'member-left': { organizationId: string }
  'member-removed': { organizationId: string }
  'member-roles-changed': { organizationId: string, roles: string[] }
  // `client` is the app's name.
  'oauth-client-approved': { client: string }
  'oauth-client-revoked': { client: string }
  'new-sign-in': Record<never, never>
  'sign-in-locked': Record<never, never>
  'password-changed': Record<never, never>
  // `email` is the new address.
  'email-changed': { email: string }
  'two-factor-enabled': Record<never, never>
  'two-factor-disabled': Record<never, never>
  'recovery-code-used': Record<never, never>
  'recovery-codes-regenerated': Record<never, never>
  'provider-linked': { provider: string }
  'provider-unlinked': { provider: string }
  'passkey-added': { name?: string }
  'passkey-removed': { name?: string }
  'token-created': { name?: string }
  // `keptThisOne` is whether the session that asked stayed signed in.
  'signed-out-everywhere': { keptThisOne: boolean }
  'account-deleted': Record<never, never>
  'organization-handed-over': { organizationId: string }
}

// An event as `onAuthEvent` hears it: the event, who it happened to, where from and its own fields, such as the `role` of a `role-granted`.
export type AuthEventInfo = { [Event in AuthEvent]: { event: Event, user: User, context: EventContext } & EventFields[Event] }[AuthEvent]

// Where an event came from: the request's address and browser, and who acted when it was not the user, such as an admin.
export interface EventContext {
  ip: string
  userAgent: string
  actor: User | null
}

// One line of the audit log.
export interface AuditEntry {
  id: string
  userId: string
  event: AuthEvent
  detail: string | null
  ip: string
  userAgent: string
  // The user who acted, when not the one it happened to.
  actorId: string | null
  at: Date
}

// The fields of an event, read off the detail it is kept with in the audit log.
export function eventFields(event: AuthEvent, detail: string | undefined): EventFields[AuthEvent] {
  const text = detail === undefined || detail === '' ? undefined : detail

  switch (event) {
    case 'signed-in':
      return text?.startsWith(OAUTH_PREFIX) ? { method: 'oauth', provider: text.slice(OAUTH_PREFIX.length) } : { method: text ?? 'unknown' }
    case 'sign-in-failed':
      return { method: text ?? 'unknown' }
    case 'role-granted':
    case 'role-revoked':
      return { role: text ?? '' }
    case 'banned':
      return text === undefined ? {} : { reason: text }
    case 'organization-created':
    case 'organization-deleted':
    case 'organization-handed-over':
    case 'member-left':
    case 'member-removed':
      return { organizationId: text ?? '' }
    case 'member-joined':
    case 'member-roles-changed': {
      const [organizationId = '', ...roles] = (text ?? '').split(' ')

      return { organizationId, roles: roles.filter(role => role !== '') }
    }
    case 'oauth-client-approved':
    case 'oauth-client-revoked':
      return { client: text ?? '' }
    case 'email-changed':
      return { email: text ?? '' }
    case 'provider-linked':
    case 'provider-unlinked':
      return { provider: text ?? '' }
    case 'passkey-added':
    case 'passkey-removed':
    case 'token-created':
      return text === undefined ? {} : { name: text }
    case 'signed-out-everywhere':
      return { keptThisOne: text === 'this-one-kept' }
    case 'signed-out':
    case 'unbanned':
    case 'impersonation-started':
    case 'impersonation-ended':
    case 'new-sign-in':
    case 'sign-in-locked':
    case 'password-changed':
    case 'two-factor-enabled':
    case 'two-factor-disabled':
    case 'recovery-code-used':
    case 'recovery-codes-regenerated':
    case 'account-deleted':
      return {}
  }
}

// The admin acting as the user this browser is signed in as, when one is.
export async function impersonatorOf(state: RequestState): Promise<string | undefined> {
  return state.via() === 'bearer' ? undefined : (await state.session.get('auth'))?.impersonator?.user
}

// Hands `event` to the app's `onAuthEvent` and to the audit log when it is kept. A failure is logged, not thrown: what happened is done by then.
// While an admin acts as a user, whatever happens is the admin's doing, named as the actor.
export async function report(state: RequestState, record: UserRecord, event: AuthEvent, detail?: string, by?: UserRecord): Promise<void> {
  const impersonator = await impersonatorOf(state)
  const actor = impersonator === undefined ? by : await state.core.store.users.get(impersonator) ?? by

  await reportFrom(state.core, state, record, event, detail, actor)
}

// `report` for what happens outside a request, as a hand-over when a prune deletes an account: `where` is empty, so the entry names no address or browser.
export async function reportFrom(core: Core, where: { address: string, userAgent: string }, record: UserRecord, event: AuthEvent, detail?: string, actor?: UserRecord): Promise<void> {
  const user = await linkedUser(core, record)
  const context: EventContext = { ip: where.address, userAgent: where.userAgent, actor: actor ? await linkedUser(core, actor) : null }

  try {
    await core.onAuthEvent?.({ event, user, context, ...eventFields(event, detail) } as AuthEventInfo)
  }
  catch (error) {
    log.error(`onAuthEvent failed for ${event}`, error)
  }

  if (!core.audit)
    return

  try {
    await audit(core).add({ id: Bun.randomUUIDv7(), userId: record.id, event, detail: detail ?? null, ip: core.audit.ip === 'full' ? where.address : truncatedAddress(where.address), userAgent: where.userAgent, actorId: actor?.id ?? null, at: new Date() })
    await prune(core)
  }
  catch (error) {
    log.error(`writing ${event} to the audit log failed`, error)
  }
}

const AFTER_MAX = 200
let after = 0

// Runs `task` without making the request wait on it, a failure only logged: what the request did differs for a held address and a free one, and the time it takes must not tell which.
// With 200 tasks pending already, as when a hook hangs, the request waits on this one: a stalled hook slows requests rather than piling up without bound.
export async function afterResponse(what: string, task: () => Promise<void>): Promise<void> {
  const run = (async () => {
    after++

    try {
      await task()
    }
    catch (error) {
      log.error(`${what} failed`, error)
    }
    finally {
      after--
    }
  })()

  if (after >= AFTER_MAX)
    await run
}

// A cursor as an app may hand it on after a JSON hop, which leaves a `Date` as its ISO text.
export type AuditCursorInput = AuditCursor | string | { at: Date | string, id: string }

// The audit log, newest first, for one user or everyone, a page of `limit` before `before`. A cursor that is no date answers an empty page, in every store.
export async function auditEntries(core: Core, query: { userId?: string | undefined, before?: AuditCursorInput | undefined, limit?: number | undefined }): Promise<AuditEntry[]> {
  if (!core.audit)
    return []

  const limit = clamp(Math.trunc(query.limit ?? 50), 1, AUDIT_PAGE_MAX)
  const before = query.before === undefined ? undefined : normalizeCursor(query.before)

  if (before === null)
    return []

  return (await audit(core).list({ ...query.userId === undefined ? {} : { userId: query.userId }, ...before === undefined ? {} : { before }, limit })).map(entry => ({ ...entry, event: entry.event as AuthEvent }))
}

// Typed loosely as it may come straight off a JSON body, where an Invalid Date is null.
function normalizeCursor(before: unknown): AuditCursor | null {
  if (typeof before !== 'object' || before === null || before instanceof Date)
    return validDate(before)

  if (!('at' in before) || !('id' in before) || typeof before.id !== 'string')
    return null

  const at = validDate(before.at)

  return at && { id: before.id, at }
}

function validDate(value: unknown): Date | null {
  const date = value instanceof Date || typeof value === 'string' ? new Date(value) : null

  return date && !Number.isNaN(date.getTime()) ? date : null
}

function audit(core: Core): NonNullable<Core['store']['audit']> {
  if (!core.store.audit)
    throw new Error('kayjs-auth: the `audit` option needs a store keeping an audit log, as memoryStore and pgStore do')

  return core.store.audit
}

async function prune(core: Core): Promise<void> {
  const now = Date.now()

  if (!core.audit || now - core.audit.prunedAt < PRUNE_EVERY_MS)
    return

  core.audit.prunedAt = now
  await audit(core).prune(new Date(now - core.audit.maxAge * 1000))
}
