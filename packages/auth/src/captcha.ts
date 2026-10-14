import type { Duration, RateStore } from 'kay'
import type { Limits } from './limits'
import type { RequestState } from './state'
import { verifyWork, workChallenge } from 'kay/server'
import { spend } from './limits'
import { log } from './log'

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const HCAPTCHA_URL = 'https://api.hcaptcha.com/siteverify'
const TIMEOUT_MS = 5000
// Doubling the difficulty with each attempt past the threshold stops at 16 times.
const MOST_DOUBLINGS = 4

// The requests a CAPTCHA can guard: each one a bot would repeat.
export type CaptchaAction = 'register' | 'guest' | 'sign-in' | 'reset' | 'magic-link'

// When each request asks for one: `'always'`, a number to ask only once this client made that many of it in its attempt window, or false.
export type CaptchaRules = Partial<Record<CaptchaAction, 'always' | number | false>>

// A third party's check, or kay's proof of work: `proofOfWork()`, the default.
export type CaptchaOptions = CaptchaCheck | ProofOfWorkCaptcha

export interface CaptchaCheck {
  // Checks the token the page's widget posted: `turnstile(secret)` and `hcaptcha(secret)` are presets, any function works.
  verify: (token: string, action: CaptchaAction) => boolean | Promise<boolean>
  // Every request asks always by default, a guest sign-in as registering does.
  on?: CaptchaRules | undefined
  // The widget the prebuilt pages show where one is needed: `turnstileWidget(siteKey)` or `hcaptchaWidget(siteKey)`.
  widget?: CaptchaWidget | undefined
}

export interface ProofOfWorkOptions {
  // The highest number the browser may hash up to past the threshold, 100,000 by default, doubled with each attempt after up to 16 times.
  difficulty?: number | undefined
  // How long a challenge stays good, an hour by default.
  maxAge?: Duration | undefined
  // Where the solutions already used are kept, this process's memory by default: `sqliteRates(path)` from `kay/server` shares them between processes.
  store?: RateStore | undefined
  // Registering, resets and magic links ask always by default, a password sign-in from the third attempt, a guest sign-in never, as an app often makes one with no form.
  on?: CaptchaRules | undefined
}

export interface ProofOfWorkCaptcha {
  proofOfWork: { difficulty: number, maxAge: Duration, store: RateStore | undefined }
  on: CaptchaRules
}

// A provider's widget: its script, the element it fills, carrying the site key, and the field its token posts as.
export interface CaptchaWidget {
  script: string
  class: string
  siteKey: string
  field: 'cf-turnstile-response' | 'h-captcha-response'
}

// Each request's client limit, whose attempt count a threshold reads.
const COUNTED: Record<CaptchaAction, { key: string, limit: keyof Limits }> = {
  'register': { key: 'register', limit: 'register' },
  'guest': { key: 'register', limit: 'register' },
  'sign-in': { key: 'sign-in-client', limit: 'signIn' },
  'reset': { key: 'forgot', limit: 'forgot' },
  'magic-link': { key: 'magicLink', limit: 'magicLink' },
}

// A challenge kay's script solves in the browser, with no third party, no widget and no cookie: it costs a bot CPU per request rather than proving a human.
export function proofOfWork(options: ProofOfWorkOptions = {}): ProofOfWorkCaptcha {
  return {
    proofOfWork: { difficulty: options.difficulty ?? 100_000, maxAge: options.maxAge ?? '1h', store: options.store },
    on: { 'register': 'always', 'guest': false, 'reset': 'always', 'magic-link': 'always', 'sign-in': 3, ...options.on },
  }
}

// Cloudflare Turnstile's server check; the widget posts its token as `cf-turnstile-response`.
export function turnstile(secret: string): CaptchaCheck['verify'] {
  return async token => siteverify(TURNSTILE_URL, secret, token)
}

export function turnstileWidget(siteKey: string): CaptchaWidget {
  return { script: 'https://challenges.cloudflare.com/turnstile/v0/api.js', class: 'cf-turnstile', siteKey, field: 'cf-turnstile-response' }
}

// hCaptcha's server check; the widget posts its token as `h-captcha-response`.
export function hcaptcha(secret: string): CaptchaCheck['verify'] {
  return async token => siteverify(HCAPTCHA_URL, secret, token)
}

export function hcaptchaWidget(siteKey: string): CaptchaWidget {
  return { script: 'https://js.hcaptcha.com/1/api.js', class: 'h-captcha', siteKey, field: 'h-captcha-response' }
}

// How many attempts past its threshold this client's next `action` comes, undefined when it needs no CAPTCHA.
async function pastThreshold(state: RequestState, action: CaptchaAction): Promise<number | undefined> {
  const on = state.core.captcha?.on
  const rule = state.core.captcha && (on?.[action] ?? (action === 'guest' ? on?.register : undefined) ?? 'always')

  if (rule === undefined || rule === false)
    return undefined

  const count = await state.core.store.attempts.count(`${COUNTED[action].key}:${state.client}`)
  const threshold = rule === 'always' ? 0 : rule

  return count >= threshold ? count - threshold : undefined
}

// Whether the next `action` from this client needs a CAPTCHA token, for the page to show the widget.
export async function captchaRequired(state: RequestState, action: CaptchaAction): Promise<boolean> {
  return await pastThreshold(state, action) !== undefined
}

function workScope(action: CaptchaAction): string {
  return `kayjs-auth:${action}`
}

function workDifficulty(captcha: ProofOfWorkCaptcha, past: number): number {
  return captcha.proofOfWork.difficulty * 2 ** Math.min(past, MOST_DOUBLINGS)
}

// The proof-of-work challenge for this client's next `action`, its field posting the solution as the token; null when none is needed or the CAPTCHA is a third party's.
export async function captchaChallenge(state: RequestState, action: CaptchaAction): Promise<string | null> {
  const { captcha } = state.core

  if (!captcha || !('proofOfWork' in captcha))
    return null

  const past = await pastThreshold(state, action)

  return past === undefined ? null : workChallenge(workScope(action), { difficulty: workDifficulty(captcha, past), maxAge: captcha.proofOfWork.maxAge })
}

// Spends one attempt of `action` against this client and answers what refuses it: `limited` past the limit, `captcha` without a token that checks out where one is needed.
export async function admit(state: RequestState, action: CaptchaAction, token: string | undefined): Promise<'limited' | 'captcha' | undefined> {
  const { core } = state
  // Read before the attempt counts, so a threshold of 3 lets three through without one.
  const past = await pastThreshold(state, action)
  const { key, limit } = COUNTED[action]

  if (await spend(core.store, `${key}:${state.client}`, core.limits[limit]))
    return 'limited'

  if (past === undefined)
    return undefined

  const captcha = core.captcha!

  // A solution to a challenge easier than this attempt asks for is refused, the page then signing a harder one.
  if ('proofOfWork' in captcha)
    return await verifyWork(token, workScope(action), { difficulty: workDifficulty(captcha, past), store: captcha.proofOfWork.store }) === undefined ? undefined : 'captcha'

  // A widget that never loaded posts nothing, which is no reason to call the provider.
  if (!token)
    return 'captcha'

  try {
    return await captcha.verify(token, action) ? undefined : 'captcha'
  }
  catch (error) {
    log.error(`checking a CAPTCHA for ${action} failed`, error)

    return 'captcha'
  }
}

async function siteverify(url: string, secret: string, token: string): Promise<boolean> {
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ secret, response: token }), signal: AbortSignal.timeout(TIMEOUT_MS) })

  if (!response.ok)
    throw new Error(`${url} answered ${response.status}`)

  return (await response.json() as { success?: unknown }).success === true
}
