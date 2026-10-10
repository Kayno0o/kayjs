import type { User } from './core'
import type { PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { hashPassword } from '@kaynooo/utils'
import { newPasswordProblem } from './breached'
import { publicUser } from './core'
import { revokeBearerTokens } from './email'
import { notify } from './notify'
import { normalizeUsername, usernameProblem } from './rules'
import { reprove } from './twoFactor'

// Sets the signed-in user's password, or a first one, and ends their other sessions.
export async function changePassword(state: RequestState, proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem | 'breached' } }> {
  const problem = await newPasswordProblem(state.core, password)

  if (problem)
    return { ok: false, errors: { password: problem } }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const updated = await state.core.store.users.update(proved.record.id, { passwordHash: await hashPassword(password), sessionVersion: proved.record.sessionVersion + 1 })

  if (updated) {
    // Links mailed before, a reset among them, no longer outrank the password just set.
    await state.core.store.tokens.deleteForUser(updated.id)
    await revokeBearerTokens(state.core, updated.id)
    await state.renew(updated)
    await notify(state.core, updated, 'password-changed')
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
  const problem = usernameProblem(name)

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

// Unlinks a provider from the signed-in user, unless it is their last way in.
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
  await notify(state.core, record, 'provider-unlinked', provider)

  return { ok: true }
}

// Deletes the signed-in user and everything kayjs-auth keeps for them, then signs this session out.
export async function deleteAccount(state: RequestState, proof: Proof, signOut: () => Promise<void>): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  await notify(state.core, proved.record, 'account-deleted')
  await state.core.store.users.delete(proved.record.id)
  await state.core.onDelete?.(publicUser(proved.record))
  await signOut()

  return { ok: true }
}
