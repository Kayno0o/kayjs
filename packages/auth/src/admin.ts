import type { User } from './core'
import type { AuditCursorInput, AuditEntry } from './events'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { clamp } from '@kaynooo/utils'
import { banned, publicUser } from './core'
import { eraseLeavingUser } from './erase'
import { auditEntries, report } from './events'
import { revokeBearerTokens } from './sessions'
import { provedLately } from './twoFactor'

const USER_PAGE_MAX = 200
const BAN_REASON_MAX_LENGTH = 500

// A user as an admin sees them.
export interface ManagedUser extends User {
  createdAt: Date
  // Set while the user is barred from signing in, `until` null for good.
  ban: { at: Date, until: Date | null, reason: string | null } | null
}

// `forbidden` when the user asking does not meet the `admin` option, acts as someone else or came with a bearer token.
export type AdminFailure = 'forbidden' | 'not-found'

// `stale` when the admin's session neither signed in nor re-proved in the last ten minutes.
export type AdminChangeFailure = AdminFailure | 'stale'

export type RoleResult = { ok: true, user: ManagedUser } | { ok: false, error: AdminChangeFailure | 'unknown-role' | 'self' | 'last-admin' }

export type BanResult = { ok: true, user: ManagedUser } | { ok: false, error: AdminChangeFailure | 'self' | 'admin' | 'until' }

export type UnbanResult = { ok: true, user: ManagedUser } | { ok: false, error: AdminChangeFailure }

export type DeleteResult = { ok: true } | { ok: false, error: AdminChangeFailure | 'self' | 'admin' | 'last-owner' }

export function managedUser(record: UserRecord): ManagedUser {
  return {
    ...publicUser(record),
    createdAt: record.createdAt,
    ban: banned(record) ? { at: record.bannedAt!, until: record.bannedUntil, reason: record.banReason } : null,
  }
}

// The user asking, when they meet the `admin` option as themselves, signed in on this session: a bearer token, however scoped, manages no one.
export async function actingAdmin(state: RequestState): Promise<UserRecord | null> {
  const record = await state.current()

  if (!record || state.via() !== 'session' || (await state.session.get('auth'))?.impersonator)
    return null

  return await isAdmin(state, record) ? record : null
}

// The admin changing a user, who must have signed in or re-proved lately, so a session left open or stolen grants, bans and deletes no one.
export async function changingAdmin(state: RequestState): Promise<{ ok: true, actor: UserRecord } | { ok: false, error: 'forbidden' | 'stale' }> {
  const actor = await actingAdmin(state)

  if (!actor)
    return { ok: false, error: 'forbidden' }

  return await provedLately(state) ? { ok: true, actor } : { ok: false, error: 'stale' }
}

export async function isAdmin(state: RequestState, record: UserRecord): Promise<boolean> {
  return await state.core.admin?.(publicUser(record)) ?? false
}

// Whether `record` is the only user meeting the `admin` option, so losing them leaves the deployment with no admin.
export async function lastAdmin(state: RequestState, record: UserRecord): Promise<boolean> {
  return await isAdmin(state, record) && !await anotherAdmin(state, record.id)
}

// Read a page at a time and stopped at the first admin other than `exceptId`; the total is never read, so the store need not count.
async function anotherAdmin(state: RequestState, exceptId: string): Promise<boolean> {
  for (let offset = 0; ; offset += USER_PAGE_MAX) {
    const { users } = await state.core.store.users.list({ offset, limit: USER_PAGE_MAX, total: false })

    for (const user of users) {
      if (user.id !== exceptId && await isAdmin(state, user))
        return true
    }

    if (users.length < USER_PAGE_MAX)
      return false
  }
}

// Newest first, a page of `limit` (50 by default) from `offset`.
export async function listUsers(state: RequestState, query: { search?: string | undefined, offset?: number | undefined, limit?: number | undefined }): Promise<{ ok: true, users: ManagedUser[], total: number } | { ok: false, error: 'forbidden' }> {
  if (!(await actingAdmin(state)))
    return { ok: false, error: 'forbidden' }

  const search = query.search?.trim()
  const found = await state.core.store.users.list({
    ...search === undefined || search === '' ? {} : { search },
    offset: Math.max(Math.trunc(query.offset ?? 0), 0),
    limit: clamp(Math.trunc(query.limit ?? 50), 1, USER_PAGE_MAX),
  })

  return { ok: true, users: found.users.map(managedUser), total: found.total }
}

export async function getUser(state: RequestState, userId: string): Promise<{ ok: true, user: ManagedUser } | { ok: false, error: AdminFailure }> {
  if (!(await actingAdmin(state)))
    return { ok: false, error: 'forbidden' }

  const record = await state.core.store.users.get(userId)

  return record ? { ok: true, user: managedUser(record) } : { ok: false, error: 'not-found' }
}

// Takes effect on the user's next request, roles being read with the user each time.
export async function changeRole(state: RequestState, userId: string, role: string, granted: boolean): Promise<RoleResult> {
  const acting = await changingAdmin(state)

  if (!acting.ok)
    return acting

  const { actor } = acting

  if (state.core.roles && !state.core.roles.has(role))
    return { ok: false, error: 'unknown-role' }

  const record = await state.core.store.users.get(userId)

  if (!record)
    return { ok: false, error: 'not-found' }

  if (record.roles.includes(role) === granted)
    return { ok: true, user: managedUser(record) }

  const roles = granted ? [...record.roles, role] : record.roles.filter(held => held !== role)

  if (record.id === actor.id && !(await isAdmin(state, { ...record, roles })))
    return { ok: false, error: 'self' }

  const updated = await state.core.store.users.update(record.id, { roles }) ?? { ...record, roles }

  // Two admins revoking each other both see the other still there: when none is left, the role goes back.
  if (!granted && await isAdmin(state, record) && !await isAdmin(state, updated) && !await anotherAdmin(state, '')) {
    await state.core.store.users.update(record.id, { roles: record.roles })

    return { ok: false, error: 'last-admin' }
  }

  await report(state, updated, granted ? 'role-granted' : 'role-revoked', role, actor)

  return { ok: true, user: managedUser(updated) }
}

// Bars the user from signing in, for good or `until` then, and signs them out everywhere, devices included. Another admin is refused: revoke their role first. So is the only owner of an organization with other members (`last-owner`): they hand it over first.
export async function banUser(state: RequestState, userId: string, options: { reason?: string | undefined, until?: Date | undefined }): Promise<BanResult> {
  const acting = await changingAdmin(state)

  if (!acting.ok)
    return acting

  const { actor } = acting

  if (options.until !== undefined && !(options.until.getTime() > Date.now()))
    return { ok: false, error: 'until' }

  const record = await state.core.store.users.get(userId)

  if (!record)
    return { ok: false, error: 'not-found' }

  if (record.id === actor.id)
    return { ok: false, error: 'self' }

  if (await isAdmin(state, record))
    return { ok: false, error: 'admin' }

  const given = options.reason?.trim().slice(0, BAN_REASON_MAX_LENGTH)
  const reason = given === undefined || given === '' ? null : given
  const patch = { bannedAt: new Date(), bannedUntil: options.until ?? null, banReason: reason, sessionVersion: record.sessionVersion + 1 }
  const updated = await state.core.store.users.update(record.id, patch) ?? { ...record, ...patch }

  await revokeBearerTokens(state.core, record.id)
  await report(state, updated, 'banned', reason ?? undefined, actor)

  return { ok: true, user: managedUser(updated) }
}

export async function unbanUser(state: RequestState, userId: string): Promise<UnbanResult> {
  const acting = await changingAdmin(state)

  if (!acting.ok)
    return acting

  const { actor } = acting

  const record = await state.core.store.users.get(userId)

  if (!record)
    return { ok: false, error: 'not-found' }

  if (record.bannedAt === null)
    return { ok: true, user: managedUser(record) }

  const patch = { bannedAt: null, bannedUntil: null, banReason: null }
  const updated = await state.core.store.users.update(record.id, patch) ?? { ...record, ...patch }

  await report(state, updated, 'unbanned', undefined, actor)

  return { ok: true, user: managedUser(updated) }
}

// Deletes the user with everything kayjs-auth keeps for them, calls `onDelete` and mails them the account-deleted notice. Another admin is refused: revoke their role first. So is the only owner of an organization with other members (`last-owner`): they hand it over first.
export async function deleteUser(state: RequestState, userId: string): Promise<DeleteResult> {
  const acting = await changingAdmin(state)

  if (!acting.ok)
    return acting

  const { actor } = acting

  const record = await state.core.store.users.get(userId)

  if (!record)
    return { ok: false, error: 'not-found' }

  if (record.id === actor.id)
    return { ok: false, error: 'self' }

  return await isAdmin(state, record) ? { ok: false, error: 'admin' } : eraseLeavingUser(state, record, actor)
}

// Everyone's audit log, or one user's, newest first.
export async function adminAuditLog(state: RequestState, query: { userId?: string | undefined, before?: AuditCursorInput | undefined, limit?: number | undefined }): Promise<{ ok: true, entries: AuditEntry[] } | { ok: false, error: 'forbidden' }> {
  if (!(await actingAdmin(state)))
    return { ok: false, error: 'forbidden' }

  return { ok: true, entries: await auditEntries(state.core, query) }
}
