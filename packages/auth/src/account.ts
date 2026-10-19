import type { User } from './core'
import type { PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { hashPassword } from '@kaynooo/utils'
import { lastAdmin } from './admin'
import { newPasswordProblem } from './breached'
import { publicUser } from './core'
import { eraseLeavingUser, soleOwned } from './erase'
import { notify } from './notify'
import { revokeUpstream } from './oauth/flow'
import { normalizeUsername, usernameProblem } from './rules'
import { endOtherSessions } from './sessions'
import { reprove } from './twoFactor'
import { hasWayIn, putBack } from './wayIn'

// Sets the signed-in user's password, or a first one, and ends their other sessions.
export async function changePassword(state: RequestState, proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem | 'breached' } }> {
  const problem = await newPasswordProblem(state.core, password)

  if (problem !== undefined)
    return { ok: false, errors: { password: problem } }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const updated = await endOtherSessions(state, proved.record, { passwordHash: await hashPassword(password) })

  if (updated) {
    // Links mailed before, a reset among them, no longer outrank the password just set.
    await state.core.store.tokens.deleteForUser(updated.id)
    await notify(state, updated, 'password-changed')
  }

  return { ok: true }
}

export type ChangeUsernameResult = { ok: true, user: User } | { ok: false, error: 'signed-out' } | { ok: false, errors: { username: UsernameProblem | 'taken' | 'unchanged' } }

// Names the signed-in user, or renames them, under the rules register checks. A name is no credential, so it takes no proof and sends no mail; a session is needed all the same, so a device's token cannot rename the account it was given for.
export async function changeUsername(state: RequestState, username: string): Promise<ChangeUsernameResult> {
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const name = normalizeUsername(username)
  const problem = usernameProblem(name, state.core.rules)

  if (problem)
    return { ok: false, errors: { username: problem } }

  if (name === record.username)
    return { ok: false, errors: { username: 'unchanged' } }

  const holder = await state.core.store.users.findByUsername(name)

  // The user's own name in another case is theirs to recase.
  if (holder && holder.id !== record.id)
    return { ok: false, errors: { username: 'taken' } }

  let updated: UserRecord | undefined

  try {
    updated = await state.core.store.users.update(record.id, { username: name })
  }
  // Another request took the name in between; any other failure is the store's.
  catch (error) {
    const taker = await state.core.store.users.findByUsername(name)

    if (taker && taker.id !== record.id)
      return { ok: false, errors: { username: 'taken' } }

    throw error
  }

  if (!updated)
    return { ok: false, error: 'signed-out' }

  await state.renew(updated)

  return { ok: true, user: publicUser(updated) }
}

// Unlinks a provider from the signed-in user, unless it is their last way in, and ends their other sessions.
export async function unlink(state: RequestState, provider: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-linked' | 'last-way-in' }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const { record } = proved
  const identities = await state.core.store.identities.listByUser(record.id)
  const identity = identities.find(entry => entry.provider === provider)

  if (!identity)
    return { ok: false, error: 'not-linked' }

  const magicLink = state.core.email !== undefined && record.emailVerifiedAt !== null

  if (record.passwordHash === null && identities.length === 1 && !magicLink && (await state.core.store.passkeys.listByUser(record.id)).length === 0)
    return { ok: false, error: 'last-way-in' }

  await state.core.store.identities.delete(identity.provider, identity.providerId)

  // Two requests can each see the other way in still there: when none is left, the identity goes back.
  if (!await hasWayIn(state.core, record.id)) {
    await putBack(async () => state.core.store.identities.create(identity))

    return { ok: false, error: 'last-way-in' }
  }

  await revokeUpstream(state.core, identity)
  await endOtherSessions(state, record)
  await notify(state, record, 'provider-unlinked', provider)

  return { ok: true }
}

// Deletes the signed-in user and everything kayjs-auth keeps for them, then signs this session out. The last admin, and the only owner of an organization with other members, are refused before the proof is spent; an organization the user is alone in is deleted with them.
export async function deleteAccount(state: RequestState, proof: Proof, signOut: () => Promise<void>): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'last-admin' | 'last-owner' }> {
  const current = await state.current()

  if (current && await lastAdmin(state, current))
    return { ok: false, error: 'last-admin' }

  if (current && (await soleOwned(state.core, current)).some(organization => !organization.alone))
    return { ok: false, error: 'last-owner' }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const erased = await eraseLeavingUser(state, proved.record)

  if (!erased.ok)
    return erased

  await signOut()

  return { ok: true }
}
