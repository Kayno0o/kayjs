import type { User } from './core'
import type { EmailProblem, PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, hashPassword, passwordNeedsRehash } from '@kaynooo/utils'
import { newPasswordProblem } from './breached'
import { admit } from './captcha'
import { newUserRecord, publicUser } from './core'
import { welcome } from './email'
import { randomToken } from './keys'
import { spend } from './limits'
import { safeRedirect } from './oauth/redirect'
import { emailProblem, normalizeEmail, normalizeUsername, PASSWORD_MAX_LENGTH, usernameProblem } from './rules'

export interface RegisterInput {
  email: string
  password: string
  username?: string
  // The CAPTCHA widget's token, when the app asks for one.
  captcha?: string | undefined
}

// Why a field was refused, by field, as codes a form turns into messages in its own words and language.
export interface RegisterErrors {
  email?: EmailProblem | 'taken' | undefined
  // `breached` when the app checks for passwords known from a breach.
  password?: PasswordProblem | 'breached' | undefined
  username?: UsernameProblem | 'taken' | undefined
}

// `signedIn` is false when the app wants the address verified first.
export type RegisterResult = { ok: true, user: User, signedIn: boolean } | { ok: false, errors: RegisterErrors } | { ok: false, error: 'limited' | 'captcha' }

export interface PasswordSignInInput {
  // An email, or a username when it holds no `@`.
  identifier: string
  password: string
  // Where to go once signed in, a path on the site; `/` by default.
  redirect?: string
  captcha?: string | undefined
}

// `invalid` whether no account matches or the password is wrong, so the answer tells nothing of which accounts exist.
// `unverified` once the password is right, when the app wants the address verified first.
export type PasswordSignInResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' | 'captcha' | 'unverified' }

let decoy: Promise<string> | undefined

// A new user with a password, signed in on this session.
export async function register(state: RequestState, input: RegisterInput): Promise<RegisterResult> {
  const { store } = state.core
  const refused = await admit(state, 'register', input.captcha)

  if (refused)
    return { ok: false, error: refused }

  const email = normalizeEmail(input.email)
  const username = input.username === undefined ? null : normalizeUsername(input.username)
  const errors: RegisterErrors = {
    email: emailProblem(email),
    password: await newPasswordProblem(state.core, input.password),
    username: username === null ? undefined : usernameProblem(username),
  }

  const holder = errors.email ? undefined : await store.users.findByEmail(email)
  const requireVerified = state.core.email?.requireVerified ?? false

  // An address registered and never verified, where unverified accounts cannot sign in, holds nothing worth keeping: registering again replaces it, so no one can squat an address they do not own. An account given roles beyond the default ones was set up on purpose, as by an admin inviting someone, and stays.
  if (holder && requireVerified && holder.emailVerifiedAt === null && holder.roles.every(role => state.core.defaultRoles.includes(role)) && (await store.identities.listByUser(holder.id)).length === 0) {
    await store.users.delete(holder.id)
    await state.core.onDelete?.(publicUser(holder))
  }
  else if (holder) {
    errors.email = 'taken'
  }

  if (username !== null && !errors.username && await store.users.findByUsername(username))
    errors.username = 'taken'

  if (errors.email || errors.password || errors.username)
    return { ok: false, errors: withoutUndefined(errors) }

  let record = newUserRecord({ email, username, passwordHash: await hashPassword(input.password), roles: [...state.core.defaultRoles] })

  try {
    record = (await store.users.create(record)) ?? record
  }
  // Another request took the email or the name in between; any other failure is the store's.
  catch (error) {
    if (await store.users.findByEmail(email))
      return { ok: false, errors: { email: 'taken' } }

    if (username !== null && await store.users.findByUsername(username))
      return { ok: false, errors: { username: 'taken' } }

    throw error
  }

  const user = publicUser(record)

  await state.core.onSignUp?.(user, undefined)
  // This browser may verify the address without signing in, as with `requireVerified` it cannot.
  await state.session.set('authRegistered', record.id)
  await welcome(state, record)

  if (requireVerified)
    return { ok: true, user, signedIn: false }

  await state.complete(record, '/')

  return { ok: true, user, signedIn: true }
}

export async function signInWithPassword(state: RequestState, input: PasswordSignInInput): Promise<PasswordSignInResult> {
  const { store, limits } = state.core
  const byEmail = input.identifier.includes('@')
  const identifier = byEmail ? normalizeEmail(input.identifier) : normalizeUsername(input.identifier)

  const refused = await admit(state, 'sign-in', input.captcha)

  if (refused)
    return { ok: false, error: refused }

  // No password this long was ever accepted, and hashing it would cost the server for nothing.
  const record = input.password.length > PASSWORD_MAX_LENGTH
    ? undefined
    : byEmail ? await store.users.findByEmail(identifier) : await store.users.findByUsername(identifier)
  // Counted against the account, so its email and every spelling of its name share one count, or against what was typed when none matches, so a guess at a missing account runs out the same way.
  const accountKey = `sign-in-account:${record?.id ?? identifier.toLowerCase()}`

  // Spent before the password is checked, so a burst of parallel guesses cannot all pass a count that only a failure would raise.
  if (await spend(store, accountKey, limits.signInAccount))
    return { ok: false, error: 'limited' }

  if (input.password.length > PASSWORD_MAX_LENGTH || !(await passwordMatches(record, input.password)))
    return { ok: false, error: 'invalid' }

  await store.attempts.reset(accountKey)

  if (state.core.email?.requireVerified && record!.emailVerifiedAt === null) {
    // The password is proven: this browser may have the verification link resent, and confirm it, as the one that registered.
    await state.session.set('authRegistered', record!.id)

    return { ok: false, error: 'unverified' }
  }

  // Hashed with weaker settings, or by bcrypt in an older app: rehashed while the password is at hand.
  if (passwordNeedsRehash(record!.passwordHash!))
    await store.users.update(record!.id, { passwordHash: await hashPassword(input.password) })

  return { ok: true, redirect: await state.complete(record!, safeRedirect(input.redirect)) }
}

// Spends as long on an account without a password as on a wrong one, so the time taken tells nothing either.
async function passwordMatches(record: UserRecord | undefined, password: string): Promise<boolean> {
  if (record?.passwordHash)
    return comparePasswords(password, record.passwordHash)

  decoy ??= hashPassword(randomToken())
  await comparePasswords(password, await decoy)

  return false
}

function withoutUndefined(errors: RegisterErrors): RegisterErrors {
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value !== undefined))
}
