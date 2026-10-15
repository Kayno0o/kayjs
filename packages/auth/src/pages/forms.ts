import type { MinTimeRefusal } from 'kay'
import type { Auth } from '../auth'
import type { CaptchaAction } from '../captcha'
import type { Proof } from '../twoFactor'
import type { AuthFeatures } from './index'
import { t } from 'elysia'
import { t as message } from 'kay/i18n'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '../rules'

// Stands for a `minTime` refusal's reason, which kay words before the request's locale is known: `refusal` puts it in the page's language.
const MIN_TIME = 'kayjs-auth-min-time:'
const OAUTH_FAILURES = new Set(['oauth', 'cancelled', 'refused', 'taken', 'unavailable', 'signed-out', 'banned'])

// What the prebuilt pages' actions take. A field longer than kayjs-auth would ever accept is refused here rather than read.
const email = t.String({ maxLength: 254 })
const password = t.String({ maxLength: 1024 })
const code = t.String({ maxLength: 32 })
const token = t.String({ maxLength: 512 })
const redirect = t.Optional(t.String({ maxLength: 2048 }))
const remember = t.Optional(t.Boolean())

// The token a CAPTCHA widget posts, under its provider's name, or the solution to kay's proof of work.
const captcha = {
  'cf-turnstile-response': t.Optional(t.String({ maxLength: 4096 })),
  'h-captcha-response': t.Optional(t.String({ maxLength: 4096 })),
  'kayjs-captcha': t.Optional(t.String({ maxLength: 512 })),
}

// What kay checks of a post from the pages open to visitors without JavaScript, which sends no proof of work: a field bots fill in, and a least time to fill the form in.
export const guarded = {
  honeypot: 'website',
  minTime: { after: '2s', plain: true },
  messages: { minTime: (reason: MinTimeRefusal) => MIN_TIME + reason },
} as const

// The current password, or a code for an account without one or a change asking for the second factor.
const proof = { password: t.Optional(password), code: t.Optional(code) }

export const schemas = {
  signIn: t.Object({ identifier: email, password, remember, redirect, ...captcha }),
  magicLink: t.Object({ email, remember, redirect, ...captcha }),
  emailCode: t.Object({ code }),
  // A browser's answer to a passkey request, read by kayjs-auth, which checks every part of it.
  passkey: t.Object({ response: t.Unknown(), redirect, remember }),
  registerPasskey: t.Object({ response: t.Unknown(), name: t.Optional(t.String({ maxLength: 64 })) }),
  register: t.Object({ email, password, username: t.Optional(t.String({ maxLength: 128 })), remember, redirect, ...captcha }),
  twoFactor: t.Object({ code }),
  requestReset: t.Object({ email, ...captcha }),
  reset: t.Object({ token, password }),
  token: t.Object({ token }),
  verify: t.Object({ token, password: t.Optional(password) }),
  nothing: t.Object({}),
  proof: t.Object(proof),
  changePassword: t.Object({ ...proof, newPassword: password }),
  changeEmail: t.Object({ ...proof, email }),
  changeUsername: t.Object({ username: t.String({ maxLength: 128 }) }),
  enableTwoFactor: t.Object({ code, uri: t.String({ maxLength: 1024 }) }),
  id: t.Object({ id: t.String({ maxLength: 128 }) }),
  unlink: t.Object({ ...proof, provider: t.String({ maxLength: 64 }) }),
  removePasskey: t.Object({ ...proof, id: t.String({ maxLength: 512 }) }),
  renamePasskey: t.Object({ id: t.String({ maxLength: 512 }), name: t.String({ minLength: 1, maxLength: 64 }) }),
  createToken: t.Object({ ...proof, label: t.String({ maxLength: 100 }), scopes: t.Optional(t.Array(t.String({ maxLength: 100 }), { maxItems: 100 })), days: t.Optional(t.Integer({ minimum: 0, maximum: 3650 })) }),
}

export function captchaOf(input: { 'cf-turnstile-response'?: string | undefined, 'h-captcha-response'?: string | undefined, 'kayjs-captcha'?: string | undefined }): string | undefined {
  return input['cf-turnstile-response'] ?? input['h-captcha-response'] ?? input['kayjs-captcha']
}

// An action's failure code, `captchaScript` for a CAPTCHA refused with no token posted, as a browser without JavaScript sends none: `refusal` tells it apart from a stale solution.
export function refusedFor<Code extends string>(error: Code, input: Parameters<typeof captchaOf>[0]): Code | 'captchaScript' {
  return error === 'captcha' && (captchaOf(input) ?? '') === '' ? 'captchaScript' : error
}

// Whether the page shows its CAPTCHA for `action`, with the proof of work's challenge, reading the client's attempts once.
export async function captchaFor(auth: Pick<Auth, 'captchaRequired' | 'captchaChallenge'>, captcha: AuthFeatures['captcha'], action: CaptchaAction): Promise<{ shown: boolean, challenge: string | null }> {
  if (captcha !== 'proof-of-work')
    return { shown: captcha !== null && await auth.captchaRequired(action), challenge: null }

  const challenge = await auth.captchaChallenge(action)

  return { shown: challenge !== null, challenge }
}

export function proofOf(input: { password?: string | undefined, code?: string | undefined }): Proof {
  return { ...input.password !== undefined && { password: input.password }, ...input.code !== undefined && { code: input.code } }
}

// What a page shows for a failure code, in the request's language.
export function failure(error: string): string {
  return message(`auth.errors.${error}` as never)
}

// What a page open to visitors shows for a refused post: what kay refused it for before the action, or its failure code, a refused proof of work worded by whether the browser ran it.
export function refusal(failed: { errors: Partial<Record<string, string>>, data?: unknown } | undefined, captcha: AuthFeatures['captcha']): string | undefined {
  const error = (failed?.data as { error?: string } | undefined)?.error

  if (error === undefined) {
    const refused = failed?.errors['']

    return refused?.startsWith(MIN_TIME) ? failure(refused.slice(MIN_TIME.length)) : refused
  }

  // A proof of work refused with a solution is a stale one, which the page now holds a fresh challenge for; a widget keeps its one message.
  if (error === 'captcha' || error === 'captchaScript')
    return failure(captcha !== 'proof-of-work' ? 'captcha' : error === 'captcha' ? 'captchaAgain' : 'captchaScript')

  return failure(error)
}

// What a page shows under a field refused for `problem`, with the limits the rule holds it to.
export function issue(field: 'email' | 'password' | 'username', problem: string): string {
  const limits = field === 'password' ? { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH } : { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH }

  return message(`auth.fields.${field}.${problem}` as never, limits)
}

// The message for the `?error=` a failed provider sign-in comes back with; undefined for none, or one kayjs-auth never sends.
export function oauthFailure(error: string | null): string | undefined {
  return error !== null && OAUTH_FAILURES.has(error) ? message(`auth.oauth.${error}` as never) : undefined
}
