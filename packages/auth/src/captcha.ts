import type { Limits } from './limits'
import type { RequestState } from './state'
import { spend } from './limits'

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const HCAPTCHA_URL = 'https://api.hcaptcha.com/siteverify'
const TIMEOUT_MS = 5000

// The requests a CAPTCHA can guard: each one a bot would repeat.
export type CaptchaAction = 'register' | 'sign-in' | 'reset' | 'magic-link'

export interface CaptchaOptions {
  // Checks the token the page's widget posted: `turnstile(secret)` and `hcaptcha(secret)` are presets, any function works.
  verify: (token: string, action: CaptchaAction) => boolean | Promise<boolean>
  // When each request asks for one: `'always'`, a number to ask only once this client made that many of it in its attempt window, or false. Every request asks always by default.
  on?: Partial<Record<CaptchaAction, 'always' | number | false>> | undefined
}

// Each request's client limit, whose attempt count a threshold reads.
const COUNTED: Record<CaptchaAction, { key: string, limit: keyof Limits }> = {
  'register': { key: 'register', limit: 'register' },
  'sign-in': { key: 'sign-in-client', limit: 'signIn' },
  'reset': { key: 'forgot', limit: 'forgot' },
  'magic-link': { key: 'magicLink', limit: 'magicLink' },
}

// Cloudflare Turnstile's server check; the widget posts its token as `cf-turnstile-response`.
export function turnstile(secret: string): CaptchaOptions['verify'] {
  return async token => siteverify(TURNSTILE_URL, secret, token)
}

// hCaptcha's server check; the widget posts its token as `h-captcha-response`.
export function hcaptcha(secret: string): CaptchaOptions['verify'] {
  return async token => siteverify(HCAPTCHA_URL, secret, token)
}

// Whether the next `action` from this client needs a CAPTCHA token, for the page to show the widget.
export async function captchaRequired(state: RequestState, action: CaptchaAction): Promise<boolean> {
  const rule = state.core.captcha && (state.core.captcha.on?.[action] ?? 'always')

  if (rule === undefined || rule === false)
    return false

  return rule === 'always' || await state.core.store.attempts.count(`${COUNTED[action].key}:${state.client}`) >= rule
}

// Spends one attempt of `action` against this client and answers what refuses it: `limited` past the limit, `captcha` without a token that checks out where one is needed.
export async function admit(state: RequestState, action: CaptchaAction, token: string | undefined): Promise<'limited' | 'captcha' | undefined> {
  const { core } = state
  // Read before the attempt counts, so a threshold of 3 lets three through without one.
  const required = await captchaRequired(state, action)
  const { key, limit } = COUNTED[action]

  if (await spend(core.store, `${key}:${state.client}`, core.limits[limit]))
    return 'limited'

  if (!required)
    return undefined

  // A widget that never loaded posts nothing, which is no reason to call the provider.
  if (!token)
    return 'captcha'

  try {
    return await core.captcha!.verify(token, action) ? undefined : 'captcha'
  }
  catch (error) {
    console.error(`kayjs-auth: checking a CAPTCHA for ${action} failed`, error)

    return 'captcha'
  }
}

async function siteverify(url: string, secret: string, token: string): Promise<boolean> {
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ secret, response: token }), signal: AbortSignal.timeout(TIMEOUT_MS) })

  if (!response.ok)
    throw new Error(`${url} answered ${response.status}`)

  return (await response.json() as { success?: unknown }).success === true
}
