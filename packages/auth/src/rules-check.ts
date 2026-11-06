import type { CredentialRules, ResolvedRules } from './rules'
import { configError } from 'kay/library'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from './rules'

// What the prebuilt pages' forms take at most, so a ceiling above never meets a refusal from the form first.
const FORM_PASSWORD_MAX = 1024
const FORM_USERNAME_MAX = 128

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined)
    return fallback

  if (!Number.isInteger(value) || value < 1)
    throw configError('auth', 'rules', `rules.${name} is ${value}, a whole number of at least 1`)

  return value
}

// The rules with the defaults filled in, refusing a range that no value fits.
export function resolveRules(rules: CredentialRules = {}): ResolvedRules {
  const password = { min: limit(rules.password?.min, PASSWORD_MIN_LENGTH, 'password.min'), max: limit(rules.password?.max, PASSWORD_MAX_LENGTH, 'password.max'), check: rules.password?.check }
  const username = { min: limit(rules.username?.min, USERNAME_MIN_LENGTH, 'username.min'), max: limit(rules.username?.max, USERNAME_MAX_LENGTH, 'username.max') }

  if (password.max > FORM_PASSWORD_MAX)
    throw configError('auth', 'rules', `rules.password.max is ${password.max}, over the ${FORM_PASSWORD_MAX} the prebuilt pages post`)

  if (username.max > FORM_USERNAME_MAX)
    throw configError('auth', 'rules', `rules.username.max is ${username.max}, over the ${FORM_USERNAME_MAX} the prebuilt pages post`)

  if (password.min > password.max)
    throw configError('auth', 'rules', `rules.password.min is ${password.min}, over rules.password.max ${password.max}`)

  if (username.min > username.max)
    throw configError('auth', 'rules', `rules.username.min is ${username.min}, over rules.username.max ${username.max}`)

  return { password, username }
}
