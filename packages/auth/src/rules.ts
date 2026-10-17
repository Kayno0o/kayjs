// The credential rules, stated once so a form and the server agree. Browser-safe: an island imports them from `@kaynooo/kayjs-auth/rules` to refuse before posting, and the server checks every one again.

export const PASSWORD_MIN_LENGTH = 10
// Argon2id has no ceiling of its own, and an unbounded field is free CPU for whoever posts it.
export const PASSWORD_MAX_LENGTH = 128
export const USERNAME_MIN_LENGTH = 2
export const USERNAME_MAX_LENGTH = 32
const EMAIL_MAX_LENGTH = 254

// Loose on purpose: an address delivers or it does not, and a strict pattern refuses real addresses far more often than it catches a typo.
const EMAIL = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/
// Letters and digits in any script, with spaces, dots, hyphens and underscores inside only.
const USERNAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u
const WHITESPACE = /\s+/g
// The scripts a look-alike name reaches for: Latin, and the two that mimic it most.
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u]

export type EmailProblem = 'invalid'
// `too-short`, `too-long`, or the code or message an app's `check` returned.
export type PasswordProblem = 'too-short' | 'too-long' | (string & {})
export type UsernameProblem = 'length' | 'characters' | 'mixed-scripts'

// The form an email is stored, compared and looked up in.
export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase()
}

// The form a username is stored, compared and looked up in.
export function normalizeUsername(username: string): string {
  return username.normalize('NFKC').trim().replace(WHITESPACE, ' ')
}

// A name mixing Latin with Cyrillic or Greek, such as a Cyrillic `а` in `аlice`, would pass for another user's.
export function mixesConfusableScripts(value: string): boolean {
  return CONFUSABLE_SCRIPTS.filter(script => script.test(value)).length > 1
}

export function emailProblem(email: string): EmailProblem | undefined {
  const normalized = normalizeEmail(email)

  return EMAIL.test(normalized) && normalized.length <= EMAIL_MAX_LENGTH && !mixesConfusableScripts(normalized.slice(0, normalized.lastIndexOf('@'))) ? undefined : 'invalid'
}

// What an app sets over the defaults, in the `rules` option of `createAuth`, and the same object an island passes to `passwordProblem` and `usernameProblem`.
export interface CredentialRules {
  password?: {
    // 10 by default.
    min?: number | undefined
    // 128 by default: Argon2id has no ceiling of its own.
    max?: number | undefined
    // An extra rule on top of the length ones, returning a problem code or a message for what it refuses, such as `p => /\d/.test(p) ? undefined : 'Add a digit.'`. A message is shown as it is by the prebuilt pages unless the code has an `auth.fields.password.<code>` message.
    check?: ((password: string) => string | undefined) | undefined
  } | undefined
  username?: {
    // 2 by default.
    min?: number | undefined
    // 32 by default.
    max?: number | undefined
  } | undefined
}

// The rules with every limit set, as `features().rules` hands them to a page or an island.
export interface ResolvedRules {
  password: { min: number, max: number, check?: ((password: string) => string | undefined) | undefined }
  username: { min: number, max: number }
}

export const DEFAULT_RULES: ResolvedRules = { password: { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }, username: { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH } }

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined)
    return fallback

  if (!Number.isInteger(value) || value < 1)
    throw new Error(`kayjs-auth: rules.${name} is ${value}, a whole number of at least 1`)

  return value
}

// The rules with the defaults filled in, refusing a range that no value fits.
export function resolveRules(rules: CredentialRules = {}): ResolvedRules {
  const password = { min: limit(rules.password?.min, PASSWORD_MIN_LENGTH, 'password.min'), max: limit(rules.password?.max, PASSWORD_MAX_LENGTH, 'password.max'), check: rules.password?.check }
  const username = { min: limit(rules.username?.min, USERNAME_MIN_LENGTH, 'username.min'), max: limit(rules.username?.max, USERNAME_MAX_LENGTH, 'username.max') }

  if (password.min > password.max)
    throw new Error(`kayjs-auth: rules.password.min is ${password.min}, over rules.password.max ${password.max}`)

  if (username.min > username.max)
    throw new Error(`kayjs-auth: rules.username.min is ${username.min}, over rules.username.max ${username.max}`)

  return { password, username }
}

// The rules an app set, over the defaults when none are given: an island passes `features().rules` it was handed, or the object the app gave `createAuth`.
export function passwordProblem(password: string, rules: CredentialRules = DEFAULT_RULES): PasswordProblem | undefined {
  const { min, max, check } = resolveRules(rules).password

  if (password.length < min)
    return 'too-short'

  if (password.length > max)
    return 'too-long'

  const problem = check?.(password)

  return problem === '' ? undefined : problem
}

export function usernameProblem(username: string, rules: CredentialRules = DEFAULT_RULES): UsernameProblem | undefined {
  const name = normalizeUsername(username)
  const { min, max } = resolveRules(rules).username

  if (name.length < min || name.length > max)
    return 'length'

  if (!USERNAME.test(name))
    return 'characters'

  return mixesConfusableScripts(name) ? 'mixed-scripts' : undefined
}

// The longest a profile field of the account page holds unless it says otherwise.
export const PROFILE_MAX_LENGTH = 500
