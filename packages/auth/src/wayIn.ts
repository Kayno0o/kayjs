import type { RequestState } from './state'
import type { IdentityRecord, PasskeyRecord } from './store'

type Core = RequestState['core']

// What a removal takes away from the ways in.
export type Removed = { identity: IdentityRecord } | { passkey: PasskeyRecord }

// Whether the user can sign in some other way than by a session once `without` is gone: a password, a magic link to a verified address, a linked provider or a passkey that proved user verification, those the app switched off not counted. Read from the store, so it sees what a request racing this one wrote.
export async function hasWayIn(core: Core, userId: string, without?: Removed): Promise<boolean> {
  const record = await core.store.users.get(userId)

  if (!record)
    return true

  if ((core.switches.password && record.passwordHash !== null) || (core.switches.magicLink && core.email !== undefined && record.emailVerifiedAt !== null))
    return true

  const identities = await core.store.identities.listByUser(userId)

  if (identities.some(identity => !(without && 'identity' in without && same(identity, without.identity))))
    return true

  return core.switches.passkeys && (await core.store.passkeys.listByUser(userId)).some(passkey => passkey.userVerified && !(without && 'passkey' in without && passkey.id === without.passkey.id))
}

function same(a: IdentityRecord, b: IdentityRecord): boolean {
  return a.provider === b.provider && a.providerId === b.providerId
}

// Puts a removed identity or passkey back; a request racing this one may have done so already, which leaves nothing to undo. Any other failure is rethrown once the user is found with no way in, rather than answered as a refusal that leaves them locked out.
export async function putBack(core: Core, userId: string, restore: () => unknown): Promise<void> {
  try {
    await restore()
  }
  catch (error) {
    if (!await hasWayIn(core, userId))
      throw error
  }
}
