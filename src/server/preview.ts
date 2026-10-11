import type { CookieMap } from 'bun'
import type { Elysia } from 'elysia'
import type { PreviewConfig } from '../config'
import type { Duration } from '../runtime/duration'
import type { PreviewMode, PreviewState } from '../runtime/preview'
import { AsyncLocalStorage } from 'node:async_hooks'
import { durationSeconds } from '../runtime/duration'
import { setPreviewScope } from '../runtime/preview'
import { overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { useStampSecret } from './stamp'

// Where a preview link enters preview mode, or `?exit` leaves it.
export const PREVIEW_ROUTE = '/_kay/preview'
export const PREVIEW_COOKIE = 'kay_preview'
const EDIT = 'edit'
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

// Renders for a visitor in preview mode, in edit mode too when `edit` is set.
export function inPreview<T>(run: () => T, edit = false): T {
  return store.run({ loads: new Map(), edit }, run)
}

// The mode the request's preview cookie, signed by this site and not expired yet, puts it in: `until.sig`, or `until.edit.sig` for edit mode.
export function previewRequested(request: Request): PreviewMode | undefined {
  if (!settings)
    return undefined

  const [until, ...rest] = new Bun.CookieMap(request.headers.get('cookie') ?? '').get(PREVIEW_COOKIE)?.split('.') ?? []
  const edit = rest.length === 2 && rest[0] === EDIT
  const sig = rest.at(-1)

  if (until === undefined || sig === undefined || (rest.length !== 1 && !edit) || !(Number(until) > Date.now() / 1000))
    return undefined

  return sameText(sig, sign(settings, cookieText(until, edit))) ? edit ? 'edit' : 'preview' : undefined
}

// Whether the request is in edit mode, for a CMS's API module or guard to let in the editor alone outside a page's render, where `editing()` tells.
export function editRequested(request: Request): boolean {
  return previewRequested(request) === 'edit'
}

// Puts the visitor in preview mode for `preview.maxAge`, from a guard, a page or an action whose `ctx` carries cookies, such as one letting a signed-in editor in; `edit` puts them in edit mode as well.
export function enterPreview(ctx: { cookies: CookieMap, request: Request }, options: { edit?: boolean } = {}): void {
  const current = settingsFor('enterPreview()')
  const until = String(Math.floor(Date.now() / 1000) + current.maxAge)
  const edit = options.edit === true

  ctx.cookies.set(PREVIEW_COOKIE, [until, ...edit ? [EDIT] : [], sign(current, cookieText(until, edit))].join('.'), { httpOnly: true, sameSite: 'lax', secure: overHttps(ctx.request), path: current.base || '/', maxAge: current.maxAge })
}

export function exitPreview(ctx: { cookies: CookieMap }): void {
  ctx.cookies.delete({ name: PREVIEW_COOKIE, path: settingsFor('exitPreview()').base || '/' })
}

// A link that puts whoever follows it in preview mode, edit mode too with `edit`, and opens `path`, a path of the site written without the base, until `ttl` runs out, an hour by default.
export function previewUrl(path: string, options: { ttl?: Duration, edit?: boolean } = {}): string {
  const current = settingsFor('previewUrl()')

  if (!SITE_PATH.test(path))
    throw new Error(`kay: previewUrl() was given ${path}, which is no path of the site such as /blog/draft`)

  const until = Math.floor(Date.now() / 1000) + durationSeconds(options.ttl ?? DEFAULT_LINK_TTL, 'previewUrl()\'s ttl')

  const edit = options.edit === true

  return `${current.base}${PREVIEW_ROUTE}?${new URLSearchParams({ path, until: String(until), ...edit && { edit: '' }, sig: sign(current, linkText(path, String(until), edit)) })}`
}

// `/_kay/preview?path=/blog/draft&secret=...`, the link a CMS opens, or a link `previewUrl` signed, sets the preview cookie and goes to the path, `&edit` in edit mode; `?exit&path=...` clears it.
export function servePreview(app: Elysia): void {
  app.get(PREVIEW_ROUTE, ({ request }) => {
    const current = settings!
    const query = new URL(request.url).searchParams
    const path = query.get('path') ?? '/'
    const edit = query.has('edit')

    if (!SITE_PATH.test(path))
      return new Response('The path is no path of the site', { status: 400, headers: TEXT })

    const cookies = new Bun.CookieMap()

    if (query.has('exit'))
      exitPreview({ cookies })
    else if (validSecret(current, query.get('secret')) || validLink(current, path, edit, query.get('until'), query.get('sig')))
      enterPreview({ cookies, request }, { edit })
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

function validLink(current: PreviewSettings, path: string, edit: boolean, until: string | null, sig: string | null): boolean {
  return until !== null && sig !== null && Number(until) > Date.now() / 1000 && sameText(sig, sign(current, linkText(path, until, edit)))
}

// What a cookie and a link sign: edit mode is signed apart, so a preview link cannot be turned into an edit one.
function cookieText(until: string, edit: boolean): string {
  return `cookie\n${until}${edit ? `\n${EDIT}` : ''}`
}

function linkText(path: string, until: string, edit: boolean): string {
  return `link\n${path}\n${until}${edit ? `\n${EDIT}` : ''}`
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
