// The credential rules, stated once so a form and the server agree. Browser-safe: an island imports them from `@kaynooo/kayjs-auth/rules` to refuse before posting, and the server checks every one again.

import { isEmail } from 'kay'

export const PASSWORD_MIN_LENGTH = 10
// Argon2id has no ceiling of its own, and an unbounded field is free CPU for whoever posts it.
export const PASSWORD_MAX_LENGTH = 128
export const USERNAME_MIN_LENGTH = 2
export const USERNAME_MAX_LENGTH = 32

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

  return isEmail(normalized) && !mixesConfusableScripts(normalized.slice(0, normalized.lastIndexOf('@'))) ? undefined : 'invalid'
}

// What an app sets over the defaults, in the `rules` option of `authCore`, and the same object an island passes to `passwordProblem` and `usernameProblem`.
export interface CredentialRules {
  password?: {
    // 10 by default.
    min?: number | undefined
    // 128 by default: Argon2id has no ceiling of its own.
    max?: number | undefined
    // An extra rule on top of the length ones, returning a problem code or a message for what it refuses, such as `p => /\d/.test(p) ? undefined : 'Add a digit.'`. The prebuilt pages show what it returns as it is.
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

// The rules with the defaults filled in, no range checked: `resolveRules` of the server refuses one that no value fits.
function filled(rules: CredentialRules): ResolvedRules {
  return { password: { min: rules.password?.min ?? PASSWORD_MIN_LENGTH, max: rules.password?.max ?? PASSWORD_MAX_LENGTH, check: rules.password?.check }, username: { min: rules.username?.min ?? USERNAME_MIN_LENGTH, max: rules.username?.max ?? USERNAME_MAX_LENGTH } }
}

// An already resolved set, such as the core's, is used as it is.
function resolved(rules: CredentialRules): ResolvedRules {
  return rules === DEFAULT_RULES || (typeof rules.password?.min === 'number' && typeof rules.password.max === 'number' && typeof rules.username?.min === 'number' && typeof rules.username.max === 'number') ? rules as ResolvedRules : filled(rules)
}

// The rules an app set, over the defaults when none are given: an island passes `features().rules` it was handed, or the object the app gave `authCore`.
export function passwordProblem(password: string, rules: CredentialRules = DEFAULT_RULES): PasswordProblem | undefined {
  const { min, max, check } = resolved(rules).password

  if (password.length < min)
    return 'too-short'

  if (password.length > max)
    return 'too-long'

  const problem = check?.(password)

  return problem === '' ? undefined : problem
}

export function usernameProblem(username: string, rules: CredentialRules = DEFAULT_RULES): UsernameProblem | undefined {
  const name = normalizeUsername(username)
  const { min, max } = resolved(rules).username

  if (name.length < min || name.length > max)
    return 'length'

  if (!USERNAME.test(name))
    return 'characters'

  return mixesConfusableScripts(name) ? 'mixed-scripts' : undefined
}

// The longest a profile field of the account page holds unless it says otherwise.
export const PROFILE_MAX_LENGTH = 500
