import type { EmailProblem, PasswordProblem, UsernameProblem } from '@kaynooo/kayjs-auth'

// kayjs-auth answers codes, never messages: the app words them in its own language.
export const EMAIL_WORDS: Record<EmailProblem | 'taken' | 'unchanged', string> = {
  invalid: 'Write an address such as ada@example.com',
  taken: 'An account already has this address',
  unchanged: 'This is your address already',
}

export const PASSWORD_WORDS: Record<PasswordProblem | 'breached', string> = {
  'too-short': 'Write at least 10 characters',
  'too-long': 'Write at most 128 characters',
  'breached': 'This password appears in known data breaches; choose another',
}

export const USERNAME_WORDS: Record<UsernameProblem | 'taken', string> = {
  'length': 'Write 2 to 32 characters',
  'characters': 'Use letters and digits, with spaces, dots, hyphens or underscores between them',
  'mixed-scripts': 'Write it in one alphabet',
  'taken': 'Someone already goes by this name',
}

// What a sign-in, a mailed link or a change refused for, keyed by the code kayjs-auth gives.
export const FAILURE_WORDS: Record<string, string> = {
  invalid: 'Wrong name, address or password',
  limited: 'Too many tries; wait a few minutes',
  unverified: 'Confirm your address first, from the mail we sent',
  unavailable: 'Mail cannot be sent right now',
  proof: 'Wrong password',
  stale: 'Sign in again first',
  captcha: 'This form runs a check in your browser, which needs JavaScript: turn it on, then send it again',
}
