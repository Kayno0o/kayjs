import type { PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { Proof, ProofFailure } from './twoFactor'
import { hashPassword } from '@kaynooo/utils'
import { publicUser } from './core'
import { passwordProblem } from './rules'
import { reprove } from './twoFactor'

// Sets the signed-in user's password, or a first one, and ends their other sessions.
export async function changePassword(state: RequestState, proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem } }> {
  const problem = passwordProblem(password)

  if (problem)
    return { ok: false, errors: { password: problem } }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const updated = await state.core.store.users.update(proved.record.id, { passwordHash: await hashPassword(password), sessionVersion: proved.record.sessionVersion + 1 })

  if (updated)
    await state.renew(updated)

  return { ok: true }
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

  if (record.passwordHash === null && identities.length === 1 && !magicLink)
    return { ok: false, error: 'last-way-in' }

  await state.core.store.identities.delete(identity.provider, identity.providerId)

  return { ok: true }
}

// Deletes the signed-in user and everything kay-auth keeps for them, then signs this session out.
export async function deleteAccount(state: RequestState, proof: Proof, signOut: () => Promise<void>): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  await state.core.store.users.delete(proved.record.id)
  await state.core.onDelete?.(publicUser(proved.record))
  await signOut()

  return { ok: true }
}
