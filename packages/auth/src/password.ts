import type { User } from './core'
import type { EmailProblem, PasswordProblem, UsernameProblem } from './rules'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, hashPassword, passwordNeedsRehash } from '@kaynooo/utils'
import { newUserRecord, publicUser } from './core'
import { randomToken } from './keys'
import { exhausted, spend } from './limits'
import { safeRedirect } from './oauth/redirect'
import { emailProblem, normalizeEmail, normalizeUsername, PASSWORD_MAX_LENGTH, passwordProblem, usernameProblem } from './rules'

export interface RegisterInput {
  email: string
  password: string
  username?: string
}

// Why a field was refused, by field, as codes a form turns into messages in its own words and language.
export interface RegisterErrors {
  email?: EmailProblem | 'taken'
  password?: PasswordProblem
  username?: UsernameProblem | 'taken'
}

export type RegisterResult = { ok: true, user: User } | { ok: false, errors: RegisterErrors } | { ok: false, error: 'limited' }

export interface PasswordSignInInput {
  // An email, or a username when it holds no `@`.
  identifier: string
  password: string
  // Where to go once signed in, a path on the site; `/` by default.
  redirect?: string
}

// `invalid` whether no account matches or the password is wrong, so the answer tells nothing of which accounts exist.
export type PasswordSignInResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'limited' }

let decoy: Promise<string> | undefined

// A new user with a password, signed in on this session.
export async function register(state: RequestState, input: RegisterInput): Promise<RegisterResult> {
  const { store, limits } = state.core

  if (await spend(store, `register:${state.client}`, limits.register))
    return { ok: false, error: 'limited' }

  const email = normalizeEmail(input.email)
  const username = input.username === undefined ? null : normalizeUsername(input.username)
  const errors: RegisterErrors = {
    email: emailProblem(email),
    password: passwordProblem(input.password),
    username: username === null ? undefined : usernameProblem(username),
  }

  if (!errors.email && await store.users.findByEmail(email))
    errors.email = 'taken'

  if (username !== null && !errors.username && await store.users.findByUsername(username))
    errors.username = 'taken'

  if (errors.email || errors.password || errors.username)
    return { ok: false, errors: withoutUndefined(errors) }

  const record = newUserRecord({ email, username, passwordHash: await hashPassword(input.password) })

  try {
    await store.users.create(record)
  }
  // Another request took the email or the name in between.
  catch {
    return { ok: false, errors: await store.users.findByEmail(email) ? { email: 'taken' } : { username: 'taken' } }
  }

  const user = publicUser(record)

  await state.core.onSignUp?.(user, undefined)
  await state.complete(record, '/')

  return { ok: true, user }
}

export async function signInWithPassword(state: RequestState, input: PasswordSignInInput): Promise<PasswordSignInResult> {
  const { store, limits } = state.core
  const byEmail = input.identifier.includes('@')
  const identifier = byEmail ? normalizeEmail(input.identifier) : normalizeUsername(input.identifier)
  // Keyed by what was typed, so guessing at an account that does not exist runs out the same way.
  const accountKey = `sign-in:${identifier}`

  if (await spend(store, `sign-in:${state.client}`, limits.signIn) || await exhausted(store, accountKey, limits.signInAccount))
    return { ok: false, error: 'limited' }

  // No password this long was ever accepted, and hashing it would cost the server for nothing.
  const record = input.password.length > PASSWORD_MAX_LENGTH
    ? undefined
    : byEmail ? await store.users.findByEmail(identifier) : await store.users.findByUsername(identifier)

  if (input.password.length > PASSWORD_MAX_LENGTH || !(await passwordMatches(record, input.password))) {
    await spend(store, accountKey, limits.signInAccount)

    return { ok: false, error: 'invalid' }
  }

  await store.attempts.reset(accountKey)

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
