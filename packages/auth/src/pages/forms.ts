import type { MinTimeRefusal } from 'kay'
import type { Auth } from '../auth'
import type { CaptchaAction } from '../captcha'
import type { Proof } from '../twoFactor'
import type { AuthFeatures, ProfileProblem } from './index'
import { t } from 'elysia'
import { wording } from 'kay/words'
import { passkeyAssertion, passkeyAttestation } from '../payloads'
import { PROFILE_MAX_LENGTH } from '../rules'
import { ERRORS, FIELD_ERRORS, OAUTH_ERRORS } from './english'

// The codes the pages word, as the English table holds them: a code a flow answers with no message is a type error here.
export type FailureCode = keyof typeof ERRORS
export type OAuthFailureCode = keyof typeof OAUTH_ERRORS
type Fields = typeof FIELD_ERRORS
type Problem<Field extends keyof Fields> = keyof Fields[Field]

// A scope as the page shows it: the label the app words under `auth.scopes.<scope>` in its catalogs, else the scope itself.
export function scopeLabel(scope: string): string {
  return wording(`auth.scopes.${scope}`, scope)
}

// Stands for a `minTime` refusal's reason, which kay words before the request's locale is known: `refusal` puts it in the page's language.
const MIN_TIME = 'kauth-min-time:'
const PASSWORD_PROBLEMS: ReadonlySet<string> = new Set<Problem<'password'>>(['too-short', 'too-long', 'breached'])
const OAUTH_FAILURES: ReadonlySet<string> = new Set<OAuthFailureCode>(['oauth', 'cancelled', 'refused', 'taken', 'unavailable', 'signed-out', 'banned'])

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
  protect: { honeypot: 'website', minTime: { after: '2s', plain: true } },
  messages: { minTime: (reason: MinTimeRefusal) => MIN_TIME + reason },
} as const

// The current password, or a code for an account without one or a change asking for the second factor.
const proof = { password: t.Optional(password), code: t.Optional(code) }

// Whether the sign-in a form asks for lasts `remember.maxAge`: the box when the pages show one, else what `pages.remember` fixes, the same by every way of signing in.
export function remembered(features: Pick<AuthFeatures, 'pages'>, chosen: boolean | undefined): boolean {
  const mode = features.pages?.remember ?? 'checkbox'

  return mode === 'always' || (mode === 'checkbox' && chosen === true)
}

// What the sign-in and register pages share about the box: whether to show it, and the provider links carrying the choice a click without script leaves.
export function rememberOf(features: Pick<AuthFeatures, 'pages' | 'prefix'>, redirect: string, label: (provider: string) => string, providers: AuthFeatures['providers']) {
  const mode = features.pages?.remember ?? 'checkbox'

  return {
    askRemember: mode === 'checkbox',
    providerLinks: providers.map(provider => ({ name: provider.name, label: label(provider.label), href: `${features.prefix}/${provider.name}?redirect=${encodeURIComponent(redirect)}&remember=${mode === 'always' ? 1 : 0}` })),
  }
}

export const schemas = {
  signIn: t.Object({ identifier: email, password, remember, redirect, ...captcha }),
  magicLink: t.Object({ email, remember, redirect, ...captcha }),
  emailCode: t.Object({ code }),
  passkey: t.Object({ response: passkeyAssertion, redirect, remember }),
  registerPasskey: t.Object({ response: passkeyAttestation, name: t.Optional(t.String({ maxLength: 64 })) }),
  register: t.Object({ email, password, username: t.Optional(t.String({ maxLength: 128 })), remember, redirect, ...captcha }),
  twoFactor: t.Object({ code }),
  requestReset: t.Object({ email, redirect, ...captcha }),
  reset: t.Object({ token, password }),
  token: t.Object({ token }),
  verify: t.Object({ token, password: t.Optional(password) }),
  proof: t.Object(proof),
  // Whichever fields the app's profile has: `saveProfile` reads those it knows.
  profile: t.Object({}, { additionalProperties: true }),
  changePassword: t.Object({ ...proof, newPassword: password }),
  changeEmail: t.Object({ ...proof, email }),
  changeUsername: t.Object({ username: t.String({ maxLength: 128 }) }),
  enableTwoFactor: t.Object({ code, uri: t.String({ maxLength: 1024 }) }),
  id: t.Object({ id: t.String({ maxLength: 128 }) }),
  oauthClient: t.Object({ id: t.String({ maxLength: 2048 }) }),
  // The authorization request the consent page was shown for, which the answer is checked against again.
  oauthConsent: t.Object({ client_id: t.String({ maxLength: 2048 }), redirect_uri: t.String({ maxLength: 2048 }), code_challenge: t.String({ maxLength: 128 }), scope: t.String({ maxLength: 2048 }), state: t.String({ maxLength: 2048 }), resource: t.String({ maxLength: 2048 }), decision: t.Union([t.Literal('allow'), t.Literal('deny')]) }),
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
export function failure(error: FailureCode): string {
  return wording(`auth.errors.${error}`, ERRORS[error])
}

function captchaFailure(captcha: AuthFeatures['captcha'], error: string): FailureCode {
  if (captcha !== 'proof-of-work')
    return 'captcha'

  return error === 'captcha' ? 'captchaAgain' : 'captchaScript'
}

// What kay refused a post for before the action: a reason `guarded` worded as `MIN_TIME` followed by it.
function minTimeReason(refused: string): FailureCode | undefined {
  const reason = refused.slice(MIN_TIME.length)

  return reason === 'early' || reason === 'expired' ? reason : undefined
}

// What a page open to visitors shows for a refused post: what kay refused it for before the action, or its failure code, a refused proof of work worded by whether the browser ran it.
export function refusal(failed: { errors: Partial<Record<string, string>>, data?: { error?: FailureCode } | undefined } | undefined, captcha: AuthFeatures['captcha']): string | undefined {
  const error = failed?.data?.error

  if (error === undefined) {
    const refused = failed?.errors['']

    return refused?.startsWith(MIN_TIME) ? failure(minTimeReason(refused) ?? 'form') : refused
  }

  // A proof of work refused with a solution is a stale one, which the page now holds a fresh challenge for; a widget keeps its one message.
  return error === 'captcha' || error === 'captchaScript' ? failure(captchaFailure(captcha, error)) : failure(error)
}

// What a page shows under a field refused for `problem`, with the limits the app's rules hold it to. A password problem the app's own `check` returned that has no message of the page's shows as it is.
export function issue(...[field, problem, rules]: [field: 'email', problem: Problem<'email'>, rules?: undefined] | [field: 'password', problem: Problem<'password'> | (string & {}), rules: AuthFeatures['rules']] | [field: 'username', problem: Problem<'username'>, rules: AuthFeatures['rules']]): string {
  switch (field) {
    case 'email': return wording(`auth.fields.email.${problem}`, FIELD_ERRORS.email[problem])
    case 'password': return PASSWORD_PROBLEMS.has(problem) ? wording(`auth.fields.password.${problem as Problem<'password'>}`, FIELD_ERRORS.password[problem as Problem<'password'>], { min: rules.password.min, max: rules.password.max }) : problem
    case 'username': return wording(`auth.fields.username.${problem}`, FIELD_ERRORS.username[problem], { min: rules.username.min, max: rules.username.max })
  }
}

// What a page shows under a profile field the app asked for, `max` being the field's own limit when it set one.
export function profileIssue(problem: ProfileProblem, max?: number): string {
  return typeof problem === 'object' ? problem.message : wording(`auth.fields.profile.${problem}`, FIELD_ERRORS.profile[problem], { max: max ?? PROFILE_MAX_LENGTH })
}

// The message for the `?error=` a failed provider sign-in comes back with; undefined for none, or one kayjs-auth never sends.
export function oauthFailure(error: string | null): string | undefined {
  return error !== null && isOAuthFailure(error) ? wording(`auth.oauth.${error}`, OAUTH_ERRORS[error]) : undefined
}

function isOAuthFailure(error: string): error is OAuthFailureCode {
  return OAUTH_FAILURES.has(error)
}
