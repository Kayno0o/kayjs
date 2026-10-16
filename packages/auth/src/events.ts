import type { Core, User } from './core'
import type { SecurityEvent } from './mail'
import type { RequestState } from './state'
import type { AuditCursor, UserRecord } from './store'
import { clamp } from '@kaynooo/utils'
import { publicUser } from './core'
import { log } from './log'
import { PRUNE_EVERY_MS } from './prune'

// The audit log is pruned of what outlived its age at most this often.
const AUDIT_PAGE_MAX = 200

// What happens to an account without changing what protects it, handed to `onEvent` but never mailed. An admin's doing, a role or a ban, or a manager's in an organization, names them in the context's `actor`.
// An organization event's detail is its id, then the roles given for `member-joined` and `member-roles-changed`.
export type ActivityEvent = 'signed-in' | 'signed-out' | 'sign-in-failed' | 'role-granted' | 'role-revoked' | 'banned' | 'unbanned' | 'impersonation-started' | 'impersonation-ended' | 'organization-created' | 'organization-deleted' | 'member-joined' | 'member-left' | 'member-removed' | 'member-roles-changed' | 'oauth-client-approved' | 'oauth-client-revoked'

export type AuthEvent = SecurityEvent | ActivityEvent

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

// The admin acting as the user this browser is signed in as, when one is.
export async function impersonatorOf(state: RequestState): Promise<string | undefined> {
  return state.via() === 'bearer' ? undefined : (await state.session.get('auth'))?.impersonator?.user
}

// Hands `event` to the app's `onEvent` and to the audit log when it is kept. A failure is logged, not thrown: what happened is done by then.
// While an admin acts as a user, whatever happens is the admin's doing, named as the actor.
export async function report(state: RequestState, record: UserRecord, event: AuthEvent, detail?: string, by?: UserRecord): Promise<void> {
  const { core } = state
  const impersonator = await impersonatorOf(state)
  const actor = impersonator === undefined ? by : await core.store.users.get(impersonator) ?? by

  try {
    await core.onEvent?.(event, publicUser(record), detail, { ip: state.address, userAgent: state.userAgent, actor: actor ? publicUser(actor) : null })
  }
  catch (error) {
    log.error(`onEvent failed for ${event}`, error)
  }

  if (!core.audit)
    return

  try {
    await audit(core).add({ id: Bun.randomUUIDv7(), userId: record.id, event, detail: detail ?? null, ip: state.address, userAgent: state.userAgent, actorId: actor?.id ?? null, at: new Date() })
    await prune(core)
  }
  catch (error) {
    log.error(`writing ${event} to the audit log failed`, error)
  }
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
