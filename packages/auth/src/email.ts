import type { Core } from './core'
import type { Mailer, Templates } from './mail'
import type { EmailProblem, PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { TokenType, UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { comparePasswords, hashPassword } from '@kaynooo/utils'
import { digest, randomToken } from './keys'
import { spend } from './limits'
import { notify } from './notify'
import { safeRedirect } from './oauth/redirect'
import { emailProblem, normalizeEmail, passwordProblem } from './rules'
import { reprove } from './twoFactor'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

// How long each link works.
const TOKEN_LIFETIME_MS: Record<TokenType, number> = {
  'verify-email': 24 * HOUR_MS,
  'reset-password': HOUR_MS,
  'magic-link': 15 * MINUTE_MS,
  'change-email': HOUR_MS,
}

export interface EmailOptions {
  mailer: Mailer
  // The app's page each link opens, the token in `?token=`. Each shows a button, or the new password's form, posting the token to an action, so a mail scanner opening the link spends nothing.
  links: Record<TokenType, string>
  templates?: Partial<Templates> | undefined
  // Refuses password sign-in until the address is verified, and signs no one in on registering.
  requireVerified?: boolean | undefined
}

export type EmailCore = Required<Omit<EmailOptions, 'templates'>> & { templates: Templates }

// Sent whether or not an account has that address, so the answer tells nothing of which ones exist.
export type MailRequestResult = { ok: true } | { ok: false, error: 'limited' | 'unavailable' }

export type LinkResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' }

export type VerifyEmailResult = LinkResult | { ok: false, error: 'confirm' }

export type ResetPasswordResult = LinkResult | { ok: false, errors: { password: PasswordProblem } }

export type ChangeEmailResult = { ok: true } | { ok: false, error: ProofFailure | 'unavailable' } | { ok: false, errors: { email: EmailProblem | 'taken' | 'unchanged' } }

// Mails a new verification link to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of.
export async function sendVerification(state: RequestState): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
  const registered = await state.session.get('authRegistered')
  const record = await state.current() ?? (registered === undefined ? undefined : await state.core.store.users.get(registered))

  if (!record?.email)
    return { ok: false, error: 'signed-out' }

  if (record.emailVerifiedAt !== null)
    return { ok: false, error: 'verified' }

  return mailFor(state, record, 'verify-email', record.email, null, 'resend')
}

// Verifies the address for the browser signed in as the account, the one that registered it or the one that proved its password; any other must give the account's password, since whoever opens the mail may be confirming an account a stranger registered with their address, which verified would stay the stranger's.
// Never signs in. Refused, the link stays usable where it can be confirmed.
export async function verifyEmail(state: RequestState, token: string, password?: string): Promise<VerifyEmailResult> {
  const spent = await spendLink(state, token, 'verify-email')

  if (!spent.ok)
    return spent

  const { record } = spent
  const current = await state.current()
  const ours = current?.id === record.id || await state.session.get('authRegistered') === record.id

  if (!ours) {
    const proved = await holdsPassword(state, record, password)

    if (proved !== true) {
      await state.core.store.tokens.create(spent.token)

      return { ok: false, error: proved }
    }
  }

  await state.core.store.users.update(record.id, { emailVerifiedAt: new Date() })

  return { ok: true, redirect: current?.id === record.id ? '/' : state.core.signInPage }
}

// Counted as a sign-in attempt on the account, since it is one.
async function holdsPassword(state: RequestState, record: UserRecord, password: string | undefined): Promise<true | 'confirm' | 'limited'> {
  if (password === undefined || !record.passwordHash)
    return 'confirm'

  if (await spend(state.core.store, `sign-in-account:${record.id}`, state.core.limits.signInAccount))
    return 'limited'

  return await comparePasswords(password, record.passwordHash) ? true : 'confirm'
}

export async function requestPasswordReset(state: RequestState, email: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'reset-password', null, 'forgot')
}

// Sets the password the link was sent for and ends every other session the user held.
export async function resetPassword(state: RequestState, token: string, password: string): Promise<ResetPasswordResult> {
  const problem = passwordProblem(password)

  // Checked before the token is spent, so a refused password leaves the link usable.
  if (problem)
    return { ok: false, errors: { password: problem } }

  const spent = await spendLink(state, token, 'reset-password')

  if (!spent.ok)
    return spent

  const { store } = state.core
  const record = await store.users.update(spent.record.id, {
    ...await claim(state.core, spent.record),
    passwordHash: await hashPassword(password),
    // The mail reached that inbox, so the address is proved too.
    emailVerifiedAt: spent.record.emailVerifiedAt ?? new Date(),
    sessionVersion: spent.record.sessionVersion + 1,
  }) ?? spent.record

  // Recovering an account ends every way into it the user did not just prove, devices included.
  await store.tokens.deleteForUser(record.id)
  await revokeBearerTokens(state.core, record.id)
  await notify(state.core, record, 'password-changed')

  return { ok: true, redirect: await state.complete(record, '/') }
}

export async function requestMagicLink(state: RequestState, email: string, redirect?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'magic-link', safeRedirect(redirect), 'magicLink')
}

export async function signInWithMagicLink(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'magic-link')

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null
    ? await state.core.store.users.update(spent.record.id, { ...await claim(state.core, spent.record), emailVerifiedAt: new Date() }) ?? spent.record
    : spent.record

  return { ok: true, redirect: await state.complete(record, spent.token.redirect ?? '/') }
}

// Mails the new address a link confirming it; the account keeps the old one until then.
export async function changeEmail(state: RequestState, proof: Proof, email: string): Promise<ChangeEmailResult> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const { record } = proved
  const address = normalizeEmail(email)
  const problem = emailProblem(address)

  if (problem)
    return { ok: false, errors: { email: problem } }

  if (address === record.email)
    return { ok: false, errors: { email: 'unchanged' } }

  if (await state.core.store.users.findByEmail(address))
    return { ok: false, errors: { email: 'taken' } }

  return mailFor(state, record, 'change-email', address, null, 'emailChange')
}

// Moves the account to the address the link was sent to, and ends the user's other sessions.
export async function confirmEmailChange(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'change-email')

  if (!spent.ok)
    return spent

  const { store } = state.core

  if (await store.users.findByEmail(spent.token.email))
    return { ok: false, error: 'invalid' }

  const record = await store.users.update(spent.record.id, { email: spent.token.email, emailVerifiedAt: new Date(), sessionVersion: spent.record.sessionVersion + 1 })

  if (!record)
    return { ok: false, error: 'invalid' }

  await store.tokens.deleteForUser(record.id)
  await state.renew(record)
  // To the address the account left, which is the one a thief would want silent.
  await notify(state.core, record, 'email-changed', record.email!, spent.record.emailVerifiedAt === null ? null : spent.record.email)

  return { ok: true, redirect: '/' }
}

// On registering: the verification mail, when the app sends mail.
export async function welcome(state: RequestState, record: UserRecord): Promise<void> {
  if (state.core.email && record.email)
    await issue(state.core, record, 'verify-email', record.email, null)
}

// Counted by address whether or not an account has it, and mailed off the response's path, so neither the answer nor its time tells which addresses exist.
async function mailByAddress(state: RequestState, email: string, type: TokenType, redirect: string | null, limit: 'forgot' | 'magicLink'): Promise<MailRequestResult> {
  const { core } = state

  if (!core.email)
    return { ok: false, error: 'unavailable' }

  const address = normalizeEmail(email)

  if (await spend(core.store, `${limit}:${state.client}`, core.limits[limit]) || await spend(core.store, `${limit}:${address}`, core.limits[`${limit}Account`]))
    return { ok: false, error: 'limited' }

  const record = emailProblem(address) ? undefined : await core.store.users.findByEmail(address)

  if (record)
    void issueQuietly(core, record, type, address, redirect)

  return { ok: true }
}

// Off the response's path, where no one is left to answer a failure to: logged.
async function issueQuietly(core: Core, record: UserRecord, type: TokenType, email: string, redirect: string | null): Promise<void> {
  try {
    await issue(core, record, type, email, redirect)
  }
  catch (error) {
    console.error(`kayjs-auth: mailing a ${type} link failed`, error)
  }
}

// Counted per client and per account, so neither one sender nor many can flood an inbox.
async function mailFor(state: RequestState, record: UserRecord, type: TokenType, email: string, redirect: string | null, limit: 'resend' | 'emailChange'): Promise<MailRequestResult> {
  const { core } = state

  if (!core.email)
    return { ok: false, error: 'unavailable' }

  if (await spend(core.store, `${limit}:${state.client}`, core.limits[limit]) || await spend(core.store, `${limit}:${record.id}`, core.limits[`${limit}Account`]))
    return { ok: false, error: 'limited' }

  await issue(core, record, type, email, redirect)

  return { ok: true }
}

// One live link per kind and user: a new one replaces the last.
async function issue(core: Core, record: UserRecord, type: TokenType, email: string, redirect: string | null): Promise<void> {
  const mail = core.email!
  const token = randomToken()
  const url = `${core.url}${mail.links[type]}?token=${token}`

  await core.store.tokens.deleteForUser(record.id, type)
  await core.store.tokens.create({ digest: digest(token), type, userId: record.id, email, redirect, expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS[type]) })
  await mail.mailer.send({ to: email, kind: type, url, ...mail.templates[type]({ site: core.site, email, url }) })
}

// The token's user, once the token is spent; a link for an address the account no longer has is spent for nothing.
async function spendLink(state: RequestState, token: string, type: TokenType) {
  const { store, limits } = state.core

  if (await spend(store, `link:${state.client}`, limits.link))
    return { ok: false, error: 'limited' } as const

  const spent = await store.tokens.consume(digest(token), type)
  const record = spent && await store.users.get(spent.userId)

  if (!spent || !record || (type !== 'change-email' && record.email !== spent.email))
    return { ok: false, error: 'invalid' } as const

  return { ok: true, token: spent, record } as const
}

// An address proved for the first time by a link its owner asked for: whatever was set on the account before, perhaps by a stranger who registered the address first, is dropped, so the owner gets the account clean.
async function claim(core: Core, record: UserRecord): Promise<Partial<UserRecord>> {
  if (record.emailVerifiedAt !== null)
    return {}

  for (const identity of await core.store.identities.listByUser(record.id))
    await core.store.identities.delete(identity.provider, identity.providerId)

  await core.store.recoveryCodes.replace(record.id, [])
  await revokeBearerTokens(core, record.id)
  // A link the stranger asked for before, such as moving the account to their own address, would take it back.
  await core.store.tokens.deleteForUser(record.id)

  return { passwordHash: null, totpSecret: null, totpEnabledAt: null, sessionVersion: record.sessionVersion + 1 }
}

export async function revokeBearerTokens(core: Core, userId: string): Promise<void> {
  for (const token of await core.store.bearerTokens.listByUser(userId))
    await core.store.bearerTokens.delete(userId, token.id)
}
