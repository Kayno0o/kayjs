import type { RequestState } from './state'
import type { UserRecord } from './store'
import { publicUser } from './core'
import { reportFrom } from './events'
import { log } from './log'
import { mailNotice, notify } from './notify'
import { revokeUpstream } from './oauth/flow'

type Core = RequestState['core']

// An organization whose only owner is the user: `alone` when they are its only member too, so it goes with them, else it needs another owner first.
interface SoleOwned {
  id: string
  name: string
  alone: boolean
}

// The organizations the user holds the owner role in.
async function owning(core: Core, record: UserRecord): Promise<string[]> {
  const { organizations: config } = core
  const { organizations, members } = core.store

  if (!config || !organizations || !members)
    return []

  return (await members.listByUser(record.id)).filter(membership => membership.roles.includes(config.owner)).map(membership => membership.organizationId)
}

export async function soleOwned(core: Core, record: UserRecord): Promise<SoleOwned[]> {
  const { organizations: config } = core
  const { organizations, members } = core.store
  const owned: SoleOwned[] = []

  if (!config || !organizations || !members)
    return owned

  for (const id of await owning(core, record)) {
    const everyone = await members.listByOrganization(id)

    if (everyone.some(member => member.userId !== record.id && member.roles.includes(config.owner)))
      continue

    const organization = await organizations.get(id)

    if (organization)
      owned.push({ id, name: organization.name, alone: everyone.every(member => member.userId === record.id) })
  }

  return owned
}

// Deletes the user with everything kayjs-auth keeps for them. The app's records go first, so an `onDelete` that throws leaves the account in place, to delete again. The audit log keeps what happened under a new random name, without the addresses, browsers and details that lead back to the user, and the provider tokens held are revoked upstream.
// For an account nobody leaves, as an unverified one a registration replaces or a guest past `guests.maxAge`: the address's invitations stay for whoever proves it, and no mail goes out.
// An organization it solely owned with other members passes to its longest-standing member, as it cannot be refused.
export async function eraseUser(core: Core, record: UserRecord): Promise<void> {
  await eraseThen(core, record, true)
}

// `eraseUser` for a user who goes, by their own hand or an admin's (`actor`): the invitations to their address go too, and the account-deleted notice is mailed. Refused with `last-owner` while they are the only owner of an organization with other members, unless `handOver` is set, as for an admin who cannot name an owner: the organization then passes to its longest-standing member. An organization they are alone in goes with them.
export async function eraseLeavingUser(state: RequestState, record: UserRecord, options: { actor?: UserRecord, handOver: true }): Promise<{ ok: true }>
export async function eraseLeavingUser(state: RequestState, record: UserRecord, options?: { actor?: UserRecord, handOver?: false }): Promise<{ ok: true } | { ok: false, error: 'last-owner' }>
export async function eraseLeavingUser(state: RequestState, record: UserRecord, options: { actor?: UserRecord, handOver?: boolean } = {}): Promise<{ ok: true } | { ok: false, error: 'last-owner' }> {
  const { store } = state.core
  const { actor, handOver = false } = options

  return eraseThen(state.core, record, handOver, async () => {
    if (record.email !== null && record.email !== '' && store.invitations) {
      for (const invitation of await store.invitations.listByEmail(record.email))
        await store.invitations.delete(invitation.id)
    }

    await notify(state, record, 'account-deleted', undefined, undefined, actor)
  })
}

// `afterDelete` runs once the user is gone, and what it records is forgotten after it. The audit log forgets the user before and after, and a failure of either fails the erase, so none of their data stays behind unreported; only the first leaves the account to delete again.
// A throwing `afterDelete` fails the erase too, but only once the hand-over and the second strip have run.
async function eraseThen(core: Core, record: UserRecord, handOver: boolean, afterDelete?: () => Promise<void>): Promise<{ ok: true } | { ok: false, error: 'last-owner' }> {
  const { store } = core

  if (!handOver && (await soleOwned(core, record)).some(organization => !organization.alone))
    return { ok: false, error: 'last-owner' }

  const owners = await owning(core, record)
  const pseudonym = crypto.randomUUID()

  await core.onDelete?.(publicUser(record))
  await Promise.all((await store.identities.listByUser(record.id)).map(async identity => revokeUpstream(core, identity)))
  // Before the account goes, so a store that cannot strip the audit log fails the erase with the account still there to delete again.
  await forget(core, record, pseudonym)
  await store.users.delete(record.id)

  let failure: { error: unknown } | undefined

  try {
    await afterDelete?.()
  }
  catch (error) {
    failure = { error }
  }

  // Logged, not thrown: the account is gone by then, and a retry would find nothing to delete.
  try {
    await settle(core, owners)
  }
  catch (error) {
    log.error('handing over a deleted user\'s organizations failed', error)
  }

  // What `afterDelete` recorded still names them. The account is gone by then, so this failure is thrown for the app to see and cannot be retried.
  if (afterDelete) {
    try {
      await forget(core, record, pseudonym)
    }
    catch (error) {
      if (!failure)
        throw error

      log.error('stripping a deleted user\'s audit log failed', error)
    }
  }

  if (failure)
    throw failure.error

  return { ok: true }
}

async function forget(core: Core, record: UserRecord, pseudonym: string): Promise<void> {
  if (core.audit)
    await core.store.audit?.forget(record.id, pseudonym)
}

// Runs once the user is gone, so it also catches two owners deleted at the same moment, each having seen the other still there: an organization left empty is deleted, one left with members but no owner passes to the one who joined first.
async function settle(core: Core, ids: string[]): Promise<void> {
  const { organizations: config } = core
  const { organizations, members } = core.store

  if (!config || !organizations || !members)
    return

  for (const id of ids) {
    const left = await members.listByOrganization(id)
    const [first] = left

    if (!first) {
      await organizations.delete(id)
    }
    else if (!left.some(member => member.roles.includes(config.owner))) {
      await members.update(id, first.userId, { roles: [...new Set([...first.roles, config.owner])] })
      await tellNewOwner(core, id, first.userId)
    }
  }
}

// Reports the hand-over to the new owner's `onAuthEvent` and audit log and mails them, after the organization is theirs; a failure here is logged, as the hand-over is done.
async function tellNewOwner(core: Core, organizationId: string, userId: string): Promise<void> {
  try {
    const owner = await core.store.users.get(userId)
    const organization = await core.store.organizations?.get(organizationId)

    if (!owner || !organization)
      return

    await reportFrom(core, { address: '', userAgent: '' }, owner, 'organization-handed-over', organizationId)
    mailNotice(core, [], owner, 'organization-handed-over', organization.name)
  }
  catch (error) {
    log.error('telling the new owner of a handed-over organization failed', error)
  }
}
