import type { RequestState } from './state'
import type { UserRecord } from './store'
import { publicUser } from './core'
import { log } from './log'
import { notify } from './notify'

type Core = RequestState['core']

// An organization whose only owner is the user: `alone` when they are its only member too, so it goes with them, else it needs another owner first.
export interface SoleOwned {
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

// Deletes the user with everything kayjs-auth keeps for them. The app's records go first, so an `onDelete` that throws leaves the account in place, to delete again. The audit log keeps what happened under a new random name, without the addresses, browsers and details that lead back to the user.
// For an account nobody leaves, as an unverified one a registration replaces or a guest past `guests.maxAge`: the address's invitations stay for whoever proves it, and no mail goes out. An organization it solely owned with other members passes to its longest-standing member, as it cannot be refused.
export async function eraseUser(core: Core, record: UserRecord): Promise<void> {
  await eraseThen(core, record, true)
}

// `eraseUser` for a user who goes, by their own hand or an admin's (`actor`): the invitations to their address go too, and the account-deleted notice is mailed. Refused with `last-owner` while they are the only owner of an organization with other members; an organization they are alone in goes with them.
export async function eraseLeavingUser(state: RequestState, record: UserRecord, actor?: UserRecord): Promise<{ ok: true } | { ok: false, error: 'last-owner' }> {
  const { store } = state.core

  return eraseThen(state.core, record, false, async () => {
    if (record.email !== null && record.email !== '' && store.invitations) {
      for (const invitation of await store.invitations.listByEmail(record.email))
        await store.invitations.delete(invitation.id)
    }

    await notify(state, record, 'account-deleted', undefined, undefined, actor)
  })
}

// `afterDelete` runs once the user is gone and before the audit log forgets them, so what it records still names them.
async function eraseThen(core: Core, record: UserRecord, handOver: boolean, afterDelete?: () => Promise<void>): Promise<{ ok: true } | { ok: false, error: 'last-owner' }> {
  const { store } = core
  const owners = await owning(core, record)

  if (!handOver && (await soleOwned(core, record)).some(organization => !organization.alone))
    return { ok: false, error: 'last-owner' }

  await core.onDelete?.(publicUser(record))
  await store.users.delete(record.id)
  await settle(core, owners)
  await afterDelete?.()

  if (!core.audit)
    return { ok: true }

  // Logged, not thrown: the account is gone by then, and a retry would find nothing to delete.
  try {
    await store.audit?.forget(record.id, crypto.randomUUID())
  }
  catch (error) {
    log.error('stripping a deleted user from the audit log failed', error)
  }

  return { ok: true }
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

    if (!first)
      await organizations.delete(id)
    else if (!left.some(member => member.roles.includes(config.owner)))
      await members.update(id, first.userId, { roles: [...new Set([...first.roles, config.owner])] })
  }
}
