import type { BareUser } from './core'
import type { Proof, ProofFailure } from './proof'
import type { PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { hashPassword } from '@kaynooo/utils'
import { newPasswordProblem } from './breached'
import { publicUser } from './core'
import { eraseLeavingUser, soleOwned } from './erase'
import { validLocale } from './locale'
import { notify } from './notify'
import { reprove } from './proof'
import { normalizeUsername, usernameProblem } from './rules'
import { endOtherSessions } from './sessions'
import { hasWayIn, putBack } from './wayIn'

// Nothing to put back when no admin feature stepped aside.
const NO_ASIDE = { restore: async () => {
  await Promise.resolve()
} }

export type ChangePasswordResult = { ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem | 'breached' } }

// Sets the signed-in user's password, or a first one, and ends their other sessions.
export async function changePassword(state: RequestState, proof: Proof, password: string): Promise<ChangePasswordResult> {
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

export type UpdateLocaleResult = { ok: true } | { ok: false, error: 'signed-out' | 'invalid-locale' }

// Sets the language the signed-in user's mails are written in, a BCP 47 tag such as `fr`.
export async function updateLocale(state: RequestState, locale: string): Promise<UpdateLocaleResult> {
  const record = await state.current()

  if (!record)
    return { ok: false, error: 'signed-out' }

  if (!validLocale(locale))
    return { ok: false, error: 'invalid-locale' }

  state.adopt(await state.core.store.users.update(record.id, { locale }) ?? { ...record, locale })

  return { ok: true }
}

export type ChangeUsernameResult = { ok: true, user: BareUser } | { ok: false, error: 'signed-out' } | { ok: false, errors: { username: UsernameProblem | 'taken' | 'unchanged' } }

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

export type UnlinkResult = { ok: true } | { ok: false, error: ProofFailure | 'not-linked' | 'last-way-in' }

// Unlinks a provider from the signed-in user, unless it is their last way in, and ends their other sessions.
export async function unlink(state: RequestState, provider: string, proof: Proof): Promise<UnlinkResult> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const { record } = proved
  const identities = await state.core.store.identities.listByUser(record.id)
  const identity = identities.find(entry => entry.provider === provider)

  if (!identity)
    return { ok: false, error: 'not-linked' }

  if (!await hasWayIn(state.core, record.id, { identity }))
    return { ok: false, error: 'last-way-in' }

  await state.core.store.identities.delete(identity.provider, identity.providerId)

  // Two requests can each see the other way in still there: when none is left, the identity goes back.
  if (!await hasWayIn(state.core, record.id)) {
    await putBack(state.core, record.id, async () => state.core.store.identities.create(identity))

    return { ok: false, error: 'last-way-in' }
  }

  await (await import('./oauth/flow')).revokeUpstream(state.core, identity)
  await endOtherSessions(state, record)
  await notify(state, record, 'provider-unlinked', provider)

  return { ok: true }
}

export type DeleteAccountResult = { ok: true } | { ok: false, error: ProofFailure | 'last-admin' | 'last-owner' }

// Deletes the signed-in user and everything kayjs-auth keeps for them, then signs this session out. The last admin, and the only owner of an organization with other members, are refused before the proof is spent; an organization the user is alone in is deleted with them.
export async function deleteAccount(state: RequestState, proof: Proof, signOut: () => Promise<void>): Promise<DeleteAccountResult> {
  const current = await state.current()
  // Without the `admin` option nobody is an admin: no last one to keep and no roles to set aside.
  const admins = state.core.admin ? await import('./admin') : undefined

  if (current && admins && await admins.lastAdmin(state, current))
    return { ok: false, error: 'last-admin' }

  if (current && (await soleOwned(state.core, current)).some(organization => !organization.alone))
    return { ok: false, error: 'last-owner' }

  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const aside = admins
    ? await admins.stepAside(state, proved.record)
    : NO_ASIDE

  if (!aside)
    return { ok: false, error: 'last-admin' }

  let erased: Awaited<ReturnType<typeof eraseLeavingUser>>

  try {
    erased = await eraseLeavingUser(state, proved.record)
  }
  catch (error) {
    await aside.restore()

    throw error
  }

  if (!erased.ok) {
    await aside.restore()

    return erased
  }

  await signOut()

  return { ok: true }
}
