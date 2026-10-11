import type { Core } from './core'
import type { Mailer, Templates } from './mail'
import type { EmailProblem, PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { CodeType, LinkType, TokenType, UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { comparePasswords, hashPassword, nanoid } from '@kaynooo/utils'
import { newPasswordProblem } from './breached'
import { admit } from './captcha'
import { banned } from './core'
import { digest, randomToken } from './keys'
import { spend } from './limits'
import { log } from './log'
import { writing } from './mail'
import { notify } from './notify'
import { safeRedirect } from './oauth/redirect'
import { emailProblem, normalizeEmail } from './rules'
import { reprove } from './twoFactor'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

// How long each link and code works.
const TOKEN_LIFETIME_MS: Record<TokenType, number> = {
  'verify-email': 24 * HOUR_MS,
  'reset-password': HOUR_MS,
  'magic-link': 15 * MINUTE_MS,
  'change-email': HOUR_MS,
  'sign-in-code': 10 * MINUTE_MS,
  'verify-code': 10 * MINUTE_MS,
}

const CODE_LENGTH = 6
// Wrong guesses one code takes before it dies, whatever the limits leave.
const CODE_MISSES = 5
const DIGITS = '0123456789'
const NOT_DIGITS = /\D/g

// The mails that can carry a code, and the code each carries.
export type CodedLink = 'magic-link' | 'verify-email'
const CODE_OF: Record<CodedLink, CodeType> = { 'magic-link': 'sign-in-code', 'verify-email': 'verify-code' }
const LINK_OF: Record<CodeType, CodedLink> = { 'sign-in-code': 'magic-link', 'verify-code': 'verify-email' }

// What a sign-in or verification mail carries: a link, a code typed on the device that asked for it, or both.
export type CodeMode = 'link' | 'code' | 'both'

export interface EmailOptions {
  mailer: Mailer
  // The app's page each link opens, the token in `?token=`, the prebuilt one by default with `pages`. Each shows a button, or the new password's form, posting the token to an action, so a mail scanner opening the link spends nothing.
  links?: Partial<Record<LinkType, string>> | undefined
  // Over kayjs-auth's own templates in every language.
  templates?: Partial<Templates> | undefined
  // The languages mails are written in, the first for a user whose language is none of them: `['en', 'fr']`. English only by default; kayjs-auth writes English and French, `translations` any other.
  locales?: string[] | undefined
  // Templates by language, over `templates`: `{ de: germanTemplates }`.
  translations?: Record<string, Partial<Templates>> | undefined
  // Refuses password sign-in until the address is verified, and signs no one in on registering.
  requireVerified?: boolean | undefined
  // Whether magic links and verification mails carry a code, for both kinds at once or for each: `'both'`, `{ 'magic-link': 'code' }`. A link only by default.
  codes?: CodeMode | Partial<Record<CodedLink, CodeMode>> | undefined
}

export type EmailCore = Required<Omit<EmailOptions, 'links' | 'templates' | 'requireVerified' | 'codes' | 'locales' | 'translations'>> & { links: Record<LinkType, string>, requireVerified: boolean, locales: string[], templates: Record<string, Templates>, codes: Record<CodedLink, CodeMode> }

// A code waiting in the session that asked for it, which alone can spend it.
export interface PendingCode {
  type: CodeType
  email: string
  // Mixed into the code's digest, so the code works in this session only.
  nonce: string
  expires: number
}

export type CodeResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'expired' | 'limited' | 'banned' }

// Sent whether or not an account has that address, so the answer tells nothing of which ones exist.
export type MailRequestResult = { ok: true } | { ok: false, error: 'limited' | 'captcha' | 'unavailable' }

export type LinkResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' | 'banned' }

export type VerifyEmailResult = LinkResult | { ok: false, error: 'confirm' }

export type ResetPasswordResult = LinkResult | { ok: false, errors: { password: PasswordProblem | 'breached' } }

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

export async function requestPasswordReset(state: RequestState, email: string, captcha?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'reset-password', null, captcha)
}

// Sets the password the link was sent for and ends every other session the user held.
export async function resetPassword(state: RequestState, token: string, password: string): Promise<ResetPasswordResult> {
  const problem = await newPasswordProblem(state.core, password)

  // Checked before the token is spent, so a refused password leaves the link usable.
  if (problem)
    return { ok: false, errors: { password: problem } }

  const spent = await spendLink(state, token, 'reset-password')

  if (!spent.ok)
    return spent

  // Before the password changes: a banned user keeps the account as the admin left it.
  if (banned(spent.record))
    return { ok: false, error: 'banned' }

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
  await notify(state, record, 'password-changed')

  return state.complete(record, '/', 'reset-password')
}

export async function requestMagicLink(state: RequestState, email: string, redirect?: string, captcha?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'magic-link', safeRedirect(redirect), captcha)
}

export async function signInWithMagicLink(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'magic-link')

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null
    ? await state.core.store.users.update(spent.record.id, { ...await claim(state.core, spent.record), emailVerifiedAt: new Date() }) ?? spent.record
    : spent.record

  return state.complete(record, spent.token.redirect ?? '/', 'magic-link')
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
  await notify(state, record, 'email-changed', record.email!, spent.record.emailVerifiedAt === null ? null : spent.record.email)

  return { ok: true, redirect: '/' }
}

// On registering: the verification mail, when the app sends mail.
export async function welcome(state: RequestState, record: UserRecord): Promise<void> {
  if (state.core.email && record.email)
    await issue(state, record, 'verify-email', record.email, null, await bindCode(state, 'verify-email', record.email))
}

// Signs in with the code a magic link mail carried, in the session that asked for it.
export async function signInWithEmailCode(state: RequestState, code: string): Promise<CodeResult> {
  const spent = await spendCode(state, 'sign-in-code', code)

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null
    ? await state.core.store.users.update(spent.record.id, { ...await claim(state.core, spent.record), emailVerifiedAt: new Date() }) ?? spent.record
    : spent.record

  return state.complete(record, spent.token.redirect ?? '/', 'email-code')
}

// Verifies the address with the code its verification mail carried, in the session that asked for it, which registered the account or is signed in as it.
export async function verifyEmailCode(state: RequestState, code: string): Promise<CodeResult> {
  const spent = await spendCode(state, 'verify-code', code)

  if (!spent.ok)
    return spent

  await state.core.store.users.update(spent.record.id, { emailVerifiedAt: new Date() })

  return { ok: true, redirect: (await state.current())?.id === spent.record.id ? '/' : state.core.signInPage }
}

// The code this session waits for, for the page that asks for it.
export async function pendingCode(state: RequestState): Promise<{ type: 'sign-in' | 'verify', email: string } | null> {
  const pending = await state.session.get('authEmailCode')

  if (!pending || pending.expires < Date.now())
    return null

  return { type: pending.type === 'sign-in-code' ? 'sign-in' : 'verify', email: pending.email }
}

// Parks the code a mail is about to carry in this session, answering the nonce bound into it; undefined when the app sends links only.
async function bindCode(state: RequestState, type: LinkType, email: string): Promise<string | undefined> {
  if (!(type in CODE_OF) || state.core.email?.codes[type as CodedLink] === 'link')
    return undefined

  const nonce = randomToken()
  const codeType = CODE_OF[type as CodedLink]

  await state.session.set('authEmailCode', { type: codeType, email, nonce, expires: Date.now() + TOKEN_LIFETIME_MS[codeType] })

  return nonce
}

// Spends the code this session waits for; a code dies after a few misses, and the guesses count per client and per address.
async function spendCode(state: RequestState, type: CodeType, code: string) {
  const { core } = state
  const pending = await state.session.get('authEmailCode')

  if (!pending || pending.type !== type || pending.expires < Date.now())
    return { ok: false, error: 'expired' } as const

  if (await spend(core.store, `email-code:${state.client}`, core.limits.emailCode) || await spend(core.store, `email-code:${pending.email}`, core.limits.emailCodeAccount))
    return { ok: false, error: 'limited' } as const

  const spent = await core.store.tokens.consume(codeDigest(state.core, pending.nonce, code.replace(NOT_DIGITS, '')), type)
  const record = spent && await core.store.users.get(spent.userId)

  if (!spent || !record || record.email !== spent.email) {
    if (await core.store.attempts.hit(`email-code-miss:${pending.nonce}`, TOKEN_LIFETIME_MS[type] / 1000) < CODE_MISSES)
      return { ok: false, error: 'invalid' } as const

    await state.session.unset('authEmailCode')

    const holder = await core.store.users.findByEmail(pending.email)

    if (holder)
      await core.store.tokens.deleteForUser(holder.id, type)

    return { ok: false, error: 'expired' } as const
  }

  await state.session.unset('authEmailCode')
  // The link the same mail carried is spent with it.
  await core.store.tokens.deleteForUser(record.id, LINK_OF[type])

  return { ok: true, token: spent, record } as const
}

// Keyed, since six digits are no secret to whoever reads a plain digest out of the store.
function codeDigest(core: Core, nonce: string, code: string): string {
  return core.keys.fingerprint(`email-code\n${nonce}\n${code}`)
}

// Counted by address whether or not an account has it, and mailed off the response's path, so neither the answer nor its time tells which addresses exist.
async function mailByAddress(state: RequestState, email: string, type: 'reset-password' | 'magic-link', redirect: string | null, captcha: string | undefined): Promise<MailRequestResult> {
  const { core } = state

  if (!core.email)
    return { ok: false, error: 'unavailable' }

  const address = normalizeEmail(email)
  const limit = type === 'magic-link' ? 'magicLink' : 'forgot'
  const refused = await admit(state, type === 'magic-link' ? 'magic-link' : 'reset', captcha)

  if (refused)
    return { ok: false, error: refused }

  if (await spend(core.store, `${limit}:${address}`, core.limits[`${limit}Account`]))
    return { ok: false, error: 'limited' }

  // Parked whether or not an account has the address, so this session looks the same either way.
  const nonce = await bindCode(state, type, address)
  const record = emailProblem(address) ? undefined : await core.store.users.findByEmail(address)

  if (record)
    void issueQuietly(state, record, type, address, redirect, nonce)

  return { ok: true }
}

// Off the response's path, where no one is left to answer a failure to: logged.
async function issueQuietly(state: RequestState, record: UserRecord, type: LinkType, email: string, redirect: string | null, nonce: string | undefined): Promise<void> {
  try {
    await issue(state, record, type, email, redirect, nonce)
  }
  catch (error) {
    log.error(`mailing a ${type} link failed`, error)
  }
}

// Counted per client and per account, so neither one sender nor many can flood an inbox.
async function mailFor(state: RequestState, record: UserRecord, type: LinkType, email: string, redirect: string | null, limit: 'resend' | 'emailChange'): Promise<{ ok: true } | { ok: false, error: 'limited' | 'unavailable' }> {
  const { core } = state

  if (!core.email)
    return { ok: false, error: 'unavailable' }

  if (await spend(core.store, `${limit}:${state.client}`, core.limits[limit]) || await spend(core.store, `${limit}:${record.id}`, core.limits[`${limit}Account`]))
    return { ok: false, error: 'limited' }

  await issue(state, record, type, email, redirect, await bindCode(state, type, email))

  return { ok: true }
}

// One live link and code per kind and user: a new one replaces the last. A code goes only with the nonce of the session that asked for it.
// Written in the user's language, else the browser's.
async function issue(state: RequestState, record: UserRecord, type: LinkType, email: string, redirect: string | null, nonce: string | undefined): Promise<void> {
  const { core } = state
  const mail = core.email!
  const mode = type in CODE_OF ? mail.codes[type as CodedLink] : 'link'
  const content: { url?: string, code?: string } = {}

  await core.store.tokens.deleteForUser(record.id, type)

  if (mode !== 'code') {
    const token = randomToken()

    content.url = `${core.url}${mail.links[type]}?token=${token}`
    await core.store.tokens.create({ digest: digest(token), type, userId: record.id, email, redirect, expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS[type]) })
  }

  if (mode !== 'link' && nonce !== undefined) {
    const codeType = CODE_OF[type as CodedLink]
    const code = nanoid(CODE_LENGTH, DIGITS)

    content.code = code
    await core.store.tokens.deleteForUser(record.id, codeType)
    await core.store.tokens.create({ digest: codeDigest(core, nonce, code), type: codeType, userId: record.id, email, redirect, expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS[codeType]) })
  }

  const { locale, templates } = writing(mail, [record.locale, ...state.languages])

  await mail.mailer.send({ to: email, kind: type, site: core.site, locale, ...content, ...templates[type]({ site: core.site, email, locale, ...content }) })
}

// The token's user, once the token is spent; a link for an address the account no longer has is spent for nothing.
async function spendLink(state: RequestState, token: string, type: LinkType) {
  const { store, limits } = state.core

  if (await spend(store, `link:${state.client}`, limits.link))
    return { ok: false, error: 'limited' } as const

  const spent = await store.tokens.consume(digest(token), type)
  const record = spent && await store.users.get(spent.userId)

  if (!spent || !record || (type !== 'change-email' && record.email !== spent.email))
    return { ok: false, error: 'invalid' } as const

  // The code the same mail carried is spent with it.
  if (type in CODE_OF)
    await store.tokens.deleteForUser(record.id, CODE_OF[type as CodedLink])

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
