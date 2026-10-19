import type { Duration } from 'kay'
import type { Core } from './core'
import type { MailData, Mailer, Templates } from './mail'
import type { EmailProblem, PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { CodeType, LinkType, TokenType, UserRecord } from './store'
import type { Proof, ProofFailure } from './twoFactor'
import { hashPassword, nanoid } from '@kaynooo/utils'
import { localPath } from 'kay'
import { durationSeconds } from 'kay/library'
import { newPasswordProblem } from './breached'
import { admit } from './captcha'
import { banned, homeOf } from './core'
import { forgive, passwordMatches, startGuess } from './guesses'
import { digest, randomToken } from './keys'
import { spend, typedKey } from './limits'
import { log } from './log'
import { sendAside, writing } from './mail'
import { notify } from './notify'
import { emailProblem, normalizeEmail } from './rules'
import { endOtherSessions, removeIdentities, revokeBearerTokens } from './sessions'
import { reprove } from './twoFactor'

const MINUTE = 60
const HOUR = 60 * MINUTE

// How long each link and code works, in seconds, unless the `email.expires` option says otherwise.
const TOKEN_LIFETIMES: Record<TokenType, number> = {
  'verify-email': 24 * HOUR,
  'reset-password': HOUR,
  'magic-link': 15 * MINUTE,
  'change-email': HOUR,
  'sign-in-code': 10 * MINUTE,
  'verify-code': 10 * MINUTE,
}

// The lifetimes the `expires` option sets over the defaults, in seconds, a bad one failing at boot naming it.
export function tokenLifetimes(expires: EmailOptions['expires']): Record<TokenType, number> {
  const lifetimes = { ...TOKEN_LIFETIMES }
  const unknown = Object.keys(expires ?? {}).find(key => !Object.hasOwn(TOKEN_LIFETIMES, key))

  if (unknown !== undefined)
    throw new Error(`kayjs-auth: email.expires.${unknown} is no link or code of kayjs-auth`)

  for (const type of Object.keys(lifetimes) as TokenType[]) {
    const wanted = expires?.[type]

    if (wanted !== undefined)
      lifetimes[type] = durationSeconds(wanted, `email.expires.${type}`, 'kayjs-auth')
  }

  return lifetimes
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
  // Refuses password sign-in until the address is verified, and signs no one in on registering, so registering answers alike whether or not the address is held. On by default; `false` signs in on registering and answers `'taken'` for a held address.
  requireVerified?: boolean | undefined
  // How long an account registered and never verified is kept before it is deleted, `onDelete` first: seconds or a string such as '7d'. 30 days by default with `requireVerified`; without it accounts are kept unless this is set, as an unverified one may be in use.
  unverifiedMaxAge?: Duration | undefined
  // How long each link and code works, over the defaults: `{ 'verify-email': '7d' }` for invited users. The keys are the four links, `verify-email`, `reset-password`, `magic-link` and `change-email`, and the two codes, `sign-in-code` and `verify-code`; the mails state what is set.
  expires?: Partial<Record<TokenType, Duration>> | undefined
  // Whether magic links and verification mails carry a code, for both kinds at once or for each: `'both'`, `{ 'magic-link': 'code' }`. A link only by default.
  codes?: CodeMode | Partial<Record<CodedLink, CodeMode>> | undefined
}

export type EmailCore = Required<Omit<EmailOptions, 'links' | 'templates' | 'requireVerified' | 'unverifiedMaxAge' | 'codes' | 'locales' | 'translations' | 'expires'>> & { expires: Record<TokenType, number>, links: Record<LinkType, string>, requireVerified: boolean, locales: string[], templates: Record<string, Templates>, codes: Record<CodedLink, CodeMode> }

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

// Mails a new verification link to the signed-in user or, with nobody signed in, off the response's path to the account this browser registered or proved the password of.
export async function sendVerification(state: RequestState): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
  const current = await state.current()
  const registered = current ? undefined : await state.session.get('authRegistered')
  const record = current ?? (registered === undefined ? undefined : await state.core.store.users.get(registered))
  // Registered here for an address another account holds: answered as a new account's resend is, mailing no one.
  const held = record ? undefined : await state.session.get('authHeld')
  const email = record?.email ?? held

  if (email == null || email === '')
    return { ok: false, error: 'signed-out' }

  if (record && record.emailVerifiedAt !== null)
    return { ok: false, error: 'verified' }

  if (!state.core.email)
    return { ok: false, error: 'unavailable' }

  const refused = await spendResend(state, record?.id ?? `held:${email}`, 'resend')

  if (refused)
    return refused

  const nonce = await bindCode(state, 'verify-email', email)

  // The signed-in user's own address tells nothing, so a failing mailer fails the call.
  if (current)
    await issue(state, current, 'verify-email', email, null, nonce)
  else if (record)
    void issueQuietly(state, record, 'verify-email', email, null, nonce)

  return { ok: true }
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

  return { ok: true, redirect: current?.id === record.id ? homeOf(state.core) : state.core.signInPage }
}

// Counted as a sign-in attempt on the account, since it is one.
async function holdsPassword(state: RequestState, record: UserRecord, password: string | undefined): Promise<true | 'confirm' | 'limited'> {
  if (password === undefined)
    return 'confirm'

  const guess = await startGuess(state, record, '')

  if (guess === 'limited')
    return 'limited'

  // An account without a password is checked against a decoy, so the time does not tell it has none.
  if (!await passwordMatches(record, password))
    return 'confirm'

  await forgive(state, guess)

  return true
}

export async function requestPasswordReset(state: RequestState, email: string, captcha?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'reset-password', null, captcha)
}

// Sets the password the link was sent for and ends every other session the user held.
export async function resetPassword(state: RequestState, token: string, password: string): Promise<ResetPasswordResult> {
  // Counted before the breached-password service is asked, so forged links cannot make the server call it without end.
  if (await spend(state.core.store, `link:${state.client}`, state.core.limits.link))
    return { ok: false, error: 'limited' }

  const problem = await newPasswordProblem(state.core, password)

  // Checked before the token is spent, so a refused password leaves the link usable.
  if (problem !== undefined)
    return { ok: false, errors: { password: problem } }

  const spent = await spendLink(state, token, 'reset-password', true)

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

  return state.complete(record, homeOf(state.core), 'reset-password')
}

export async function requestMagicLink(state: RequestState, email: string, redirect?: string, captcha?: string): Promise<MailRequestResult> {
  return mailByAddress(state, email, 'magic-link', localPath(redirect, homeOf(state.core)), captcha)
}

export async function signInWithMagicLink(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'magic-link')

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null
    ? await state.core.store.users.update(spent.record.id, { ...await claim(state.core, spent.record), emailVerifiedAt: new Date() }) ?? spent.record
    : spent.record

  // The browser opening the link signs in as the one that asked for it chose, which a link opened elsewhere would otherwise lose.
  if (spent.remember !== undefined)
    await state.session.set('authRemember', spent.remember)

  return state.complete(record, spent.token.redirect ?? homeOf(state.core), 'magic-link')
}

// Mails the new address a link confirming it; the account keeps the old one until then.
export async function changeEmail(state: RequestState, proof: Proof, email: string): Promise<ChangeEmailResult> {
  const proved = await reprove(state, proof, { secondFactor: true })

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

  return mailFor(state, record, 'change-email', address, null)
}

// Moves the account to the address the link was sent to, and ends the user's other sessions.
export async function confirmEmailChange(state: RequestState, token: string): Promise<LinkResult> {
  const spent = await spendLink(state, token, 'change-email')

  if (!spent.ok)
    return spent

  const { store } = state.core

  if (await store.users.findByEmail(spent.token.email))
    return { ok: false, error: 'invalid' }

  const record = await endOtherSessions(state, spent.record, { email: spent.token.email, emailVerifiedAt: new Date() })

  if (!record)
    return { ok: false, error: 'invalid' }

  await store.tokens.deleteForUser(record.id)
  // To the address the account left, which is the one a thief would want silent.
  await notify(state, record, 'email-changed', record.email!, spent.record.emailVerifiedAt === null ? null : spent.record.email)

  return { ok: true, redirect: homeOf(state.core) }
}

// On registering: the verification mail, when the app sends mail.
export async function welcome(state: RequestState, record: UserRecord): Promise<void> {
  if (state.core.email && record.email !== null && record.email !== '')
    void issueQuietly(state, record, 'verify-email', record.email, null, await bindCode(state, 'verify-email', record.email))
}

// A registration for an address an account holds already, where registering signs no one in: this session is left as a new account's would be, and the holder is told, off the response's path and at most a few times an hour.
export async function warnHolder(state: RequestState, holder: UserRecord): Promise<void> {
  const { core } = state
  const mail = core.email
  const email = holder.email

  if (!mail || email === null || email === '')
    return

  await bindCode(state, 'verify-email', email)

  if (await spend(core.store, `account-exists:${holder.id}`, core.limits.resendAccount))
    return

  const { locale, templates } = writing(mail, [holder.locale, ...state.languages])
  const url = `${core.url}${core.signInPage}`

  sendAside(mail, () => ({ to: email, kind: 'account-exists', site: core.site, locale, url, ...templates['account-exists']({ site: core.site, email, url, locale }) }), 'account-exists')
}

// Signs in with the code a magic link mail carried, in the session that asked for it.
export async function signInWithEmailCode(state: RequestState, code: string): Promise<CodeResult> {
  const spent = await spendCode(state, 'sign-in-code', code)

  if (!spent.ok)
    return spent

  const record = spent.record.emailVerifiedAt === null
    ? await state.core.store.users.update(spent.record.id, { ...await claim(state.core, spent.record), emailVerifiedAt: new Date() }) ?? spent.record
    : spent.record

  return state.complete(record, spent.token.redirect ?? homeOf(state.core), 'email-code')
}

// Verifies the address with the code its verification mail carried, in the session that asked for it, which registered the account or is signed in as it.
export async function verifyEmailCode(state: RequestState, code: string): Promise<CodeResult> {
  const spent = await spendCode(state, 'verify-code', code)

  if (!spent.ok)
    return spent

  await state.core.store.users.update(spent.record.id, { emailVerifiedAt: new Date() })

  return { ok: true, redirect: (await state.current())?.id === spent.record.id ? homeOf(state.core) : state.core.signInPage }
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

  await state.session.set('authEmailCode', { type: codeType, email, nonce, expires: Date.now() + state.core.email!.expires[codeType] * 1000 })

  return nonce
}

// Spends the code this session waits for; a code dies after a few misses, and the guesses count per client and per address.
async function spendCode(state: RequestState, type: CodeType, code: string) {
  const { core } = state
  const pending = await state.session.get('authEmailCode')

  if (!pending || pending.type !== type || pending.expires < Date.now())
    return { ok: false, error: 'expired' } as const

  if (await spend(core.store, `email-code:${state.client}`, core.limits.emailCode) || await spend(core.store, typedKey(core, 'email-code', pending.email), core.limits.emailCodeAccount))
    return { ok: false, error: 'limited' } as const

  const spent = await core.store.tokens.consume(codeDigest(state.core, pending.nonce, code.replace(NOT_DIGITS, '')), type)
  const record = spent && await core.store.users.get(spent.userId)

  if (!spent || !record || record.email !== spent.email) {
    if (await core.store.attempts.hit(`email-code-miss:${pending.nonce}`, core.email!.expires[type]) < CODE_MISSES)
      return { ok: false, error: 'invalid' } as const

    // Only this session's pending code is dropped: the holder's live code may be one another session asked for, and it is unreachable from here anyway, since its digest binds that session's nonce.
    await state.session.unset('authEmailCode')

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

  if (await spend(core.store, typedKey(core, limit, address), core.limits[`${limit}Account`]))
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

async function mailFor(state: RequestState, record: UserRecord, type: LinkType, email: string, redirect: string | null): Promise<{ ok: true } | { ok: false, error: 'limited' | 'unavailable' }> {
  const { core } = state

  if (!core.email)
    return { ok: false, error: 'unavailable' }

  const refused = await spendResend(state, record.id, 'emailChange')

  if (refused)
    return refused

  await issue(state, record, type, email, redirect, await bindCode(state, type, email))

  return { ok: true }
}

// Counted per client and per account, so neither one sender nor many can flood an inbox.
async function spendResend(state: RequestState, id: string, limit: 'resend' | 'emailChange'): Promise<{ ok: false, error: 'limited' } | undefined> {
  const { core } = state

  if (await spend(core.store, `${limit}:${state.client}`, core.limits[limit]) || await spend(core.store, `${limit}:${id}`, core.limits[`${limit}Account`]))
    return { ok: false, error: 'limited' }

  return undefined
}

// The seconds the link and the code of a mail work, for the ones it carries.
function lifetimesOf(mail: EmailCore, type: LinkType, content: { url?: string, code?: string }): MailData['expires'] {
  return { ...content.url === undefined ? {} : { link: mail.expires[type] }, ...content.code === undefined ? {} : { code: mail.expires[CODE_OF[type as CodedLink]] } }
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
    const token = randomToken() + await rememberMark(state, type)

    content.url = `${core.url}${mail.links[type]}?token=${token}`
    await core.store.tokens.create({ digest: digest(type === 'magic-link' ? unmarked(token) : token), type, userId: record.id, email, redirect, expiresAt: new Date(Date.now() + mail.expires[type] * 1000) })
  }

  if (mode !== 'link' && nonce !== undefined) {
    const codeType = CODE_OF[type as CodedLink]
    const code = nanoid(CODE_LENGTH, DIGITS)

    content.code = code
    await core.store.tokens.deleteForUser(record.id, codeType)
    await core.store.tokens.create({ digest: codeDigest(core, nonce, code), type: codeType, userId: record.id, email, redirect, expiresAt: new Date(Date.now() + mail.expires[codeType] * 1000) })
  }

  const { locale, templates } = writing(mail, [record.locale, ...state.languages])

  const expires = lifetimesOf(mail, type, content)

  await mail.mailer.send({ to: email, kind: type, site: core.site, locale, ...content, expires, ...templates[type]({ site: core.site, email, locale, ...content, expires }) })
}

// The token's user, once the token is spent; a link for an address the account no longer has is spent for nothing.
async function spendLink(state: RequestState, token: string, type: LinkType, counted = false) {
  const { store, limits } = state.core

  if (!counted && await spend(store, `link:${state.client}`, limits.link))
    return { ok: false, error: 'limited' } as const

  const spent = await store.tokens.consume(digest(type === 'magic-link' ? unmarked(token) : token), type)
  const record = spent && await store.users.get(spent.userId)

  if (!spent || !record || (type !== 'change-email' && record.email !== spent.email))
    return { ok: false, error: 'invalid' } as const

  // The code the same mail carried is spent with it.
  if (type in CODE_OF)
    await store.tokens.deleteForUser(record.id, CODE_OF[type as CodedLink])

  return { ok: true, token: spent, record, remember: type === 'magic-link' ? rememberOf(token) : undefined } as const
}

// A magic link carries the remember choice of the browser that asked for it as a suffix of its token, so the browser opening it, perhaps another, signs in as chosen. The store keeps the digest of the token without it; stripping or adding one changes only the link holder's own session.
const REMEMBER_MARK = '.r'
const FORGET_MARK = '.b'

async function rememberMark(state: RequestState, type: LinkType): Promise<string> {
  if (type !== 'magic-link')
    return ''

  const remember = await state.session.get('authRemember')

  if (remember === undefined)
    return ''

  return remember ? REMEMBER_MARK : FORGET_MARK
}

function unmarked(token: string): string {
  return token.endsWith(REMEMBER_MARK) || token.endsWith(FORGET_MARK) ? token.slice(0, -2) : token
}

function rememberOf(token: string): boolean | undefined {
  if (token.endsWith(REMEMBER_MARK))
    return true

  if (token.endsWith(FORGET_MARK))
    return false

  return undefined
}

// An address proved for the first time by a link its owner asked for: whatever was set on the account before, perhaps by a stranger who registered the address first, is dropped, so the owner gets the account clean.
async function claim(core: Core, record: UserRecord): Promise<Partial<UserRecord>> {
  if (record.emailVerifiedAt !== null)
    return {}

  await removeIdentities(core, record.id)

  for (const passkey of await core.store.passkeys.listByUser(record.id))
    await core.store.passkeys.delete(record.id, passkey.id)

  await core.store.recoveryCodes.replace(record.id, [])
  await revokeBearerTokens(core, record.id)
  // A link the stranger asked for before, such as moving the account to their own address, would take it back.
  await core.store.tokens.deleteForUser(record.id)

  return { passwordHash: null, totpSecret: null, totpEnabledAt: null, sessionVersion: record.sessionVersion + 1 }
}
