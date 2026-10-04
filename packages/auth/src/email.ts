import type { Core } from './core'
import type { Mailer, Templates } from './mail'
import type { EmailProblem, PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { TokenType, UserRecord } from './store'
import { hashPassword } from '@kaynooo/utils'
import { digest, randomToken } from './keys'
import { spend } from './limits'
import { safeRedirect } from './oauth/redirect'
import { emailProblem, normalizeEmail, passwordProblem } from './rules'

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
  // The site's name, as mails write it.
  site: string
  // The app's page each link opens, the token in `?token=`. Each shows a button, or the new password's form, posting the token to an action, so a mail scanner opening the link spends nothing.
  links: Record<TokenType, string>
  templates?: Partial<Templates>
  // Refuses password sign-in until the address is verified, and signs no one in on registering.
  requireVerified?: boolean
}

export type EmailCore = Required<Omit<EmailOptions, 'templates'>> & { templates: Templates }

// Sent whether or not an account has that address, so the answer tells nothing of which ones exist.
export type MailRequestResult = { ok: true } | { ok: false, error: 'limited' | 'unavailable' }

export type LinkResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' }

export type ResetPasswordResult = LinkResult | { ok: false, errors: { password: PasswordProblem } }

export type ChangeEmailResult = { ok: true } | { ok: false, error: 'signed-out' | 'limited' | 'unavailable' } | { ok: false, errors: { email: EmailProblem | 'taken' | 'unchanged' } }

// Mails the signed-in user a link verifying their address.
export async function sendVerification(state: RequestState): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
  const record = await state.current()

  if (!record?.email)
    return { ok: false, error: 'signed-out' }

  if (record.emailVerifiedAt !== null)
    return { ok: false, error: 'verified' }

  return mailFor(state, record, 'verify-email', record.email, null, 'resend')
}

export async function verifyEmail(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'verify-email')

  if (!spent.ok)
    return spent

  const record = await state.core.store.users.update(spent.record.id, { emailVerifiedAt: new Date() }) ?? spent.record

  return { ok: true, redirect: await signedInOr(state, record, '/') }
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
    passwordHash: await hashPassword(password),
    // The mail reached that inbox, so the address is proved too.
    emailVerifiedAt: spent.record.emailVerifiedAt ?? new Date(),
    sessionVersion: spent.record.sessionVersion + 1,
  }) ?? spent.record

  await store.tokens.deleteForUser(record.id)

  return { ok: true, redirect: await state.complete(record, '/') }
}

export async function requestMagicLink(state: RequestState, email: string, redirect?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'magic-link', safeRedirect(redirect), 'magicLink')
}

export async function signInWithMagicLink(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'magic-link')

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null ? await state.core.store.users.update(spent.record.id, { emailVerifiedAt: new Date() }) ?? spent.record : spent.record

  return { ok: true, redirect: await state.complete(record, spent.token.redirect ?? '/') }
}

// Mails the new address a link confirming it; the account keeps the old one until then.
export async function changeEmail(state: RequestState, email: string): Promise<ChangeEmailResult> {
  const record = await state.current()

  if (!record)
    return { ok: false, error: 'signed-out' }

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

  return { ok: true, redirect: '/' }
}

// On registering: the verification mail, when the app sends mail.
export async function welcome(state: RequestState, record: UserRecord): Promise<void> {
  if (state.core.email && record.email)
    await issue(state.core, record, 'verify-email', record.email, null)
}

async function mailByAddress(state: RequestState, email: string, type: TokenType, redirect: string | null, limit: 'forgot' | 'magicLink'): Promise<MailRequestResult> {
  const address = normalizeEmail(email)
  const record = emailProblem(address) ? undefined : await state.core.store.users.findByEmail(address)

  if (!record)
    return await spend(state.core.store, `${limit}:${state.client}`, state.core.limits[limit]) ? { ok: false, error: 'limited' } : { ok: true }

  return mailFor(state, record, type, address, redirect, limit)
}

// Counted per client and per account, so neither one sender nor many can flood an inbox.
async function mailFor(state: RequestState, record: UserRecord, type: TokenType, email: string, redirect: string | null, limit: 'resend' | 'forgot' | 'magicLink' | 'emailChange'): Promise<MailRequestResult> {
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
  await mail.mailer.send({ to: email, kind: type, url, ...mail.templates[type]({ site: mail.site, email, url }) })
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

// Signs the user in unless this session already is, and answers where to go.
async function signedInOr(state: RequestState, record: UserRecord, redirect: string): Promise<string> {
  const current = await state.current()

  return current?.id === record.id ? redirect : state.complete(record, redirect)
}
