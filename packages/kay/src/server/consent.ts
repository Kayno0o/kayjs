// CNIL/RGPD one-declaration consent: cookie parsing/serialization, RequestConsent view, and zero-JS POST /_kay/consent endpoint.

import type { PluginRouteOptions } from '../plugins/types'
import type { RequestContext } from './http'
import type { TrustProxy } from './security'
import { wantsJson } from './http'
import { isTrustedOrigin } from './security'

export const DEFAULT_CONSENT_COOKIE = 'kay_consent'
/** 180 days in seconds (CNIL 6-month guideline for consent retention). */
export const DEFAULT_CONSENT_MAX_AGE = 15_552_000
export const DEFAULT_CONSENT_ENDPOINT = '/_kay/consent'
const COOKIE_VERSION_PREFIX = 'v1:'

export interface ConsentConfig {
  /** Non-essential consent categories (e.g. `['analytics', 'media']` or `{ analytics: 'Audience measurement' }`). */
  categories: readonly string[] | Readonly<Record<string, string>>
  /** Cookie name storing consent choices (default: `'kay_consent'`). */
  cookieName?: string | undefined
  /** Max-Age in seconds (default: `15552000` = 180 days, CNIL 6-month guideline). */
  maxAge?: number | undefined
  /** POST endpoint path handling consent form submissions (default: `'/_kay/consent'`). */
  endpoint?: string | undefined
}

export interface RequestConsent {
  readonly decided: boolean
  readonly categories: readonly string[]
  has(category: string): boolean
  all(): Record<string, boolean>
}

export interface NormalizedConsentConfig {
  readonly categories: readonly string[]
  readonly categorySet: ReadonlySet<string>
  readonly cookieName: string
  readonly maxAge: number
  readonly endpoint: string
}

const EMPTY_CONSENT: RequestConsent = {
  decided: false,
  categories: [],
  has: category => category === 'essential',
  all: () => ({}),
}

export function normalizeConsentConfig(config: ConsentConfig | undefined): NormalizedConsentConfig | undefined {
  if (config === undefined)
    return undefined
  const rawList = Array.isArray(config.categories) ? config.categories : Object.keys(config.categories)
  const categories: string[] = []
  const categorySet = new Set<string>()
  for (const item of rawList) {
    const name = item.trim()
    if (name === '' || name === 'essential' || categorySet.has(name))
      continue
    if (name.includes(',') || name.includes(':'))
      throw new Error(`kay: consent category "${name}" cannot contain "," or ":"`)
    categorySet.add(name)
    categories.push(name)
  }
  const rawEndpoint = (config.endpoint ?? DEFAULT_CONSENT_ENDPOINT).trim()
  const endpoint = rawEndpoint.startsWith('/') ? rawEndpoint : `/${rawEndpoint}`
  return {
    categories,
    categorySet,
    cookieName: config.cookieName ?? DEFAULT_CONSENT_COOKIE,
    maxAge: config.maxAge ?? DEFAULT_CONSENT_MAX_AGE,
    endpoint,
  }
}

export function parseConsentCookie(raw: string | undefined, declared: ReadonlySet<string>): { decided: boolean, granted: Set<string> } {
  const granted = new Set<string>()
  if (raw === undefined || !raw.startsWith(COOKIE_VERSION_PREFIX))
    return { decided: false, granted }
  const payload = raw.slice(COOKIE_VERSION_PREFIX.length)
  if (payload !== '') {
    for (const part of payload.split(',')) {
      const cat = part.trim()
      if (declared.has(cat))
        granted.add(cat)
    }
  }
  return { decided: true, granted }
}

export function serializeConsentCookie(granted: ReadonlySet<string>, declared: readonly string[]): string {
  const ordered: string[] = []
  for (const cat of declared) {
    if (granted.has(cat))
      ordered.push(cat)
  }
  return `${COOKIE_VERSION_PREFIX}${ordered.join(',')}`
}

export function createRequestConsent(rawCookie: string | undefined, config: NormalizedConsentConfig | undefined): RequestConsent {
  if (config === undefined)
    return EMPTY_CONSENT
  const { decided, granted } = parseConsentCookie(rawCookie, config.categorySet)
  return {
    decided,
    categories: config.categories,
    has(category: string): boolean {
      return category === 'essential' || granted.has(category)
    },
    all(): Record<string, boolean> {
      const out: Record<string, boolean> = {}
      for (const cat of config.categories)
        out[cat] = granted.has(cat)
      return out
    },
  }
}

function isTruthyFormValue(value: FormDataEntryValue | null): boolean {
  if (typeof value !== 'string')
    return false
  const norm = value.trim().toLowerCase()
  return norm !== '' && norm !== 'false' && norm !== '0' && norm !== 'off' && norm !== 'no'
}

function isSafeRelativeRedirect(target: string): boolean {
  return target.startsWith('/') && !target.startsWith('//') && !target.includes('\r') && !target.includes('\n')
}

function resolveConsentRedirect(
  request: Request,
  url: URL,
  formRedirect: string | undefined,
  trustedOrigins: ReadonlySet<string> | undefined,
  trustProxy: TrustProxy,
): string {
  if (formRedirect !== undefined && isSafeRelativeRedirect(formRedirect))
    return formRedirect
  const referer = request.headers.get('referer')
  if (referer !== null) {
    try {
      const refUrl = new URL(referer)
      if (isTrustedOrigin(refUrl.origin, request, trustedOrigins, trustProxy, url))
        return `${refUrl.pathname}${refUrl.search}`
    }
    catch {
      return '/'
    }
  }
  return '/'
}

async function parseConsentSubmission(
  request: Request,
  config: NormalizedConsentConfig,
): Promise<{ ok: true, granted: Set<string>, redirect?: string | undefined } | { ok: false, error: string }> {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase()
  const granted = new Set<string>()

  if (ct.includes('application/json')) {
    let body: unknown
    try {
      body = await request.json()
    }
    catch {
      return { ok: false, error: 'Invalid JSON body' }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      return { ok: false, error: 'Consent payload must be a JSON object' }
    const obj = body as Record<string, unknown>
    if (obj.acceptAll === true || obj.action === 'accept-all') {
      for (const cat of config.categories)
        granted.add(cat)
      return { ok: true, granted }
    }
    if (obj.rejectAll === true || obj.action === 'reject-all')
      return { ok: true, granted }
    if (Array.isArray(obj.categories)) {
      for (const item of obj.categories) {
        if (typeof item === 'string' && config.categorySet.has(item))
          granted.add(item)
      }
      return { ok: true, granted }
    }
    if (obj.categories !== null && typeof obj.categories === 'object') {
      for (const [cat, enabled] of Object.entries(obj.categories as Record<string, unknown>)) {
        if (config.categorySet.has(cat) && enabled === true)
          granted.add(cat)
      }
      return { ok: true, granted }
    }
    return { ok: true, granted }
  }

  let form: FormData
  try {
    form = await request.formData()
  }
  catch {
    return { ok: false, error: 'Invalid form submission' }
  }
  const rawRedirect = form.get('redirect')
  const redirect = typeof rawRedirect === 'string' ? rawRedirect : undefined
  const action = form.get('action')
  if (action === 'accept-all') {
    for (const cat of config.categories)
      granted.add(cat)
    return { ok: true, granted, redirect }
  }
  if (action === 'reject-all')
    return { ok: true, granted, redirect }

  const listed = new Set(form.getAll('categories').filter((v): v is string => typeof v === 'string'))
  for (const cat of config.categories) {
    if (listed.has(cat) || isTruthyFormValue(form.get(cat)))
      granted.add(cat)
  }
  return { ok: true, granted, redirect }
}

export type ConsentRouteRegistrar = (
  method: string,
  path: string,
  handler: (ctx: RequestContext) => Response | Promise<Response>,
  options?: PluginRouteOptions,
) => void

/** Registers the automatic CSRF-protected `POST /_kay/consent` endpoint when `consent` is configured. */
export function registerConsentRoute(
  register: ConsentRouteRegistrar,
  config: NormalizedConsentConfig,
  trustedOrigins: ReadonlySet<string> | undefined,
  trustProxy: TrustProxy,
): void {
  register('POST', config.endpoint, async (ctx) => {
    const parsed = await parseConsentSubmission(ctx.request, config)
    if (!parsed.ok)
      return ctx.deny(400, parsed.error)

    const cookieVal = serializeConsentCookie(parsed.granted, config.categories)
    ctx.cookies.set(config.cookieName, cookieVal, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: config.maxAge,
      category: 'essential',
    })

    if (wantsJson(ctx.request)) {
      const consent: Record<string, boolean> = {}
      for (const cat of config.categories)
        consent[cat] = parsed.granted.has(cat)
      return ctx.json({ ok: true, decided: true, consent })
    }
    const target = resolveConsentRedirect(ctx.request, ctx.url, parsed.redirect, trustedOrigins, trustProxy)
    return ctx.redirect(target, 303)
  }, { csrf: true })
}
