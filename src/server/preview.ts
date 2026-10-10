import type { CookieMap } from 'bun'
import type { Elysia } from 'elysia'
import type { PreviewConfig } from '../config'
import type { Duration } from '../runtime/duration'
import type { PreviewState } from '../runtime/preview'
import { AsyncLocalStorage } from 'node:async_hooks'
import { durationSeconds } from '../runtime/duration'
import { setPreviewScope } from '../runtime/preview'
import { overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { useStampSecret } from './stamp'

// Where a preview link enters preview mode, or `?exit` leaves it.
export const PREVIEW_ROUTE = '/_kay/preview'
export const PREVIEW_COOKIE = 'kay_preview'
const DEFAULT_MAX_AGE = 3600
const DEFAULT_LINK_TTL = 3600
const MIN_SECRET_LENGTH = 32
// A path of the site, never `//host` nor `/\host`, which a browser reads as another site.
const SITE_PATH = /^\/(?![/\\])\S*$/
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

interface PreviewSettings {
  secret: string
  maxAge: number
  base: string
}

let settings: PreviewSettings | undefined
const store = new AsyncLocalStorage<PreviewState>()

setPreviewScope(() => store.getStore())

// `preview` from kay.config.ts, checked as the server boots; without it no request is ever in preview mode.
export function setupPreview(config: PreviewConfig | undefined, base: string): void {
  if (!config) {
    settings = undefined

    return
  }

  if (typeof config.secret !== 'string' || config.secret.length < MIN_SECRET_LENGTH)
    throw new Error(`kay: preview.secret in kay.config.ts is ${typeof config.secret === 'string' ? `${config.secret.length} characters long` : 'missing'}: it signs preview links and cookies, so it is at least ${MIN_SECRET_LENGTH} random characters, read from the environment`)

  useStampSecret(config.secret, 'preview')
  settings = { secret: config.secret, maxAge: durationSeconds(config.maxAge ?? DEFAULT_MAX_AGE, 'preview.maxAge'), base }
}

// Renders for a visitor in preview mode.
export function inPreview<T>(run: () => T): T {
  return store.run({ loads: new Map() }, run)
}

// Whether the request carries a preview cookie this site signed, not expired yet.
export function previewRequested(request: Request): boolean {
  if (!settings)
    return false

  const value = new Bun.CookieMap(request.headers.get('cookie') ?? '').get(PREVIEW_COOKIE)
  const dot = value?.indexOf('.') ?? -1

  if (value === null || value === '' || dot === -1)
    return false

  const until = value.slice(0, dot)

  return Number(until) > Date.now() / 1000 && sameText(value.slice(dot + 1), sign(settings, `cookie\n${until}`))
}

// Puts the visitor in preview mode for `preview.maxAge`, from a guard, a page or an action whose `ctx` carries cookies, such as one letting a signed-in editor in.
export function enterPreview(ctx: { cookies: CookieMap, request: Request }): void {
  const current = settingsFor('enterPreview()')
  const until = Math.floor(Date.now() / 1000) + current.maxAge

  ctx.cookies.set(PREVIEW_COOKIE, `${until}.${sign(current, `cookie\n${until}`)}`, { httpOnly: true, sameSite: 'lax', secure: overHttps(ctx.request), path: current.base || '/', maxAge: current.maxAge })
}

export function exitPreview(ctx: { cookies: CookieMap }): void {
  ctx.cookies.delete({ name: PREVIEW_COOKIE, path: settingsFor('exitPreview()').base || '/' })
}

// A link that puts whoever follows it in preview mode and opens `path`, a path of the site written without the base, until `ttl` runs out, an hour by default.
export function previewUrl(path: string, options: { ttl?: Duration } = {}): string {
  const current = settingsFor('previewUrl()')

  if (!SITE_PATH.test(path))
    throw new Error(`kay: previewUrl() was given ${path}, which is no path of the site such as /blog/draft`)

  const until = Math.floor(Date.now() / 1000) + durationSeconds(options.ttl ?? DEFAULT_LINK_TTL, 'previewUrl()\'s ttl')

  return `${current.base}${PREVIEW_ROUTE}?${new URLSearchParams({ path, until: String(until), sig: sign(current, `link\n${path}\n${until}`) })}`
}

// `/_kay/preview?path=/blog/draft&secret=...`, the link a CMS opens, or a link `previewUrl` signed, sets the preview cookie and goes to the path; `?exit&path=...` clears it.
export function servePreview(app: Elysia): void {
  app.get(PREVIEW_ROUTE, ({ request }) => {
    const current = settings!
    const query = new URL(request.url).searchParams
    const path = query.get('path') ?? '/'

    if (!SITE_PATH.test(path))
      return new Response('The path is no path of the site', { status: 400, headers: TEXT })

    const cookies = new Bun.CookieMap()

    if (query.has('exit'))
      exitPreview({ cookies })
    else if (validSecret(current, query.get('secret')) || validLink(current, path, query.get('until'), query.get('sig')))
      enterPreview({ cookies, request })
    else
      return new Response('Not a valid preview link', { status: 403, headers: TEXT })

    const headers = new Headers({ 'location': `${current.base}${path}`, 'cache-control': 'no-store' })

    for (const cookie of cookies.toSetCookieHeaders())
      headers.append('set-cookie', cookie)

    return new Response(null, { status: 307, headers })
  })
}

function validSecret(current: PreviewSettings, given: string | null): boolean {
  return given !== null && sameText(given, current.secret)
}

function validLink(current: PreviewSettings, path: string, until: string | null, sig: string | null): boolean {
  return until !== null && sig !== null && Number(until) > Date.now() / 1000 && sameText(sig, sign(current, `link\n${path}\n${until}`))
}

function settingsFor(caller: string): PreviewSettings {
  if (!settings)
    throw new Error(`kay: ${caller} needs preview in kay.config.ts, whose secret signs what it gives`)

  return settings
}

function sign(current: PreviewSettings, text: string): string {
  return nodeCrypto().createHmac('sha256', current.secret).update(text).digest('base64url')
}

function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && nodeCrypto().timingSafeEqual(a, b)
}
