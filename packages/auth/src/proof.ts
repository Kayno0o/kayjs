import type { RequestState } from './state'
import type { UserRecord } from './store'
import type { AuthenticationResponseJSON } from './webauthn'
import { comparePasswords } from '@kaynooo/utils'
import { backOf, banned, withBack } from './core'
import { spend } from './limits'

const CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000
// How long a sign-in or a re-proof counts as proved: for an account with neither a password nor a second factor, and for an admin's changes to other users.
const FRESH_SIGN_IN_MS = 10 * 60 * 1000

// What re-proves the user behind a live session: their password, or with none their second factor, or one of their passkeys.
export interface Proof {
  password?: string
  // An authenticator code, or a recovery code.
  code?: string
  // A passkey's answer to `passkeys.proofOptions`, which stands for the password and the second factor both.
  passkey?: AuthenticationResponseJSON
}

// `proof` when the proof was wrong or missing; `stale` when the account has neither a password nor a second factor and was signed into too long ago, so the user signs in again first; `impersonating` when an admin acts as the user, who proves nothing for them.
export type ProofFailure = 'signed-out' | 'proof' | 'stale' | 'limited' | 'impersonating'

export type ReproveResult = { ok: true } | { ok: false, error: ProofFailure }

// What a sign-in waiting for its second factor keeps in the session.
export interface Challenge {
  user: string
  version: number
  redirect: string
  // How the first factor was proved, for the `signed-in` event.
  method?: string
  expires: number
}

// Signs `record` in, or when it has a second factor parks the sign-in until the code, and answers where the browser goes next.
export async function completeSignIn(state: RequestState, record: UserRecord, redirect: string, method: string, signIn: (record: UserRecord, method: string) => Promise<void>): Promise<{ ok: true, redirect: string } | { ok: false, error: 'banned' }> {
  if (banned(record))
    return { ok: false, error: 'banned' }

  if (record.totpEnabledAt === null) {
    await signIn(record, method)

    return { ok: true, redirect }
  }

  await state.session.set('authChallenge', { user: record.id, version: record.sessionVersion, redirect, method, expires: Date.now() + CHALLENGE_MAX_AGE_MS })

  // The code page carries the page asked for too, for the link back to sign-in when the challenge is gone by the time the code is typed.
  const back = backOf(state.core, redirect)

  return { ok: true, redirect: back === null ? state.core.twoFactorPage : withBack(state.core.twoFactorPage, back) }
}

// Whether this session holds a sign-in waiting for its second factor.
export async function challenged(state: RequestState): Promise<boolean> {
  const challenge = await state.session.get('authChallenge')

  return challenge !== undefined && challenge.expires > Date.now()
}

// The user signed in on a session (never a bearer token), once `proof` re-proves them, so a stolen session alone cannot change what protects the account.
// With `secondFactor`, an account with 2FA on proves it with a code, password or not, since a password alone must not turn off or replace what stands behind it.
export async function reprove(state: RequestState, proof: Proof, options: { secondFactor?: boolean } = {}): Promise<{ ok: true, record: UserRecord } | { ok: false, error: ProofFailure }> {
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  if ((await state.session.get('auth'))?.impersonator)
    return { ok: false, error: 'impersonating' }

  const twoFactor = record.totpEnabledAt !== null

  if (proof.passkey === undefined && record.passwordHash === null && !twoFactor)
    return await provedLately(state) ? { ok: true, record } : { ok: false, error: 'stale' }

  if (await spend(state.core.rates, `reprove:${record.id}`, state.core.limits.reprove))
    return { ok: false, error: 'limited' }

  let proved: boolean

  if (proof.passkey !== undefined)
    proved = await (await import('./passkeys')).provePasskey(state, record, proof.passkey)
  else if (record.passwordHash !== null && !(options.secondFactor && twoFactor))
    proved = await comparePasswords(proof.password ?? '', record.passwordHash)
  else
    proved = (await (await import('./twoFactor')).spendSecondFactor(state, record, proof.code ?? '')) !== undefined

  if (!proved)
    return { ok: false, error: 'proof' }

  await state.core.rates.reset(`reprove:${record.id}`)

  const signedIn = await state.session.get('auth')

  if (signedIn?.user === record.id)
    await state.session.set('auth', { ...signedIn, at: Date.now() })

  return { ok: true, record }
}

// Whether this session signed in or re-proved its user in the last ten minutes.
export async function provedLately(state: RequestState): Promise<boolean> {
  const signedIn = await state.session.get('auth')

  return signedIn !== undefined && Date.now() - signedIn.at < FRESH_SIGN_IN_MS
}
