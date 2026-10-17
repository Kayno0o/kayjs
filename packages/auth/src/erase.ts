import type { RequestState } from './state'
import type { UserRecord } from './store'
import { publicUser } from './core'
import { log } from './log'
import { notify } from './notify'

// Deletes the user with everything kayjs-auth keeps for them. The app's records go first, so an `onDelete` that throws leaves the account in place, to delete again. The audit log keeps what happened under a new random name, without the addresses, browsers and details that lead back to the user.
// `leaving` for a user who goes, by their own hand or an admin's (`actor`): the invitations to their address go too, and the account-deleted notice is mailed. Without it, as for an unverified account a registration replaces, the address's invitations stay for whoever proves it.
export async function erase(state: Pick<RequestState, 'core'>, record: UserRecord): Promise<void>
export async function erase(state: RequestState, record: UserRecord, leaving: { actor?: UserRecord | undefined }): Promise<void>
export async function erase(state: Pick<RequestState, 'core'>, record: UserRecord, leaving?: { actor?: UserRecord | undefined }): Promise<void> {
  const { core } = state
  const { store } = core

  await core.onDelete?.(publicUser(record))
  await store.users.delete(record.id)

  if (leaving) {
    if (record.email !== null && record.email !== '' && store.invitations) {
      for (const invitation of await store.invitations.listByEmail(record.email))
        await store.invitations.delete(invitation.id)
    }

    await notify(state as RequestState, record, 'account-deleted', undefined, undefined, leaving.actor)
  }

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
