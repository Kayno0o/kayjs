import type { Core } from './core'
import type { Proof, ProofFailure } from './proof'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { nanoid } from '@kaynooo/utils'
import { report } from './events'
import { secondFactorLimited } from './guesses'
import { digest, totpContext } from './keys'
import { spend } from './limits'
import { notify } from './notify'
import { reprove } from './proof'
import { endOtherSessions } from './sessions'
import { generateTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from './totp'

const RECOVERY_CODE_COUNT = 10
// No 0, o, 1 or l, since these get copied by hand.
const RECOVERY_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
// About 74 bits: the stored digest is unsalted, so the safety comes from the code being out of reach.
const RECOVERY_CODE_LENGTH = 15
const NOT_CODE_CHARACTERS = /[^a-z0-9]/g
const EVERY_FIVE = /.{5}(?=.)/g

export interface TwoFactorSetup {
  // Base32, for typing into an authenticator by hand.
  secret: string
  // Draw it as a QR code with kayjs-ui's `QrCode`.
  uri: string
}

export type TwoFactorResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'expired' | 'limited' }

export async function verifyTwoFactor(state: RequestState, code: string, signIn: (record: UserRecord, method: string) => Promise<void>): Promise<TwoFactorResult> {
  const { store } = state.core
  const challenge = await state.session.get('authChallenge')
  const record = challenge && challenge.expires > Date.now() ? await store.users.get(challenge.user) : undefined

  if (!challenge || !record || record.sessionVersion !== challenge.version || record.totpEnabledAt === null)
    return { ok: false, error: 'expired' }

  // Six digits with three live at a time make about one guess in 333,000: the attempt budget is what makes the factor strong.
  if (await secondFactorLimited(state, record))
    return { ok: false, error: 'limited' }

  if (!(await spendSecondFactor(state, record, code))) {
    await report(state, record, 'sign-in-failed', 'two-factor')

    return { ok: false, error: 'invalid' }
  }

  await state.core.rates.reset(`two-factor:${record.id}`)
  await state.session.unset('authChallenge')
  await signIn(record, challenge.method ?? 'unknown')

  return { ok: true, redirect: challenge.redirect }
}

// A new secret for the signed-in user's authenticator, active once `enableTwoFactor` gets a code from it.
export async function setUpTwoFactor(state: RequestState, proof: Proof): Promise<{ ok: true, setup: TwoFactorSetup } | { ok: false, error: ProofFailure | 'enabled' }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  if (proved.record.totpEnabledAt !== null)
    return { ok: false, error: 'enabled' }

  const secret = generateTotpSecret()
  const uri = otpauthUri({ secret, account: proved.record.email ?? proved.record.username ?? proved.record.id, issuer: state.core.name })

  await state.core.store.users.update(proved.record.id, { totpSecret: state.core.keys.encrypt(secret, totpContext(proved.record.id)) })

  return { ok: true, setup: { secret, uri } }
}

// Turns the second factor on once the authenticator proves it holds the secret; answers the recovery codes, shown this once.
export async function enableTwoFactor(state: RequestState, code: string): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: 'signed-out' | 'not-set-up' | 'enabled' | 'invalid' | 'limited' }> {
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  if (record.totpEnabledAt !== null)
    return { ok: false, error: 'enabled' }

  const secret = record.totpSecret === null ? undefined : state.core.keys.decrypt(record.totpSecret, totpContext(record.id))

  if (secret === undefined)
    return { ok: false, error: 'not-set-up' }

  // Counted like a sign-in code: a session alone may not guess the pending secret's codes at will.
  if (await spend(state.core.rates, `two-factor:${state.client}`, state.core.limits.twoFactor) || await spend(state.core.rates, `enable-two-factor:${record.id}`, state.core.limits.twoFactorAccount))
    return { ok: false, error: 'limited' }

  const step = await verifyTotp(secret, code)

  if (step === undefined)
    return { ok: false, error: 'invalid' }

  await state.core.rates.reset(`enable-two-factor:${record.id}`)

  const updated = await endOtherSessions(state, record, { totpEnabledAt: new Date(), totpLastStep: step })

  if (updated)
    await notify(state, updated, 'two-factor-enabled')

  return { ok: true, recoveryCodes: await issueRecoveryCodes(state.core, record.id) }
}

// What `enrollTotp` hands a test: the authenticator's secret, a code for the current step (or one `offset` steps on), and the recovery codes.
export interface TotpEnrolment {
  secret: string
  code: (offset?: number) => Promise<string>
  recoveryCodes: string[]
}

// Turns two-factor on for a member as the app would once they confirm a code, with no session, proof or mail, for a test; the code of the current step stays unspent, so it signs in.
export async function enrollTotp(core: Core, userId: string): Promise<TotpEnrolment> {
  const record = await core.store.users.get(userId)

  if (!record)
    throw new Error(`kayjs-auth: enrollTotp found no member with id ${userId}`)

  if (record.totpEnabledAt !== null)
    throw new Error('kayjs-auth: enrollTotp found a member who already has two-factor')

  const secret = generateTotpSecret()

  await core.store.users.update(userId, { totpSecret: core.keys.encrypt(secret, totpContext(userId)), totpEnabledAt: new Date(), totpLastStep: 0 })

  return { secret, code: async (offset = 0) => totpCode(secret, totpStep() + offset), recoveryCodes: await issueRecoveryCodes(core, userId) }
}

export async function disableTwoFactor(state: RequestState, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
  const proved = await reprove(state, proof, { secondFactor: true })

  if (!proved.ok)
    return proved

  await state.core.store.recoveryCodes.replace(proved.record.id, [])
  await endOtherSessions(state, proved.record, { totpSecret: null, totpEnabledAt: null })
  await notify(state, proved.record, 'two-factor-disabled')

  return { ok: true }
}

// A new set of recovery codes, the old ones void.
export async function regenerateRecoveryCodes(state: RequestState, proof: Proof): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: ProofFailure | 'disabled' }> {
  const proved = await reprove(state, proof, { secondFactor: true })

  if (!proved.ok)
    return proved

  if (proved.record.totpEnabledAt === null)
    return { ok: false, error: 'disabled' }

  const recoveryCodes = await issueRecoveryCodes(state.core, proved.record.id)

  await endOtherSessions(state, proved.record)
  await notify(state, proved.record, 'recovery-codes-regenerated')

  return { ok: true, recoveryCodes }
}

// An authenticator code, its step recorded so it works once; or a recovery code, spent.
export async function spendSecondFactor(state: RequestState, record: UserRecord, code: string): Promise<'totp' | 'recovery' | undefined> {
  const { core } = state
  const secret = record.totpSecret === null ? undefined : core.keys.decrypt(record.totpSecret, totpContext(record.id))
  const step = secret === undefined ? undefined : await verifyTotp(secret, code)

  if (step !== undefined)
    return await core.store.users.advanceTotpStep(record.id, step) ? 'totp' : undefined

  const normalized = code.toLowerCase().replace(NOT_CODE_CHARACTERS, '')

  if (normalized.length !== RECOVERY_CODE_LENGTH || !(await core.store.recoveryCodes.consume(record.id, digest(normalized))))
    return undefined

  await notify(state, record, 'recovery-code-used')

  return 'recovery'
}

// Grouped by five, `abcde-fghij-klmno`, since a wall of characters is where people misread.
async function issueRecoveryCodes(core: Core, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => nanoid(RECOVERY_CODE_LENGTH, RECOVERY_CODE_ALPHABET))

  await core.store.recoveryCodes.replace(userId, codes.map(code => digest(code)))

  return codes.map(code => code.replace(EVERY_FIVE, '$&-'))
}
