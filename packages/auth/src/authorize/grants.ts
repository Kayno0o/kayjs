import type { RequestState } from '../state'
import { report } from '../events'
import { approver } from './request'

// An app the signed-in user approved to act as them.
export interface ApprovedClient {
  id: string
  name: string
  // Null for every scope.
  scopes: string[] | null
  createdAt: Date
  lastUsedAt: Date | null
}

export async function approvedClients(state: RequestState): Promise<ApprovedClient[]> {
  const record = await state.current()

  if (!record || !state.core.store.oauth)
    return []

  return (await state.core.store.oauth.grants.listByUser(record.id)).map(grant => ({ id: grant.clientId, name: grant.clientName, scopes: grant.scopes, createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt }))
}

// Takes the approval back with every token the app was given; false when there was none, or when this is not the user's own session.
export async function revokeClient(state: RequestState, clientId: string): Promise<boolean> {
  const record = await approver(state)
  const oauth = state.core.store.oauth

  if (!record || !oauth)
    return false

  const grant = await oauth.grants.get(record.id, clientId)

  if (!grant || !await oauth.grants.revoke(record.id, clientId))
    return false

  await report(state, record, 'oauth-client-revoked', grant.clientName)

  return true
}
