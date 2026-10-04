// The credential rules, stated once so a form and the server agree. Browser-safe: an island imports them from `@kaynooo/kay-auth/rules` to refuse before posting, and the server checks every one again.

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
export type PasswordProblem = 'too-short' | 'too-long'
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

export function passwordProblem(password: string): PasswordProblem | undefined {
  if (password.length < PASSWORD_MIN_LENGTH)
    return 'too-short'

  return password.length > PASSWORD_MAX_LENGTH ? 'too-long' : undefined
}

export function usernameProblem(username: string): UsernameProblem | undefined {
  const name = normalizeUsername(username)

  if (name.length < USERNAME_MIN_LENGTH || name.length > USERNAME_MAX_LENGTH)
    return 'length'

  if (!USERNAME.test(name))
    return 'characters'

  return mixesConfusableScripts(name) ? 'mixed-scripts' : undefined
}
