import process from 'node:process'
import { kayLog } from '../runtime/log'
import { configuredSite } from '../runtime/site'
import { requestRecord } from './request-record'

// The first proxy's `X-Forwarded-Proto` saying the browser came over https.
const FORWARDED_HTTPS = /^\s*https\s*(?:,|$)/i

// A server tried on this machine, which may well run over plain http.
export const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/
let warnedScheme = false

// The request's URL, parsed once however many of kay's routes, hooks and scopes read it; shared, so never changed.
export function requestUrl(request: Request): URL {
  const record = requestRecord(request)

  return record.url ??= new URL(request.url)
}

// Over https, kay's cookies never travel in clear; behind a proxy, `X-Forwarded-Proto` says how the browser came, and without one, in production, an https `site` in kay.config.ts stands in, for a proxy that does not pass it on.
export function overHttps(request: Request): boolean {
  if (requestUrl(request).protocol === 'https:')
    return true

  const forwarded = request.headers.get('x-forwarded-proto')

  if (forwarded !== null)
    return FORWARDED_HTTPS.test(forwarded)

  if (process.env.NODE_ENV !== 'production')
    return false

  const site = configuredSite()

  if (!site)
    warnUnknownScheme(request)

  return site?.origin.startsWith('https:') === true
}

function warnUnknownScheme(request: Request): void {
  if (warnedScheme || LOCAL_HOST.test(requestUrl(request).hostname))
    return

  warnedScheme = true
  kayLog('warn', 'a request came over http with no X-Forwarded-Proto and kay.config.ts sets no site, so kay\'s cookies go out without Secure and the session\'s without __Host-; behind a proxy, have it pass X-Forwarded-Proto, or set site to the https address')
}
