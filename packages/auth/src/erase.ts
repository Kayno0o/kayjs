import type { RequestState } from './state'
import type { UserRecord } from './store'
import { publicUser } from './core'
import { log } from './log'
import { notify } from './notify'

type Core = RequestState['core']

// Deletes the user with everything kayjs-auth keeps for them. The app's records go first, so an `onDelete` that throws leaves the account in place, to delete again. The audit log keeps what happened under a new random name, without the addresses, browsers and details that lead back to the user.
// For an account nobody leaves, as an unverified one a registration replaces or a guest past `guests.maxAge`: the address's invitations stay for whoever proves it, and no mail goes out.
export async function eraseUser(core: Core, record: UserRecord): Promise<void> {
  await eraseThen(core, record)
}

// `eraseUser` for a user who goes, by their own hand or an admin's (`actor`): the invitations to their address go too, and the account-deleted notice is mailed.
export async function eraseLeavingUser(state: RequestState, record: UserRecord, actor?: UserRecord): Promise<void> {
  const { store } = state.core

  await eraseThen(state.core, record, async () => {
    if (record.email !== null && record.email !== '' && store.invitations) {
      for (const invitation of await store.invitations.listByEmail(record.email))
        await store.invitations.delete(invitation.id)
    }

    await notify(state, record, 'account-deleted', undefined, undefined, actor)
  })
}

// `afterDelete` runs once the user is gone and before the audit log forgets them, so what it records still names them.
async function eraseThen(core: Core, record: UserRecord, afterDelete?: () => Promise<void>): Promise<void> {
  const { store } = core

  await core.onDelete?.(publicUser(record))
  await store.users.delete(record.id)
  await afterDelete?.()

  if (!core.audit)
    return

  // Logged, not thrown: the account is gone by then, and a retry would find nothing to delete.
  try {
    await store.audit?.forget(record.id, crypto.randomUUID())
  }
  catch (error) {
    log.error('stripping a deleted user from the audit log failed', error)
  }
}
