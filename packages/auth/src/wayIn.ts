import type { RequestState } from './state'

type Core = RequestState['core']

// Whether the user can still sign in some other way than by a session: a password, a magic link to a verified address, a linked provider or a passkey. Read from the store, so it sees what a request racing this one wrote.
export async function hasWayIn(core: Core, userId: string): Promise<boolean> {
  const record = await core.store.users.get(userId)

  if (!record)
    return true

  if (record.passwordHash !== null || (core.email !== undefined && record.emailVerifiedAt !== null))
    return true

  return (await core.store.identities.listByUser(userId)).length > 0 || (await core.store.passkeys.listByUser(userId)).length > 0
}

// Puts a removed identity or passkey back; a request racing this one may have done so already, which leaves nothing to undo.
export async function putBack(restore: () => unknown): Promise<void> {
  try {
    await restore()
  }
  catch {}
}
