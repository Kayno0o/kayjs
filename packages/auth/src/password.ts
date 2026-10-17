import type { Core, User } from './core'
import type { EmailProblem, PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, hashPassword, passwordNeedsRehash } from '@kaynooo/utils'
import { localPath } from 'kay'
import { newPasswordProblem } from './breached'
import { admit } from './captcha'
import { homeOf, newUserRecord, publicUser } from './core'
import { warnHolder, welcome } from './email'
import { eraseUser } from './erase'
import { report } from './events'
import { randomToken } from './keys'
import { spend, typedKey } from './limits'
import { validLocale } from './locale'
import { emailProblem, normalizeEmail, normalizeUsername, PASSWORD_MAX_LENGTH, usernameProblem } from './rules'

export interface RegisterInput {
  email: string
  password: string
  username?: string
  /** @deprecated Given in the options after the input: `register(input, { captcha })`. */
  captcha?: string | undefined
  // The language the user reads, for their mails; the browser's by default.
  locale?: string | undefined
  /** @deprecated Given in the options after the input: `register(input, { remember })`. */
  remember?: boolean | undefined
}

// Why a field was refused, by field, as codes a form turns into messages in its own words and language.
export interface RegisterErrors {
  email?: EmailProblem | 'taken' | undefined
  // `breached` when the app checks for passwords known from a breach.
  password?: PasswordProblem | 'breached' | undefined
  username?: UsernameProblem | 'taken' | undefined
}

// `signedIn` is false, with no user, when the app wants the address verified first: the same answer whether the address was free or held, its holder mailed instead. `closed` with `signUp: false`.
export type RegisterResult = { ok: true, user: User, signedIn: true } | { ok: true, signedIn: false } | { ok: false, errors: RegisterErrors } | { ok: false, error: 'limited' | 'captcha' | 'closed' }

export interface CreateUserInput {
  // At least one of the two, the user signing in with either.
  email?: string | undefined
  username?: string | undefined
  // Without one the user signs in by provider, mailed link or passkey alone.
  password?: string | undefined
  // Given beside `defaultRoles`.
  roles?: string[] | undefined
  // Whether the address counts as verified, as when the app knows it is theirs: false by default.
  emailVerified?: boolean | undefined
  locale?: string | undefined
}

export type CreateUserResult = { ok: true, user: User } | { ok: false, errors: RegisterErrors }

export interface PasswordSignInInput {
  // An email, or a username when it holds no `@`.
  identifier: string
  password: string
  /** @deprecated Given in the options after the input: `signInWithPassword(input, { redirect })`. */
  redirect?: string | undefined
  /** @deprecated Given in the options after the input: `signInWithPassword(input, { captcha })`. */
  captcha?: string | undefined
  /** @deprecated Given in the options after the input: `signInWithPassword(input, { remember })`. */
  remember?: boolean | undefined
}

// `invalid` whether no account matches or the password is wrong, so the answer tells nothing of which accounts exist.
// `unverified` once the password is right, when the app wants the address verified first.
export type PasswordSignInResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' | 'captcha' | 'unverified' | 'banned' }

let decoy: Promise<string> | undefined

// A new user with a password, signed in on this session; a guest signed in becomes it, keeping their id.
export async function register(state: RequestState, input: RegisterInput): Promise<RegisterResult> {
  const { store } = state.core

  if (!state.core.signUp)
    return { ok: false, error: 'closed' }

  const refused = await admit(state, 'register', input.captcha)

  if (refused)
    return { ok: false, error: refused }

  const email = normalizeEmail(input.email)
  const username = input.username === undefined ? null : normalizeUsername(input.username)
  const errors: RegisterErrors = {
    email: emailProblem(email),
    password: await newPasswordProblem(state.core, input.password),
    username: username === null ? undefined : usernameProblem(username, state.core.rules),
  }

  const holder = errors.email ? undefined : await store.users.findByEmail(email)
  const requireVerified = state.core.email?.requireVerified ?? false
  // An address registered and never verified, where unverified accounts cannot sign in, holds nothing worth keeping: registering again replaces it, so no one can squat an address they do not own. An account given roles beyond the default ones was set up on purpose, as by an admin inviting someone, and stays.
  const unclaimed = holder !== undefined && requireVerified && holder.emailVerifiedAt === null && holder.roles.every(role => state.core.defaultRoles.includes(role)) && (await store.identities.listByUser(holder.id)).length === 0

  // Where registering signs no one in, an address already held is answered as a new one is, so the answer tells nothing of which addresses exist.
  if (holder && !unclaimed && !requireVerified)
    errors.email = 'taken'

  // The unclaimed holder's own name is free with its address.
  if (username !== null && !errors.username) {
    const named = await store.users.findByUsername(username)

    if (named && !(unclaimed && named.id === holder?.id))
      errors.username = 'taken'
  }

  if (errors.email !== undefined || errors.password !== undefined || errors.username !== undefined)
    return { ok: false, errors: withoutUndefined(errors) }

  if (holder && !unclaimed)
    return answerHeld(state, holder, input.password)

  if (holder)
    await eraseUser(state.core, holder)

  const current = await state.current()
  const guest = current?.guest && state.via() === 'session' ? current : undefined
  const locale = input.locale !== undefined && validLocale(input.locale) ? input.locale : guest?.locale ?? state.languages[0] ?? null
  const fields = { email, username, passwordHash: await hashPassword(input.password), locale, guest: false }
  let record = guest ? { ...guest, ...fields } : newUserRecord({ ...fields, roles: [...state.core.defaultRoles] })

  try {
    record = guest ? await store.users.update(guest.id, fields) ?? record : (await store.users.create(record)) ?? record
  }
  // Another request took the email or the name in between; any other failure is the store's.
  catch (error) {
    const taken = await store.users.findByEmail(email)

    if (taken && requireVerified)
      return answerHeld(state, taken, null)

    if (taken)
      return { ok: false, errors: { email: 'taken' } }

    if (username !== null && await store.users.findByUsername(username))
      return { ok: false, errors: { username: 'taken' } }

    throw error
  }

  const user = publicUser(record)

  // A guest's records exist already.
  if (!guest)
    await state.core.onSignUp?.(user, undefined)

  // This browser may verify the address without signing in, as with `requireVerified` it cannot.
  await state.session.set('authRegistered', record.id)
  await state.session.unset('authHeld')
  await welcome(state, record)

  // A guest stays signed in: the account was theirs already.
  if (requireVerified && !guest)
    return { ok: true, signedIn: false }

  await state.complete(record, homeOf(state.core), 'register')

  return { ok: true, user, signedIn: true }
}

// A user made by the app, checked as registering is but signing no one in and mailing no one, open with `signUp: false` too.
export async function createUser(core: Core, input: CreateUserInput): Promise<CreateUserResult> {
  const email = input.email === undefined ? null : normalizeEmail(input.email)
  const username = input.username === undefined ? null : normalizeUsername(input.username)

  if (email === null && username === null)
    throw new Error('kayjs-auth: createUser needs an email or a username to sign in with')

  const undeclared = core.roles && input.roles?.find(role => !core.roles!.has(role))

  if (undeclared !== undefined)
    throw new Error(`kayjs-auth: createUser was given the role '${undeclared}', which the \`roles\` option does not declare`)

  const errors: RegisterErrors = {
    email: email === null ? undefined : emailProblem(email),
    password: input.password === undefined ? undefined : await newPasswordProblem(core, input.password),
    username: username === null ? undefined : usernameProblem(username, core.rules),
  }

  if (email !== null && !errors.email && await core.store.users.findByEmail(email))
    errors.email = 'taken'

  if (username !== null && !errors.username && await core.store.users.findByUsername(username))
    errors.username = 'taken'

  if (errors.email !== undefined || errors.password !== undefined || errors.username !== undefined)
    return { ok: false, errors: withoutUndefined(errors) }

  let record = newUserRecord({
    email,
    emailVerifiedAt: email !== null && input.emailVerified === true ? new Date() : null,
    username,
    passwordHash: input.password === undefined ? null : await hashPassword(input.password),
    roles: [...new Set([...core.defaultRoles, ...input.roles ?? []])],
    locale: input.locale !== undefined && validLocale(input.locale) ? input.locale : null,
  })

  try {
    record = (await core.store.users.create(record)) ?? record
  }
  // Another request took the email or the name in between; any other failure is the store's.
  catch (error) {
    if (email !== null && await core.store.users.findByEmail(email))
      return { ok: false, errors: { email: 'taken' } }

    if (username !== null && await core.store.users.findByUsername(username))
      return { ok: false, errors: { username: 'taken' } }

    throw error
  }

  const user = publicUser(record)

  await core.onSignUp?.(user, undefined)

  return { ok: true, user }
}

// Spends the time hashing a new password takes, so a held address answers no faster than a free one, and leaves this session as a new account's, which `sendVerification` answers alike, mailing no one.
async function answerHeld(state: RequestState, holder: UserRecord, password: string | null): Promise<RegisterResult> {
  if (password !== null)
    await hashPassword(password)

  await state.session.unset('authRegistered')
  await state.session.set('authHeld', holder.email!)
  await warnHolder(state, holder)

  return { ok: true, signedIn: false }
}

export async function signInWithPassword(state: RequestState, input: PasswordSignInInput): Promise<PasswordSignInResult> {
  const { store, limits } = state.core
  const byEmail = input.identifier.includes('@')
  const identifier = byEmail ? normalizeEmail(input.identifier) : normalizeUsername(input.identifier)

  const refused = await admit(state, 'sign-in', input.captcha)

  if (refused)
    return { ok: false, error: refused }

  // No password this long was ever accepted, and hashing it would cost the server for nothing. A ceiling the app lowered later still lets an older, longer one sign in.
  const tooLong = input.password.length > Math.max(PASSWORD_MAX_LENGTH, state.core.rules.password.max)
  const record = tooLong ? undefined : await (byEmail ? store.users.findByEmail(identifier) : store.users.findByUsername(identifier))
  // Counted against the account, so its email and every spelling of its name share one count, or against what was typed when none matches, so a guess at a missing account runs out the same way.
  const accountKey = record ? `sign-in-account:${record.id}` : typedKey(state.core, 'sign-in-account', identifier.toLowerCase())

  // Spent before the password is checked, so a burst of parallel guesses cannot all pass a count that only a failure would raise.
  if (await spend(store, accountKey, limits.signInAccount))
    return { ok: false, error: 'limited' }

  if (tooLong || !(await passwordMatches(record, input.password))) {
    if (record)
      await report(state, record, 'sign-in-failed', 'password')

    return { ok: false, error: 'invalid' }
  }

  await store.attempts.reset(accountKey)

  if (state.core.email?.requireVerified && record!.emailVerifiedAt === null) {
    // The password is proven: this browser may have the verification link resent, and confirm it, as the one that registered.
    await state.session.set('authRegistered', record!.id)

    return { ok: false, error: 'unverified' }
  }

  // Hashed with weaker settings, or by bcrypt in an older app: rehashed while the password is at hand.
  if (passwordNeedsRehash(record!.passwordHash!))
    await store.users.update(record!.id, { passwordHash: await hashPassword(input.password) })

  return state.complete(record!, localPath(input.redirect, homeOf(state.core)), 'password')
}

// Spends as long on an account without a password as on a wrong one, so the time taken tells nothing either.
async function passwordMatches(record: UserRecord | undefined, password: string): Promise<boolean> {
  if (record?.passwordHash != null && record.passwordHash !== '')
    return comparePasswords(password, record.passwordHash)

  decoy ??= hashPassword(randomToken())
  await comparePasswords(password, await decoy)

  return false
}

function withoutUndefined(errors: RegisterErrors): RegisterErrors {
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value !== undefined))
}
